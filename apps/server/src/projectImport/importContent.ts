// @effect-diagnostics nodeBuiltinImport:off
/**
 * importContent - applies a MrMakImport plan to a destination project.
 *
 * The plan decides what to copy; this only decides how. Bytes come from the
 * source's committed blobs (`git cat-file blob <oid>`), never its working tree,
 * and are copied unchanged, except for a renamed skill's references to its own
 * name (`rewrites`). Everything lives under `<destination>/.devgame/import/`:
 * a staging manifest is written before any copy, each file is staged under
 * `staging/<importId>/files/` and then moved into place with a rename, and
 * `receipt.json` is written last. A destination copy is only replaced when it
 * still holds what the previous import wrote, or the user chose `take-source`;
 * the replaced copy is kept under `replaced/<importId>/`. Nothing is deleted
 * except, on rollback, files this import moved in and the user has not touched.
 *
 * @module importContent
 */
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  MrMakImportReceipt,
  type MrMakImportConflictChoice,
  type MrMakImportFileOutcome,
  type MrMakImportPlan,
  type MrMakSkillImportSummary,
} from "@t3tools/contracts";
import { fromJsonStringPretty, fromLenientJson } from "@t3tools/shared/schemaJson";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { rewriteSkillReferences } from "./mrMakImportContent.ts";

const posix = NodePath.posix;
const IMPORT_DIRECTORY = ".devgame/import";
const RECEIPT_PATH = `${IMPORT_DIRECTORY}/receipt.json`;
const GITIGNORE_PATH = `${IMPORT_DIRECTORY}/.gitignore`;
const READ_ONLY_GIT_ARGS = ["-c", "core.fsmonitor=false"];
const READ_ONLY_GIT_ENV = { GIT_OPTIONAL_LOCKS: "0" };
/** Written once every write is staged; before it exists, no write has been moved into place. */
const STAGED_MARKER = "staged";
/** Outcomes whose destination copy is the source's bytes, and so belongs in the baseline commit. */
const BASELINE_OUTCOMES: ReadonlySet<MrMakImportFileOutcome> = new Set([
  "written",
  "identical",
  "updated",
  "replaced",
]);

const StagedWrite = Schema.Struct({
  path: Schema.String,
  oid: Schema.String,
  sha256: Schema.String,
  symlink: Schema.Boolean,
  executable: Schema.Boolean,
  /** sha256 of the destination copy this write moves aside; null when the path was empty. */
  replaces: Schema.NullOr(Schema.String),
  /** A renamed skill's file: its references to `from` become `to`; `sha256` is of the result. */
  rewrite: Schema.optionalKey(Schema.Struct({ from: Schema.String, to: Schema.String })),
});
type StagedWrite = typeof StagedWrite.Type;
const StagingManifest = Schema.Struct({
  writes: Schema.Array(StagedWrite),
  /** Folders the writes need that did not exist; rollback removes them when empty. */
  createdDirectories: Schema.Array(Schema.String),
  /** The receipt to publish, without `completedAt`. */
  receipt: MrMakImportReceipt,
});
type StagingManifest = typeof StagingManifest.Type;

const decodeReceipt = Schema.decodeUnknownOption(fromLenientJson(MrMakImportReceipt));
const encodeReceipt = Schema.encodeSync(fromJsonStringPretty(MrMakImportReceipt));
const decodeManifest = Schema.decodeUnknownOption(fromLenientJson(StagingManifest));
const encodeManifest = Schema.encodeSync(fromJsonStringPretty(StagingManifest));

export class MrMakImportApplyError extends Schema.TaggedError<MrMakImportApplyError>()(
  "MrMakImportApplyError",
  {
    reason: Schema.Literals([
      "unsafe-destination",
      "unsafe-path",
      "pending-import",
      "nothing-to-roll-back",
      "destination-changed",
      "source-read",
      "filesystem",
      "nothing-to-verify",
    ]),
    destinationRoot: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "unsafe-destination":
        return `Refusing to import into ${this.destinationRoot}: ${this.detail}`;
      case "unsafe-path":
        return `Refusing to write ${this.detail}: it is not a plain path inside the destination.`;
      case "pending-import":
        return `Import ${this.detail} into ${this.destinationRoot} was interrupted; resume it or roll it back first.`;
      case "nothing-to-roll-back":
        return `No interrupted import ${this.detail} in ${this.destinationRoot}.`;
      case "destination-changed":
        return `${this.detail} changed at the destination while it was being imported.`;
      case "source-read":
        return `Reading ${this.detail} from the source repository failed.`;
      case "filesystem":
        return `Import into ${this.destinationRoot} failed: ${this.detail}`;
      case "nothing-to-verify":
        return `Nothing to verify in ${this.destinationRoot}: ${this.detail}`;
    }
  }
}

