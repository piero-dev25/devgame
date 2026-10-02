// @effect-diagnostics nodeBuiltinImport:off
/**
 * importReview - what the import routes call. `review` is the dry run the user
 * looks at, `apply` imports only the plan they reviewed (same fingerprint)
 * with an explicit choice for every conflict, and `status` reads a project's
 * import back from its receipt on disk, so nothing depends on server memory.
 *
 * @module importReview
 */
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import {
  MrMakImportReceipt,
  type MrMakImportApplySuccess,
  type MrMakImportDestinationKind,
  type MrMakImportFileOrigin,
  type MrMakImportPlan,
  type MrMakImportPlanSummary,
  type MrMakImportReceiptSummary,
  type MrMakImportRoot,
  type MrMakImportStatusSuccess,
  type MrMakSkillConflictChoice,
} from "@t3tools/contracts";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ProcessRunner from "../processRunner.ts";
import {
  isPlainRelativePath,
  type ImportContentRequest,
  type ImportContentResult,
  type MrMakImportApplyError,
} from "./importContent.ts";
import type {
  ImportSkillsRequest,
  ImportSkillsResult,
  MrMakSkillImportError,
  SkillPreviewRequest,
} from "./importSkills.ts";
import type { MrMakImportPlanError, MrMakImportPlanRequest } from "./MrMakImport.ts";

const RECEIPT_PATH = ".devgame/import/receipt.json";
/** A new DevGame project's own files (NewProject.ts); anything else makes a destination `existing`. */
const STARTER_FILES = new Set([".git", ".DS_Store", "README.md", "assets", "assets/icon.svg"]);
/** Where DevGame's own workflows, context and skills live, for files the import did not place. */
const DEVGAME_LISTED_ROOTS = ["processes", "context", ".agents/skills", ".claude/skills"];
const SKILL_FILE = /^\.(?:agents|claude)\/skills\/([^/]+)\//;
const decodeReceipt = Schema.decodeUnknownOption(fromLenientJson(MrMakImportReceipt));

const sha256 = (bytes: string | Uint8Array) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

export class MrMakImportReviewError extends Schema.TaggedError<MrMakImportReviewError>()(
  "MrMakImportReviewError",
  {
    reason: Schema.Literals(["stale-plan", "existing-project", "unresolved-conflicts"]),
    paths: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "stale-plan":
        return "The source or destination changed since the dry run. Run it again and review the new plan.";
      case "existing-project":
        return "The destination is an existing project, not a new or comparison one. Confirm importing into it first.";
      case "unresolved-conflicts":
        return `Choose what to do with ${this.paths.join(", ")} before importing.`;
    }
  }
}

export interface ImportReviewRequest {
  readonly sourceRoot: string;
  readonly destinationRoot: string;
  readonly roots?: ReadonlyArray<MrMakImportRoot> | undefined;
}

export interface ApplyReviewedRequest extends ImportReviewRequest {
  readonly planId: string;
  readonly choices: ImportContentRequest["choices"];
  readonly skillChoices: ReadonlyArray<MrMakSkillConflictChoice>;
  readonly confirmExistingProject: boolean;
}

type ReviewError = MrMakImportPlanError | MrMakImportApplyError;

const summarizeReceipt = (receipt: MrMakImportReceipt): MrMakImportReceiptSummary => {
  const outcomes = {
    written: 0,
    identical: 0,
    updated: 0,
    replaced: 0,
    "kept-local": 0,
    conflict: 0,
  };
  for (const file of receipt.files) outcomes[file.outcome]++;
  const changes = { added: 0, modified: 0, removed: 0 };
  for (const change of receipt.changes) changes[change.change]++;
  return {
    importId: receipt.importId,
    previousImportId: receipt.previousImportId,
    source: receipt.source,
    completedAt: receipt.completedAt,
    outcomes,
    conflicts: receipt.conflicts,
    changes,
    exclusions: receipt.exclusions.length,
    transforms: receipt.transforms,
    skills: receipt.skills
      ? { skills: receipt.skills.skills, verified: receipt.skills.equivalence.verified }
      : null,
  };
};

