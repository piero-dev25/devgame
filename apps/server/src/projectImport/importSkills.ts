// @effect-diagnostics nodeBuiltinImport:off
/**
 * importSkills - imports a plan's `.agents/skills` and materializes
 * `.claude/skills` from it, through the content import engine.
 *
 * The complete source tree (scripts/, references/ and dot-entries included)
 * goes to `<dest>/.agents/skills`, the shared source Codex and Antigravity read.
 * Its sync-skills subset goes to `<dest>/.claude/skills`, all Claude reads.
 * Both are entries of one content import, so staging, the receipt, reruns,
 * conflict safety and the baseline commit are importContent's. A source skill
 * whose name a different destination skill already uses stops the import
 * before any write until the user chooses keep-existing or import-renamed for
 * it; a rename rewrites the skill's references to its own name. Once the files
 * are in place both trees are checked on disk and the summary is published in
 * the receipt. Nothing from a skill is run and no provider is contacted:
 * requirements are only listed, from every text file of the skill.
 *
 * @module importSkills
 */
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import {
  MrMakImportReceipt,
  type MrMakImportEntry,
  type MrMakImportPlan,
  type MrMakSkillConflictChoice,
  type MrMakSkillImportSummary,
  type MrMakSkillRequirement,
} from "@t3tools/contracts";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";
import {
  MrMakImportApplyError,
  type ImportContentRequest,
  type ImportContentResult,
} from "./importContent.ts";
import {
  isSkillDistributionPath,
  makeBatchParser,
  rewriteSkillReferences,
  skillRequirementsFrom,
} from "./mrMakImportContent.ts";

const posix = NodePath.posix;
const AGENTS = ".agents/skills";
const CLAUDE = ".claude/skills";
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const decodeReceipt = Schema.decodeUnknownOption(fromLenientJson(MrMakImportReceipt));