const isApplyError = Schema.is(MrMakImportApplyError);

export interface ImportContentRequest {
  readonly plan: MrMakImportPlan;
  readonly destinationRoot: string;
  /** Per destination path; a conflict is only overwritten with `take-source`. */
  readonly choices?: Readonly<Record<string, MrMakImportConflictChoice>> | undefined;
  /**
   * Per destination path: rewrite a renamed skill's references to its old
   * name. That entry's `sha256` and `bytes` must be those of the rewritten file.
   */
  readonly rewrites?: Readonly<Record<string, { readonly from: string; readonly to: string }>>;
  /** Runs once every file is in place; its result is published in the receipt. */
  readonly summarizeSkills?: (
    destinationRoot: string,
  ) => Effect.Effect<MrMakSkillImportSummary, PlatformError.PlatformError>;
}

export interface ImportContentResult {
  readonly status: "imported" | "unchanged";
  readonly receiptPath: string;
  readonly receipt: MrMakImportReceipt;
  /** The labelled baseline commit, made only by the first import into a destination. */
  readonly commit: {
    readonly status: "committed" | "skipped" | "failed";
    readonly detail: string | null;
  };
}

export interface RollbackImportResult {
  readonly removed: ReadonlyArray<string>;
  readonly restored: ReadonlyArray<string>;
  /** Files this import wrote that the user has changed since; left in place. */
  readonly kept: ReadonlyArray<string>;
}

type DestinationState =
  | { readonly kind: "absent" | "blocked" }
  | { readonly kind: "file" | "symlink"; readonly sha256: string };

const sha256 = (bytes: string | Uint8Array) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

/** A POSIX path of plain names that stays out of `.git` and DevGame's own folder. */
const isPlainRelativePath = (relativePath: string) => {
  const segments = relativePath.split("/");
  return (
    !/[\\\0]/.test(relativePath) &&
    segments.every((segment) => segment !== "" && segment !== "." && segment !== "..") &&
    segments[0] !== ".git" &&
    segments[0] !== ".devgame"
  );
};

const isWithin = (parent: string, child: string) => {
  const relative = NodePath.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
};