export const makeImportReview = (deps: {
  readonly plan: (input: MrMakImportPlanRequest) => Effect.Effect<MrMakImportPlan, ReviewError>;
  readonly previewConflicts: (input: {
    readonly plan: MrMakImportPlan;
    readonly destinationRoot: string;
  }) => Effect.Effect<ReadonlyArray<{ path: string; reason: string }>, MrMakImportApplyError>;
  readonly previewSkills: (input: SkillPreviewRequest) => Effect.Effect<
    {
      readonly skills: ReadonlyArray<MrMakImportPlanSummary["skills"][number]>;
      readonly entries: MrMakImportPlan["entries"];
      /** Conflicting skill to the folder import-renamed would give it. */
      readonly renamed: Readonly<Record<string, string>>;
    },
    MrMakImportApplyError
  >;
  readonly importContent: (
    input: ImportContentRequest,
  ) => Effect.Effect<ImportContentResult, MrMakImportApplyError>;
  readonly importSkills: (
    input: ImportSkillsRequest,
  ) => Effect.Effect<ImportSkillsResult, MrMakSkillImportError | MrMakImportApplyError>;
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const processRunner = yield* ProcessRunner.ProcessRunner;

    const destinationKind = Effect.fn("importReview.destinationKind")(function* (root: string) {
      const hasReceipt = yield* fileSystem
        .exists(NodePath.join(root, RECEIPT_PATH))
        .pipe(Effect.orElseSucceed(() => false));
      if (hasReceipt) {
        return "comparison" as MrMakImportDestinationKind;
      }
      const names = yield* fileSystem
        .readDirectory(root, { recursive: false })
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      const assets = names.includes("assets")
        ? yield* fileSystem
            .readDirectory(NodePath.join(root, "assets"))
            .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => ["?"]))
        : [];
      const extra = [...names, ...assets.map((name) => `assets/${name}`)].filter(
        (name) => !STARTER_FILES.has(name),
      );
      return (extra.length === 0 ? "empty" : "existing") as MrMakImportDestinationKind;
    });

    const review = Effect.fn("MrMakImport.review")(function* (request: ImportReviewRequest) {
      const plan = yield* deps.plan(request);
      const destinationRoot = plan.destinationPath ?? request.destinationRoot;
      const kind = yield* destinationKind(destinationRoot);
      const preview = plan.entries.some((entry) => entry.root === ".agents/skills")
        ? yield* deps.previewSkills({ plan, destinationRoot })
        : { skills: [], entries: plan.entries, renamed: {} };
      // A conflicting skill's files are settled by its skill choice, not one by one.
      const conflictedSkills = new Set(
        preview.skills.filter((skill) => skill.conflict).map((skill) => skill.name),
      );
      // Its renamed folder's files are not: import-renamed would overwrite them.
      const renamedFrom = new Map(
        Object.entries(preview.renamed).map(([name, renamed]) => [renamed, name]),
      );
      const conflicts = (yield* deps.previewConflicts({
        plan: { ...plan, entries: preview.entries },
        destinationRoot,
      })).flatMap((conflict) => {
        const skill = SKILL_FILE.exec(conflict.path)?.[1];
        if (skill !== undefined && conflictedSkills.has(skill)) return [];
        const original = skill === undefined ? undefined : renamedFrom.get(skill);
        return original === undefined
          ? [conflict]
          : [{ ...conflict, reason: `If ${original} is imported as ${skill}: ${conflict.reason}` }];
      });
      const reviewed = {
        source: {
          path: plan.source.repositoryPath,
          revision: plan.source.revision,
          branch: plan.source.branch,
          dirtyPaths: plan.source.dirtyPaths,
        },
        destination: { path: destinationRoot, kind },
        roots: plan.roots,
        totals: plan.totals,
        conflicts: [...conflicts],
        skills: [...preview.skills],
        skillFiles: plan.skills,
        exclusions: plan.exclusions,
        requirements: plan.requirements,
        issues: plan.issues,
        excludedStores: plan.excludedStores,
      };
      // The working tree's dirty list is not imported, so it does not move the fingerprint.
      const planId = sha256(
        [
          plan.source.revision,
          kind,
          ...plan.roots.map((root) => `root\0${root}`),
          ...plan.entries.map(
            (entry) => `file\0${entry.destinationPath}\0${entry.sha256}\0${entry.destination}`,
          ),
          ...reviewed.conflicts.map((conflict) => `conflict\0${conflict.path}`),
          ...reviewed.skills.map((skill) => `skill\0${skill.name}\0${skill.conflict}`),
        ].join("\n"),
      ).slice(0, 16);
      return { plan, summary: { planId, ...reviewed } satisfies MrMakImportPlanSummary };
    });

    const apply = Effect.fn("MrMakImport.apply")(function* (request: ApplyReviewedRequest) {
      const { plan, summary } = yield* review(request);
      const fail = (reason: MrMakImportReviewError["reason"], paths: ReadonlyArray<string> = []) =>
        new MrMakImportReviewError({ reason, paths: [...paths] });
      if (summary.planId !== request.planId) return yield* fail("stale-plan");
      if (summary.destination.kind === "existing" && !request.confirmExistingProject) {
        return yield* fail("existing-project");
      }
      const choices = request.choices ?? {};
      const unresolved = [
        ...summary.conflicts.map((conflict) => conflict.path).filter((path) => !choices[path]),
        ...summary.skills
          .filter((skill) => skill.conflict)
          .filter((skill) => !request.skillChoices.some((choice) => choice.skill === skill.name))
          .map((skill) => `skill ${skill.name}`),
      ];
      if (unresolved.length > 0) return yield* fail("unresolved-conflicts", unresolved);
      const destinationRoot = summary.destination.path;
      const result =
        summary.skills.length > 0
          ? yield* deps.importSkills({
              plan,
              destinationRoot,
              choices,
              skillChoices: request.skillChoices,
            })
          : yield* deps.importContent({ plan, destinationRoot, choices });
      return {
        status: result.status,
        receiptPath: NodePath.relative(destinationRoot, result.receiptPath)
          .split(NodePath.sep)
          .join("/"),
        commit: result.commit,
        receipt: summarizeReceipt(result.receipt),
      } satisfies MrMakImportApplySuccess;
    });

    /**
     * sha256 of what sits at a receipt path: a regular file's bytes (streamed)
     * or a symlink's own link text; null for anything else or nothing. The
     * receipt is read from disk, so the walk never passes through a symlink or
     * a non-directory: nothing outside `root`, and no FIFO or device, is opened.
     */
    const hashPlaced = (root: string, relativePath: string) =>
      Effect.gen(function* () {
        const segments = relativePath.split("/");
        let current = root;
        for (const [index, segment] of segments.entries()) {
          current = NodePath.join(current, segment);
          const last = index === segments.length - 1;
          const link = yield* fileSystem.readLink(current).pipe(Effect.option);
          if (Option.isSome(link)) return last ? sha256(link.value) : null;
          const info = yield* fileSystem.stat(current);
          if (!last) {
            if (info.type !== "Directory") return null;
            continue;
          }
          if (info.type !== "File") return null;
          const digest = yield* fileSystem.stream(current).pipe(
            Stream.runFold(
              () => NodeCrypto.createHash("sha256"),
              (hash, chunk: Uint8Array) => hash.update(chunk),
            ),
          );
          return digest.digest("hex");
        }
        return null;
      }).pipe(Effect.orElseSucceed((): string | null => null));

    const status = Effect.fn("MrMakImport.status")(function* (input: {
      readonly destinationRoot: string;
    }) {
      const none: MrMakImportStatusSuccess = { import: null };
      const root = Option.getOrNull(
        yield* fileSystem.realPath(input.destinationRoot).pipe(Effect.option),
      );
      if (root === null) return none;
      const receipt = yield* fileSystem
        .readFileString(NodePath.join(root, RECEIPT_PATH))
        .pipe(Effect.map(decodeReceipt), Effect.orElseSucceed(Option.none));
      if (Option.isNone(receipt)) return none;
      // Only paths an import can write are looked at; the receipt is data from disk.
      const placed = yield* Effect.forEach(
        receipt.value.files.filter((file) => isPlainRelativePath(file.path)),
        (file) =>
          hashPlaced(root, file.path).pipe(
            Effect.map((current) => {
              const origin: MrMakImportFileOrigin =
                current === null
                  ? "removed"
                  : current === file.destinationSha256
                    ? "original"
                    : "adapted";
              return { path: file.path, origin };
            }),
          ),
        { concurrency: 8 },
      );
      // Honours the destination's .gitignore; no listing (not a repository) lists nothing extra.
      const listing = yield* processRunner
        .run({
          command: "git",
          args: [
            "-c",
            "core.quotePath=false",
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
            "--",
            ...DEVGAME_LISTED_ROOTS,
          ],
          cwd: root,
          env: { GIT_OPTIONAL_LOCKS: "0" },
          maxOutputBytes: 4 * 1024 * 1024,
          outputMode: "truncate",
          timeout: "30 seconds",
        })
        .pipe(
          Effect.map((result) => (result.code === 0 ? result.stdout.split("\0") : [])),
          Effect.orElseSucceed((): ReadonlyArray<string> => []),
        );
      const imported = new Set(placed.map((file) => file.path));
      const own = [...new Set(listing)]
        .filter((path) => path !== "" && !imported.has(path))
        .map((path) => ({ path, origin: "devgame" as const }));
      return {
        import: { receipt: summarizeReceipt(receipt.value), files: [...placed, ...own] },
      } satisfies MrMakImportStatusSuccess;
    });

    return {
      review: (request: ImportReviewRequest) => Effect.map(review(request), (r) => r.summary),
      apply,
      status,
    };
  });