export class MrMakSkillImportError extends Schema.TaggedError<MrMakSkillImportError>()(
  "MrMakSkillImportError",
  {
    reason: Schema.Literals(["no-skills", "skill-conflict", "invalid-choice", "source-read"]),
    skills: Schema.Array(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const names = this.skills.join(", ");
    switch (this.reason) {
      case "no-skills":
        return "The plan has no .agents/skills files to import.";
      case "skill-conflict":
        return `The destination already has different skills named ${names}; choose keep-existing or import-renamed for each.`;
      case "invalid-choice":
        return `The choices for ${names} name no source skill, keep a skill the destination does not have, or pick a name that is invalid or taken.`;
      case "source-read":
        return "Reading the skills from the source repository failed.";
    }
  }
}

export interface ImportSkillsRequest {
  readonly plan: MrMakImportPlan;
  readonly destinationRoot: string;
  readonly skillChoices?: ReadonlyArray<MrMakSkillConflictChoice> | undefined;
  /** File-level choices for the rest of the plan, as for importContent. */
  readonly choices?: ImportContentRequest["choices"];
}

export interface SkillPreviewRequest {
  readonly plan: MrMakImportPlan;
  readonly destinationRoot: string;
}

export interface ImportSkillsResult extends ImportContentResult {
  /** Checked on disk by this run, also when it changed nothing. */
  readonly skills: MrMakSkillImportSummary;
}

const sha256 = (bytes: Uint8Array | string) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

/** `.agents/skills/<name>/<rest>`; null for a file directly in `.agents/skills`. */
const skillOf = (entry: MrMakImportEntry) => {
  const [name = "", ...rest] = entry.sourcePath.slice(AGENTS.length + 1).split("/");
  return rest.length === 0 ? null : { name, rest: rest.join("/") };
};
const isDistributed = (entry: MrMakImportEntry) =>
  entry.symlinkTarget === null &&
  isSkillDistributionPath(entry.sourcePath.slice(AGENTS.length + 1));
/** Prose and code a skill names its dependencies in; anything larger is data. */
const SCANNED_TEXT = /\.(?:md|markdown|txt|py|[cm]?[jt]sx?|sh|bash|zsh|json|toml|ya?ml)$/i;
const MAX_SCANNED_BYTES = 1024 * 1024;
const isScanned = (entry: MrMakImportEntry) => {
  const skill = skillOf(entry);
  return (
    skill !== null &&
    entry.symlinkTarget === null &&
    entry.bytes <= MAX_SCANNED_BYTES &&
    SCANNED_TEXT.test(skill.rest) &&
    !skill.rest.split("/").includes("node_modules")
  );
};
/** APFS and NTFS fold case by default, so `Beta` and `beta` are one folder there. */
const fold = (name: string) => name.toLowerCase();

export const makeSkillImporter = (
  importContent: (
    request: ImportContentRequest,
  ) => Effect.Effect<ImportContentResult, MrMakImportApplyError>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const processRunner = yield* ProcessRunner.ProcessRunner;

    /** sha256 of a file, or of a symlink's own link text; null when absent. */
    const hashAt = (absolute: string) =>
      fileSystem.readLink(absolute).pipe(
        Effect.map((text) => sha256(text)),
        Effect.catch(() =>
          fileSystem.readFile(absolute).pipe(Effect.map((bytes) => sha256(bytes))),
        ),
        Effect.orElseSucceed((): string | null => null),
      );

    /** Relative path to sha256 for everything under a folder; null when there is no folder. */
    const treeHashes = Effect.fn("importSkills.treeHashes")(function* (directory: string) {
      const names = yield* fileSystem
        .readDirectory(directory, { recursive: true })
        .pipe(Effect.option);
      if (Option.isNone(names)) return null;
      const hashes = new Map<string, string>();
      for (const name of names.value) {
        const absolute = NodePath.join(directory, name);
        const info = yield* fileSystem.stat(absolute).pipe(Effect.option);
        const isLink = Option.isSome(yield* fileSystem.readLink(absolute).pipe(Effect.option));
        if (isLink || (Option.isSome(info) && info.value.type === "File")) {
          hashes.set(name.split(NodePath.sep).join("/"), (yield* hashAt(absolute)) ?? "");
        }
      }
      return hashes;
    });

    /** The plan's `.agents/skills` entries by skill name. */
    const groupSkills = (plan: MrMakImportPlan) => {
      const bySkill = new Map<string, Array<MrMakImportEntry>>();
      for (const entry of plan.entries.filter((candidate) => candidate.root === AGENTS)) {
        const skill = skillOf(entry);
        if (!skill) continue;
        const list = bySkill.get(skill.name) ?? [];
        list.push(entry);
        bySkill.set(skill.name, list);
      }
      return bySkill;
    };

    /**
     * What the destination already holds, which of it a previous import put
     * there, and the source skills whose name a different destination skill uses.
     */
    const destinationSkills = Effect.fn("importSkills.destinationSkills")(function* (
      destinationRoot: string,
      bySkill: ReadonlyMap<string, ReadonlyArray<MrMakImportEntry>>,
    ) {
      const root = yield* fileSystem
        .realPath(destinationRoot)
        .pipe(Effect.orElseSucceed(() => null));
      const previous =
        root === null
          ? Option.none()
          : yield* fileSystem
              .readFileString(NodePath.join(root, ".devgame/import/receipt.json"))
              .pipe(Effect.map(decodeReceipt), Effect.orElseSucceed(Option.none));
      const owned = Option.match(previous, {
        onNone: () => [],
        onSome: (receipt) =>
          receipt.files.filter((file) => file.outcome !== "conflict").map((file) => file.path),
      });
      /** A different skill at `<base>/<name>`: there, not ours, and not the bytes `expected`. */
      const takenAt = Effect.fn("importSkills.takenAt")(function* (
        base: string,
        name: string,
        expected: ReadonlyArray<MrMakImportEntry> | null,
      ) {
        const location = `${base}/${name}`;
        const tree = root === null ? null : yield* treeHashes(NodePath.join(root, location));
        if (tree === null || owned.some((file) => file.startsWith(`${location}/`))) return false;
        if (expected === null) return true;
        return !(
          tree.size === expected.length &&
          expected.every((entry) => {
            const hash = tree.get(skillOf(entry)?.rest ?? "");
            return hash === entry.sha256 || hash === entry.crlfCheckout?.sha256;
          })
        );
      });
      const conflicts: Array<string> = [];
      for (const [name, entries] of bySkill) {
        if (
          (yield* takenAt(AGENTS, name, entries)) ||
          (yield* takenAt(CLAUDE, name, entries.filter(isDistributed)))
        ) {
          conflicts.push(name);
        }
      }
      return { root, takenAt, conflicts };
    });

    /**
     * The plan as these skill choices import it: kept skills dropped, renamed
     * ones moved and rewritten, Claude copies added. Refuses choices that are
     * missing, unknown or name a taken folder. Reads, never writes.
     */
    const layout = Effect.fn("importSkills.layout")(function* (
      request: Pick<ImportSkillsRequest, "plan" | "destinationRoot" | "skillChoices">,
    ) {
      const { plan } = request;
      const fail = (
        reason: MrMakSkillImportError["reason"],
        skills: ReadonlyArray<string> = [],
        cause?: unknown,
      ) => new MrMakSkillImportError({ reason, skills: [...skills], cause });
      const skillEntries = plan.entries.filter((entry) => entry.root === AGENTS);
      const bySkill = groupSkills(plan);
      if (bySkill.size === 0) return yield* fail("no-skills");
      const { root, takenAt, conflicts } = yield* destinationSkills(
        request.destinationRoot,
        bySkill,
      );

      const choices = new Map((request.skillChoices ?? []).map((choice) => [choice.skill, choice]));
      const unknown = [...choices.keys()].filter((name) => !bySkill.has(name));
      if (unknown.length > 0) return yield* fail("invalid-choice", unknown);
      const unresolved = conflicts.filter((name) => !choices.has(name));
      if (unresolved.length > 0) return yield* fail("skill-conflict", unresolved);
      // Keeping the destination's skill only means something where it has one.
      const nothingToKeep = [...choices.values()]
        .filter((choice) => choice.action === "keep-existing" && !conflicts.includes(choice.skill))
        .map((choice) => choice.skill);
      if (nothingToKeep.length > 0) return yield* fail("invalid-choice", nothingToKeep);

      /** Original to active name; kept-existing skills are absent. */
      const active = new Map<string, string>();
      for (const name of bySkill.keys()) {
        const choice = choices.get(name);
        if (choice?.action === "keep-existing") continue;
        active.set(
          name,
          choice?.action === "import-renamed" ? (choice.newName ?? `${name}-mrmak`) : name,
        );
      }
      // Names compare up to case: on a case-folding disk two such names share one folder.
      const sourceNames = new Set([...bySkill.keys()].map(fold));
      /** Folded active names of the skills keeping their name, or of the renamed ones. */
      const activeNames = (renamed: boolean) =>
        [...active]
          .filter(([name, activeName]) => (activeName !== name) === renamed)
          .map(([, activeName]) => fold(activeName));
      const clashes = (name: string, renamed: boolean) =>
        activeNames(renamed).filter((other) => other === fold(name)).length > 1;
      /** A different skill in a destination folder named `name` up to case. */
      const takenUpToCase = Effect.fn("importSkills.takenUpToCase")(function* (name: string) {
        for (const base of [AGENTS, CLAUDE]) {
          const existing =
            root === null
              ? []
              : yield* fileSystem
                  .readDirectory(NodePath.join(root, base))
                  .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
          for (const other of existing.filter((candidate) => fold(candidate) === fold(name))) {
            if (yield* takenAt(base, other, null)) return true;
          }
        }
        return false;
      });
      const invalid: Array<string> = [];
      for (const [name, activeName] of active) {
        // A source skill keeping its name clashes only with another such one; a rename with any.
        if (activeName === name ? clashes(name, false) : clashes(activeName, true)) {
          invalid.push(name);
        } else if (
          activeName !== name &&
          (!SKILL_NAME.test(activeName) ||
            sourceNames.has(fold(activeName)) ||
            (yield* takenAt(AGENTS, activeName, null)) ||
            (yield* takenAt(CLAUDE, activeName, null)) ||
            (yield* takenUpToCase(activeName)))
        ) {
          invalid.push(name);
        }
      }
      if (invalid.length > 0) return yield* fail("invalid-choice", invalid);

      // Committed text of each scanned file (for requirements) and of every renamed file.
      const isRenamed = (entry: MrMakImportEntry) => {
        const skill = skillOf(entry);
        return skill !== null && (active.get(skill.name) ?? skill.name) !== skill.name;
      };
      const oids = [
        ...new Set(
          skillEntries
            .filter((entry) => entry.symlinkTarget === null)
            .filter((entry) => isScanned(entry) || isRenamed(entry))
            .map((entry) => entry.headBlobOid),
        ),
      ];
      const parser = makeBatchParser(new Set(oids));
      if (oids.length > 0) {
        const batch = yield* processRunner
          .run({
            command: "git",
            args: ["-c", "core.fsmonitor=false", "cat-file", "--batch"],
            cwd: plan.source.repositoryPath,
            env: { GIT_OPTIONAL_LOCKS: "0" },
            stdin: `${oids.join("\n")}\n`,
            onStdoutChunk: parser.push,
            maxOutputBytes: 64 * 1024,
            outputMode: "truncate",
            timeout: "10 minutes",
          })
          .pipe(Effect.mapError((cause) => fail("source-read", [], cause)));
        if (batch.code !== 0 || parser.blobs.size !== oids.length) {
          return yield* fail("source-read");
        }
      }
      /** UTF-8 text, or null for binary content. */
      const textOf = (entry: MrMakImportEntry) => {
        const blob = parser.blobs.get(entry.headBlobOid);
        return blob?.text != null && sha256(blob.text) === blob.sha256 ? blob.text : null;
      };

      // The plan as imported: kept skills dropped, renamed ones moved and rewritten, Claude copies added.
      const entries: Array<MrMakImportEntry> = [];
      const rewrites: Record<string, { from: string; to: string }> = {};
      const placed: Array<{ copy: MrMakImportEntry; claudePath: string | null }> = [];
      for (const entry of plan.entries) {
        if (entry.root !== AGENTS) {
          entries.push(entry);
          continue;
        }
        const skill = skillOf(entry);
        const activeName = skill ? active.get(skill.name) : undefined;
        if (skill && activeName === undefined) continue;
        const relative = skill
          ? `${activeName}/${skill.rest}`
          : entry.sourcePath.slice(AGENTS.length + 1);
        let copy: MrMakImportEntry = { ...entry, destinationPath: `${AGENTS}/${relative}` };
        const text = skill && activeName !== skill.name ? textOf(entry) : null;
        if (skill && activeName !== undefined && text !== null) {
          const rewritten = rewriteSkillReferences(
            Buffer.from(text, "utf8"),
            skill.name,
            activeName,
          );
          if (sha256(rewritten) !== entry.sha256) {
            copy = {
              ...copy,
              sha256: sha256(rewritten),
              bytes: rewritten.length,
              crlfCheckout: null,
            };
            rewrites[copy.destinationPath] = { from: skill.name, to: activeName };
          }
        }
        entries.push(copy);
        const claudePath = isDistributed(entry) ? `${CLAUDE}/${relative}` : null;
        if (claudePath !== null) {
          entries.push({ ...copy, destinationPath: claudePath });
          const rewrite = rewrites[copy.destinationPath];
          if (rewrite) rewrites[claudePath] = rewrite;
        }
        placed.push({ copy, claudePath });
      }
      return { skillEntries, bySkill, active, entries, rewrites, placed, textOf };
    });

    const importSkills = Effect.fn("MrMakImport.importSkills")(function* (
      request: ImportSkillsRequest,
    ) {
      const { plan } = request;
      const { skillEntries, bySkill, active, entries, rewrites, placed, textOf } =
        yield* layout(request);

      const requirementsOf = (list: ReadonlyArray<MrMakImportEntry>) => {
        const found = new Map<string, MrMakSkillRequirement>();
        for (const entry of list.filter(isScanned)) {
          const text = textOf(entry);
          for (const requirement of text === null
            ? []
            : skillRequirementsFrom(entry.sourcePath, text)) {
            const key = `${requirement.kind}\0${requirement.name}`;
            if (!found.has(key)) found.set(key, requirement);
          }
        }
        return [...found.values()];
      };

      /** Both copies checked against the expected bytes; `.claude` against `.agents`, the shared source. */
      const summarize = Effect.fn("importSkills.summarize")(function* (destination: string) {
        const differences: MrMakSkillImportSummary["equivalence"]["differences"][number][] = [];
        const at = (relativePath: string) => hashAt(NodePath.join(destination, relativePath));
        for (const { copy, claudePath } of placed) {
          const agents = yield* at(copy.destinationPath);
          if (agents === null) differences.push({ path: copy.destinationPath, problem: "missing" });
          else if (agents !== copy.sha256 && agents !== copy.crlfCheckout?.sha256) {
            differences.push({ path: copy.destinationPath, problem: "different" });
          }
          if (claudePath !== null) {
            const claude = yield* at(claudePath);
            if (claude === null) differences.push({ path: claudePath, problem: "missing" });
            else if (claude !== agents)
              differences.push({ path: claudePath, problem: "different" });
          }
          // Links the source's SKILL.md resolves inside its own skill must resolve in each copy.
          const skill = skillOf(copy);
          if (skill?.rest !== "SKILL.md") continue;
          const sourceDirectory = `${AGENTS}/${skill.name}/`;
          for (const link of copy.links) {
            if (link.status !== "resolved" || !link.resolved?.startsWith(sourceDirectory)) continue;
            for (const skillFile of [copy.destinationPath, claudePath ?? []].flat()) {
              const target = posix.join(
                posix.dirname(skillFile),
                link.resolved.slice(sourceDirectory.length),
              );
              if (!(yield* fileSystem.exists(NodePath.join(destination, target)))) {
                differences.push({ path: `${skillFile} -> ${link.href}`, problem: "broken-link" });
              }
            }
          }
        }
        const distributionFiles = skillEntries.filter(isDistributed).length;
        return {
          skills: [...bySkill].map(([name, list]) => {
            const activeName = active.get(name);
            return {
              original: name,
              active: activeName ?? name,
              action:
                activeName === undefined
                  ? ("kept-existing" as const)
                  : activeName === name
                    ? ("imported" as const)
                    : ("renamed" as const),
              files: list.length,
              distributionFiles: list.filter(isDistributed).length,
              requirements: requirementsOf(list),
            };
          }),
          names: Object.fromEntries(active),
          baseline: skillEntries.map((entry) => ({ path: entry.sourcePath, sha256: entry.sha256 })),
          totals: {
            skills: bySkill.size,
            files: skillEntries.length,
            distributionFiles,
            agentsOnlyFiles: skillEntries.length - distributionFiles,
          },
          equivalence: { verified: differences.length === 0, differences },
        } satisfies MrMakSkillImportSummary;
      });

      const result = yield* importContent({
        plan: { ...plan, entries },
        destinationRoot: request.destinationRoot,
        choices: request.choices,
        rewrites,
        summarizeSkills: summarize,
      });
      const skills =
        result.status === "imported" && result.receipt.skills
          ? result.receipt.skills
          : yield* summarize(yield* fileSystem.realPath(request.destinationRoot));
      return { ...result, skills } satisfies ImportSkillsResult;
    });

    /**
     * Without writing: each source skill, whether a different destination skill
     * already uses its name, and the plan laid out as an import without skill
     * choices would place it (each sync-skills file again under `.claude/skills`),
     * plus each conflicting skill's files where import-renamed would place them.
     */
    const previewSkills = Effect.fn("MrMakImport.previewSkills")(function* (
      request: SkillPreviewRequest,
    ) {
      const bySkill = groupSkills(request.plan);
      const { conflicts } = yield* destinationSkills(request.destinationRoot, bySkill);
      // Imported renamed, a conflicting skill lands in `<name>-mrmak`, where an
      // earlier import may have left files the user changed since. That layout
      // is previewed too, so its file conflicts are reviewed before apply.
      const renamedLayout =
        conflicts.length === 0
          ? Option.none()
          : yield* layout({
              plan: request.plan,
              destinationRoot: request.destinationRoot,
              skillChoices: conflicts.map((skill) => ({
                skill,
                action: "import-renamed" as const,
              })),
            }).pipe(Effect.option);
      const renamedEntries = Option.match(renamedLayout, {
        onNone: (): ReadonlyArray<MrMakImportEntry> => [],
        onSome: (renamed) =>
          renamed.entries.filter(
            (entry) => entry.root === AGENTS && conflicts.includes(skillOf(entry)?.name ?? ""),
          ),
      });
      return {
        skills: [...bySkill].map(([name, list]) => ({
          name,
          files: list.length,
          conflict: conflicts.includes(name),
        })),
        entries: [
          ...request.plan.entries.flatMap((entry) =>
            entry.root === AGENTS && isDistributed(entry)
              ? [
                  entry,
                  {
                    ...entry,
                    destinationPath: `${CLAUDE}/${entry.sourcePath.slice(AGENTS.length + 1)}`,
                  },
                ]
              : [entry],
          ),
          ...renamedEntries,
        ],
        /** Conflicting skill to the folder name import-renamed gives it, where it can. */
        renamed: Option.match(renamedLayout, {
          onNone: (): Readonly<Record<string, string>> => ({}),
          onSome: (renamed) =>
            Object.fromEntries(conflicts.flatMap((name) => {
              const activeName = renamed.active.get(name);
              return activeName === undefined ? [] : [[name, activeName]];
            })),
        }),
      };
    });

    const asApplyError = (destinationRoot: string) => (cause: PlatformError.PlatformError) =>
      Effect.fail(
        new MrMakImportApplyError({
          reason: "filesystem",
          destinationRoot,
          detail: cause.message,
          cause,
        }),
      );

    return {
      importSkills: (request: ImportSkillsRequest) =>
        importSkills(request).pipe(
          Effect.catchTag("PlatformError", asApplyError(request.destinationRoot)),
        ),
      previewSkills,
    };
  });