export const makeContentImporter = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const git = yield* GitVcsDriver.GitVcsDriver;

  const notFound =
    <A>(value: A) =>
    <B, R>(effect: Effect.Effect<B, PlatformError.PlatformError, R>) =>
      effect.pipe(
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeed(value),
        ),
      );
  const writeAtomically = (filePath: string, contents: string) =>
    writeFileStringAtomically({ filePath, contents }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  /** What sits at `relativePath`, never following a symlink on the way. */
  const inspect = Effect.fn("importContent.inspect")(function* (
    root: string,
    relativePath: string,
  ) {
    const segments = relativePath.split("/");
    let current = root;
    for (const [index, segment] of segments.entries()) {
      current = path.join(current, segment);
      const last = index === segments.length - 1;
      const link = yield* fileSystem.readLink(current).pipe(Effect.option);
      if (Option.isSome(link)) {
        return last
          ? ({ kind: "symlink", sha256: sha256(link.value) } as DestinationState)
          : ({ kind: "blocked" } as DestinationState);
      }
      const info = yield* fileSystem.stat(current).pipe(Effect.asSome, notFound(Option.none()));
      if (Option.isNone(info)) return { kind: "absent" } as DestinationState;
      if (last && info.value.type === "File") {
        return {
          kind: "file",
          sha256: sha256(yield* fileSystem.readFile(current)),
        } as DestinationState;
      }
      if (last || info.value.type !== "Directory") return { kind: "blocked" } as DestinationState;
    }
    return { kind: "absent" } as DestinationState;
  });

  /** mkdir -p that refuses to pass through a symlink or a file. */
  const ensureDirectory = Effect.fn("importContent.ensureDirectory")(function* (
    root: string,
    relativePath: string,
  ) {
    let current = root;
    for (const segment of relativePath.split("/").filter((part) => part !== ".")) {
      current = path.join(current, segment);
      const state = yield* inspect(path.dirname(current), segment);
      if (state.kind === "absent") {
        yield* fileSystem.makeDirectory(current).pipe(
          Effect.catchIf(
            (error) => error.reason._tag === "AlreadyExists",
            () => Effect.void,
          ),
        );
      } else if (
        state.kind !== "blocked" ||
        (yield* fileSystem.stat(current)).type !== "Directory"
      ) {
        return yield* new MrMakImportApplyError({
          reason: "unsafe-path",
          destinationRoot: root,
          detail: path.relative(root, current),
        });
      }
    }
  });

  const readBlob = Effect.fn("importContent.readBlob")(function* (
    sourceRoot: string,
    write: StagedWrite,
    destinationRoot: string,
  ) {
    const chunks: Array<Uint8Array> = [];
    const result = yield* processRunner
      .run({
        command: "git",
        args: [...READ_ONLY_GIT_ARGS, "cat-file", "blob", write.oid],
        cwd: sourceRoot,
        env: READ_ONLY_GIT_ENV,
        onStdoutChunk: (chunk) => chunks.push(Uint8Array.from(chunk)),
        maxOutputBytes: 64 * 1024,
        outputMode: "truncate",
        timeout: "5 minutes",
      })
      .pipe(Effect.option);
    const blob = Buffer.concat(chunks);
    const bytes = write.rewrite
      ? Buffer.from(rewriteSkillReferences(blob, write.rewrite.from, write.rewrite.to))
      : blob;
    if (Option.isNone(result) || result.value.code !== 0 || sha256(bytes) !== write.sha256) {
      return yield* new MrMakImportApplyError({
        reason: "source-read",
        destinationRoot,
        detail: write.path,
      });
    }
    return bytes;
  });

  const readJson = <A>(filePath: string, decode: (text: string) => Option.Option<A>) =>
    fileSystem.readFileString(filePath).pipe(Effect.map(decode), notFound(Option.none<A>()));

  /** Moves kept-aside copies to `replaced/<importId>/` and drops the staging folder. */
  const finishStaging = Effect.fn("importContent.finishStaging")(function* (
    root: string,
    importId: string,
  ) {
    const stagingDirectory = path.join(root, IMPORT_DIRECTORY, "staging", importId);
    const replaced = path.join(stagingDirectory, "replaced");
    if (yield* fileSystem.exists(replaced)) {
      yield* ensureDirectory(root, `${IMPORT_DIRECTORY}/replaced`);
      yield* fileSystem.rename(replaced, path.join(root, IMPORT_DIRECTORY, "replaced", importId));
    }
    yield* fileSystem.remove(stagingDirectory, { recursive: true, force: true });
  });

  /**
   * Resolves the destination, refusing the source, home and anything around
   * them. The nearest existing folder is resolved through any symlinks and
   * checked before a folder is created, and missing folders are created under
   * that resolved path, unless `ifMissing` is given: then nothing is created
   * and a missing destination fails with it.
   */
  const resolveDestination = Effect.fn("importContent.resolveDestination")(function* (
    destinationRoot: string,
    sourceRoot: string | null,
    ifMissing?: MrMakImportApplyError,
  ) {
    const refuse = (detail: string) =>
      new MrMakImportApplyError({ reason: "unsafe-destination", destinationRoot, detail });
    const home = NodeOS.homedir();
    const check = (candidate: string) => {
      if (!path.isAbsolute(candidate)) return refuse("the path is not absolute.");
      if (
        sourceRoot !== null &&
        (isWithin(candidate, sourceRoot) || isWithin(sourceRoot, candidate))
      ) {
        return refuse("it overlaps the source repository.");
      }
      const inHome = isWithin(home, candidate) && path.relative(home, candidate).startsWith(".");
      if (isWithin(candidate, home) || inHome) {
        return refuse("it is the home folder, one of its parents, or a hidden folder in it.");
      }
      return null;
    };
    const lexical = check(path.normalize(destinationRoot));
    if (lexical) return yield* lexical;
    let existing = path.normalize(destinationRoot);
    const missing: Array<string> = [];
    let ancestor = yield* fileSystem
      .realPath(existing)
      .pipe(Effect.asSome, notFound(Option.none()));
    while (Option.isNone(ancestor)) {
      const parent = path.dirname(existing);
      if (parent === existing) return yield* refuse("none of its folders exist.");
      missing.unshift(path.basename(existing));
      existing = parent;
      ancestor = yield* fileSystem.realPath(existing).pipe(Effect.asSome, notFound(Option.none()));
    }
    const resolved = path.join(ancestor.value, ...missing);
    const beforeCreate = check(resolved);
    if (beforeCreate) return yield* beforeCreate;
    if (missing.length > 0 && ifMissing !== undefined) return yield* ifMissing;
    let current = ancestor.value;
    for (const name of missing) {
      current = path.join(current, name);
      yield* fileSystem.makeDirectory(current).pipe(
        Effect.catchIf(
          (error) => error.reason._tag === "AlreadyExists",
          () => Effect.void,
        ),
      );
    }
    const root = yield* fileSystem.realPath(resolved);
    const real = check(root);
    if (real) return yield* real;
    return root;
  });

  /** Decides each planned file once, against the destination as it is now. */
  const classify = Effect.fn("importContent.classify")(function* (
    root: string,
    plan: MrMakImportPlan,
    choices: Readonly<Record<string, MrMakImportConflictChoice>>,
    importId: string,
    previous: MrMakImportReceipt | null,
    rewrites: NonNullable<ImportContentRequest["rewrites"]>,
  ) {
    const before = new Map(previous?.files.map((file) => [file.path, file]));
    const files: Array<MrMakImportReceipt["files"][number]> = [];
    const conflicts: Array<{ path: string; reason: string }> = [];
    const writes: Array<StagedWrite> = [];
    const transforms: Array<string> = [];
    for (const entry of plan.entries) {
      const filePath = entry.destinationPath;
      const symlink = entry.symlinkTarget !== null;
      const rewrite = rewrites[filePath];
      if (rewrite) {
        transforms.push(
          `${filePath}: references to skill ${rewrite.from} renamed to ${rewrite.to}`,
        );
      }
      const accepted = [entry.sha256, entry.crlfCheckout?.sha256];
      const current = yield* inspect(root, filePath);
      const last = before.get(filePath);
      const record = (outcome: MrMakImportFileOutcome, destinationSha256: string | null) =>
        files.push({ path: filePath, sourceSha256: entry.sha256, destinationSha256, outcome });
      const write = (replaces: string | null) =>
        writes.push({
          path: filePath,
          oid: entry.headBlobOid,
          sha256: entry.sha256,
          symlink,
          executable: entry.executable,
          replaces,
          ...(rewrite ? { rewrite: { from: rewrite.from, to: rewrite.to } } : {}),
        });
      if (
        current.kind === (symlink ? "symlink" : "file") &&
        "sha256" in current &&
        accepted.includes(current.sha256)
      ) {
        record("identical", current.sha256);
      } else if (last && last.outcome !== "conflict" && last.sourceSha256 === entry.sha256) {
        record("kept-local", last.destinationSha256);
      } else if (current.kind === "absent") {
        write(null);
        record("written", entry.sha256);
      } else if (!("sha256" in current)) {
        conflicts.push({ path: filePath, reason: "A folder or link is in the way." });
        record("conflict", null);
      } else if (last?.destinationSha256 === current.sha256) {
        write(current.sha256);
        record("updated", entry.sha256);
      } else if (choices[filePath] === "take-source") {
        write(current.sha256);
        record("replaced", entry.sha256);
      } else {
        conflicts.push({
          path: filePath,
          reason: last
            ? "Changed at the destination since the last import."
            : "A different file is already at the destination.",
        });
        record("conflict", null);
      }
    }
    const planned = new Set(plan.entries.map((entry) => entry.destinationPath));
    const changes = previous
      ? [
          ...plan.entries.flatMap((entry) => {
            const last = before.get(entry.destinationPath);
            if (last?.sourceSha256 === entry.sha256) return [];
            return [
              {
                path: entry.destinationPath,
                change: last ? ("modified" as const) : ("added" as const),
                previousSha256: last?.sourceSha256 ?? null,
                sha256: entry.sha256,
              },
            ];
          }),
          ...previous.files
            .filter((file) => !planned.has(file.path))
            .map((file) => ({
              path: file.path,
              change: "removed" as const,
              previousSha256: file.sourceSha256,
              sha256: null,
            })),
        ]
      : [];
    const directories = new Set(
      writes.flatMap((write) =>
        write.path
          .split("/")
          .slice(0, -1)
          .map((_, index, parts) => parts.slice(0, index + 1).join("/")),
      ),
    );
    const createdDirectories: Array<string> = [];
    for (const directory of directories) {
      if ((yield* inspect(root, directory)).kind === "absent") createdDirectories.push(directory);
    }
    return {
      writes,
      createdDirectories,
      receipt: {
        version: 1,
        importId,
        previousImportId: previous?.importId ?? null,
        source: {
          repositoryPath: plan.source.repositoryPath,
          revision: plan.source.revision,
          branch: plan.source.branch,
        },
        startedAt: yield* nowIso,
        completedAt: "",
        files,
        changes,
        conflicts,
        exclusions: plan.exclusions,
        transforms,
      },
    } satisfies StagingManifest;
  });

  /**
   * `git init` when needed, then one labelled commit until HEAD holds a
   * receipt: of the receipt and the files that still hold the source's bytes.
   * Retried on later runs if it never happened (interrupted, failed, no `.git`).
   */
  const commitBaseline = (
    root: string,
    receipt: MrMakImportReceipt,
    skipped: string,
  ): Effect.Effect<ImportContentResult["commit"]> =>
    Effect.gen(function* () {
      if (!(yield* fileSystem.exists(path.join(root, ".git")))) {
        yield* git.execute({ operation: "MrMakImport.init", cwd: root, args: ["init", "-q"] });
      }
      const baseline = yield* git.execute({
        operation: "MrMakImport.baseline",
        cwd: root,
        args: ["cat-file", "-e", `HEAD:${RECEIPT_PATH}`],
        allowNonZeroExit: true,
      });
      if (baseline.exitCode === 0) return { status: "skipped", detail: skipped } as const;
      const paths: Array<string> = [];
      for (const file of receipt.files) {
        if (!BASELINE_OUTCOMES.has(file.outcome)) continue;
        const current = yield* inspect(root, file.path);
        if ("sha256" in current && current.sha256 === file.destinationSha256) {
          paths.push(file.path);
        }
      }
      const stdin = [...paths, RECEIPT_PATH, GITIGNORE_PATH]
        .map((filePath) => `${filePath}\0`)
        .join("");
      // Literal: an imported name such as `docs/[d].md` must not match `docs/d.md`.
      const pathspec = ["--pathspec-from-file=-", "--pathspec-file-nul"];
      yield* git.execute({
        operation: "MrMakImport.add",
        cwd: root,
        args: ["--literal-pathspecs", "add", "--force", ...pathspec],
        stdin,
      });
      const message =
        `Import Mr. Mak original content (DevGame import)\n\n` +
        `Unmodified copy of the source at ${receipt.source.revision}, committed by DevGame\n` +
        `as the comparison baseline. Receipt: ${RECEIPT_PATH} (import ${receipt.importId}).\n`;
      const result = yield* git.execute({
        operation: "MrMakImport.commit",
        cwd: root,
        args: ["--literal-pathspecs", "commit", "-q", "-m", message, ...pathspec],
        stdin,
        allowNonZeroExit: true,
        timeoutMs: 60_000,
      });
      return result.exitCode === 0
        ? ({ status: "committed", detail: null } as const)
        : ({ status: "failed", detail: result.stderr.trim() } as const);
    }).pipe(
      Effect.catch((error) => Effect.succeed({ status: "failed", detail: error.message } as const)),
    );

  const importContent = Effect.fn("MrMakImport.importContent")(function* (
    request: ImportContentRequest,
  ) {
    const { plan } = request;
    const choices = request.choices ?? {};
    const sourceRoot = yield* fileSystem.realPath(plan.source.repositoryPath);
    const root = yield* resolveDestination(request.destinationRoot, sourceRoot);
    const fail = (reason: MrMakImportApplyError["reason"], detail: string) =>
      new MrMakImportApplyError({ reason, destinationRoot: root, detail });
    for (const entry of plan.entries) {
      if (!isPlainRelativePath(entry.destinationPath)) {
        return yield* fail("unsafe-path", entry.destinationPath);
      }
    }
    const importId = sha256(
      [
        plan.source.revision,
        ...plan.entries
          .map((entry) => `file\0${entry.destinationPath}\0${entry.sha256}`)
          .toSorted(),
        ...Object.entries(choices)
          .map(([choicePath, choice]) => `choice\0${choicePath}\0${choice}`)
          .toSorted(),
      ].join("\n"),
    ).slice(0, 16);
    const receiptPath = path.join(root, RECEIPT_PATH);
    const stagingRoot = `${IMPORT_DIRECTORY}/staging`;
    yield* ensureDirectory(root, stagingRoot);

    const previous = Option.getOrNull(yield* readJson(receiptPath, decodeReceipt));
    const unchanged = Effect.fn("importContent.unchanged")(function* (receipt: MrMakImportReceipt) {
      const detail = "Nothing changed since the last import.";
      return {
        status: "unchanged",
        receiptPath,
        receipt,
        commit: yield* commitBaseline(root, receipt, detail),
      } satisfies ImportContentResult;
    });
    if (previous?.importId === importId) {
      yield* finishStaging(root, importId);
      return yield* unchanged(previous);
    }
    const pending = (yield* fileSystem.readDirectory(path.join(root, stagingRoot))).find(
      (name) => name !== importId,
    );
    if (pending !== undefined) return yield* fail("pending-import", pending);

    const stagingDirectory = path.join(root, stagingRoot, importId);
    const manifestPath = path.join(stagingDirectory, "manifest.json");
    const resumed = Option.getOrNull(yield* readJson(manifestPath, decodeManifest));
    const manifest =
      resumed ?? (yield* classify(root, plan, choices, importId, previous, request.rewrites ?? {}));
    if (resumed === null) {
      // Same source and nothing to write: choices that no longer matter do not make a new import.
      if (
        previous !== null &&
        previous.source.revision === plan.source.revision &&
        manifest.writes.length === 0 &&
        manifest.receipt.changes.length === 0
      ) {
        return yield* unchanged(previous);
      }
      yield* writeAtomically(manifestPath, encodeManifest(manifest));
    }

    // Stage every write, then move each into place. A resumed import skips what already landed.
    const filesRoot = path.join(stagingDirectory, "files");
    const landed = (state: DestinationState, write: StagedWrite) =>
      state.kind === (write.symlink ? "symlink" : "file") &&
      "sha256" in state &&
      state.sha256 === write.sha256;
    for (const write of manifest.writes) {
      if (landed(yield* inspect(root, write.path), write)) continue;
      if (landed(yield* inspect(filesRoot, write.path), write)) continue;
      const bytes = yield* readBlob(sourceRoot, write, root);
      yield* ensureDirectory(stagingDirectory, `files/${posix.dirname(write.path)}`);
      const staged = path.join(filesRoot, write.path);
      yield* fileSystem.remove(staged, { force: true });
      if (write.symlink) yield* fileSystem.symlink(bytes.toString("utf8"), staged);
      else yield* fileSystem.writeFile(staged, bytes);
    }
    yield* fileSystem.writeFileString(path.join(stagingDirectory, STAGED_MARKER), "");
    for (const write of manifest.writes) {
      const current = yield* inspect(root, write.path);
      if (landed(current, write)) continue;
      if (write.executable) yield* fileSystem.chmod(path.join(filesRoot, write.path), 0o755);
      yield* ensureDirectory(root, posix.dirname(write.path));
      const target = path.join(root, write.path);
      if (current.kind !== "absent") {
        if (!("sha256" in current) || current.sha256 !== write.replaces) {
          return yield* fail("destination-changed", write.path);
        }
        yield* ensureDirectory(stagingDirectory, `replaced/${posix.dirname(write.path)}`);
        yield* fileSystem.rename(target, path.join(stagingDirectory, "replaced", write.path));
      }
      yield* fileSystem.rename(path.join(filesRoot, write.path), target);
    }

    const completedAt = yield* nowIso;
    const skills = request.summarizeSkills ? yield* request.summarizeSkills(root) : undefined;
    const receipt: MrMakImportReceipt = {
      ...manifest.receipt,
      completedAt,
      ...(skills ? { skills } : {}),
    };
    if (!(yield* fileSystem.exists(path.join(root, GITIGNORE_PATH)))) {
      yield* writeAtomically(path.join(root, GITIGNORE_PATH), "staging/\nreplaced/\n");
    }
    yield* writeAtomically(receiptPath, encodeReceipt(receipt));
    yield* finishStaging(root, importId);
    const commit = yield* commitBaseline(
      root,
      receipt,
      "Later imports are left uncommitted for review.",
    );
    return { status: "imported", receiptPath, receipt, commit } satisfies ImportContentResult;
  });

  /** Undo an interrupted import: only files it moved in and nobody touched since. */
  const rollback = Effect.fn("MrMakImport.rollbackImport")(function* (input: {
    readonly destinationRoot: string;
    readonly importId: string;
  }) {
    const nothing = (destinationRoot: string) =>
      new MrMakImportApplyError({
        reason: "nothing-to-roll-back",
        destinationRoot,
        detail: input.importId,
      });
    const root = yield* resolveDestination(
      input.destinationRoot,
      null,
      nothing(input.destinationRoot),
    );
    const stagingDirectory = path.join(root, IMPORT_DIRECTORY, "staging", input.importId);
    const manifest = /^[0-9a-f]{16}$/.test(input.importId)
      ? Option.getOrNull(
          yield* readJson(path.join(stagingDirectory, "manifest.json"), decodeManifest),
        )
      : null;
    if (manifest === null) return yield* nothing(root);
    // A published receipt means the import completed; only its staging cleanup was cut short.
    const receipt = yield* readJson(path.join(root, RECEIPT_PATH), decodeReceipt);
    if (Option.isSome(receipt) && receipt.value.importId === input.importId) {
      return yield* nothing(root);
    }
    // Moves start only once every write is staged; before that, nothing landed.
    const moving = yield* fileSystem.exists(path.join(stagingDirectory, STAGED_MARKER));
    const removed: Array<string> = [];
    const restored: Array<string> = [];
    const kept: Array<string> = [];
    for (const write of manifest.writes.toReversed()) {
      const target = path.join(root, write.path);
      const staged = yield* inspect(path.join(stagingDirectory, "files"), write.path);
      const current = yield* inspect(root, write.path);
      const ours =
        current.kind === (write.symlink ? "symlink" : "file") &&
        "sha256" in current &&
        current.sha256 === write.sha256;
      const moved = moving && staged.kind === "absent";
      if (moved && ours) {
        yield* fileSystem.remove(target);
        removed.push(write.path);
      } else if (moved && current.kind !== "absent") {
        kept.push(write.path);
      }
      const backup = path.join(stagingDirectory, "replaced", write.path);
      const backupState = yield* inspect(path.join(stagingDirectory, "replaced"), write.path);
      if (backupState.kind !== "absent" && (yield* inspect(root, write.path)).kind === "absent") {
        yield* fileSystem.rename(backup, target);
        restored.push(write.path);
      }
    }
    for (const directory of manifest.createdDirectories.toSorted((a, b) => b.length - a.length)) {
      const absolute = path.join(root, directory);
      const children = yield* fileSystem.readDirectory(absolute).pipe(notFound(null));
      if (children !== null && children.length === 0)
        yield* fileSystem.remove(absolute, { recursive: true });
    }
    yield* finishStaging(root, input.importId);
    return { removed, restored, kept } satisfies RollbackImportResult;
  });

  const asApplyError =
    (destinationRoot: string) =>
    <A, E, R>(effect: Effect.Effect<A, E | MrMakImportApplyError, R>) =>
      effect.pipe(
        Effect.mapError((error) =>
          isApplyError(error)
            ? error
            : new MrMakImportApplyError({
                reason: "filesystem",
                destinationRoot,
                detail: error instanceof Error ? error.message : String(error),
                cause: error,
              }),
        ),
      );

  return {
    importContent: (request: ImportContentRequest) =>
      importContent(request).pipe(asApplyError(request.destinationRoot)),
    rollback: (input: { readonly destinationRoot: string; readonly importId: string }) =>
      rollback(input).pipe(asApplyError(input.destinationRoot)),
  };
});
