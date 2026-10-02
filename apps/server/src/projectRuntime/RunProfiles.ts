/**
 * RunProfiles - Effect service that reads a game project's run profiles
 * (`devgame.runtime.json`) and turns one into a launch plan.
 *
 * READ-ONLY and spawn-free. Nothing here writes to the project or starts a
 * process; the runner spawns `absExecutable` with `args` and no shell.
 *
 * A plan is exactly what the profile says: the executable it names, its
 * literal argv and its cwd. Nothing is interpolated, and no build or install
 * step is ever added, so launching a profile runs the existing build as is.
 *
 * Every path is checked lexically (no absolute paths, no `..`) and by
 * realpath against the project root, so a symlink cannot point a profile at
 * a file outside the project.
 *
 * @module RunProfiles
 */
import {
  RUN_PROFILES_FILE_NAME,
  RunProfilesFile,
  type RunProfile,
  type RunProfileIssue,
  type RunProfileOutput,
} from "@t3tools/contracts";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";

const decodeRunProfilesJson = Schema.decodeUnknownEffect(fromLenientJson(RunProfilesFile));

export class RunProfilesMalformed extends Schema.TaggedError<RunProfilesMalformed>()(
  "RunProfilesMalformed",
  {
    reason: Schema.Literals(["malformed", "truncated", "escape", "read"]),
    workspaceRoot: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "malformed":
        return `${RUN_PROFILES_FILE_NAME} is not a valid run-profile file: ${this.detail}`;
      case "truncated":
        return `${RUN_PROFILES_FILE_NAME} is larger than 1 MiB and was not read.`;
      case "escape":
        return `${RUN_PROFILES_FILE_NAME} resolves outside the project root.`;
      case "read":
        return `Could not read ${RUN_PROFILES_FILE_NAME}: ${this.detail}`;
    }
  }
}

export class RunProfileNotFound extends Schema.TaggedError<RunProfileNotFound>()(
  "RunProfileNotFound",
  { profileId: Schema.String },
) {
  override get message(): string {
    return `No run profile with id "${this.profileId}" in ${RUN_PROFILES_FILE_NAME}.`;
  }
}

export class RunProfilePathEscape extends Schema.TaggedError<RunProfilePathEscape>()(
  "RunProfilePathEscape",
  {
    profileId: Schema.String,
    field: Schema.Literals(["executable", "cwd", "output"]),
    path: Schema.String,
  },
) {
  override get message(): string {
    return `Run profile "${this.profileId}": ${this.field} "${this.path}" is not inside the project root.`;
  }
}

export class RunProfileExecutableMissing extends Schema.TaggedError<RunProfileExecutableMissing>()(
  "RunProfileExecutableMissing",
  { profileId: Schema.String, executable: Schema.String },
) {
  override get message(): string {
    return `Run profile "${this.profileId}": executable "${this.executable}" does not exist. Build it first.`;
  }
}

export class RunProfileExecutableNotExecutable extends Schema.TaggedError<RunProfileExecutableNotExecutable>()(
  "RunProfileExecutableNotExecutable",
  { profileId: Schema.String, executable: Schema.String },
) {
  override get message(): string {
    return `Run profile "${this.profileId}": "${this.executable}" is not an executable file.`;
  }
}

/** Any other reason a profile cannot launch: see the issue kinds. */
export class RunProfileInvalid extends Schema.TaggedError<RunProfileInvalid>()(
  "RunProfileInvalid",
  { profileId: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `Run profile "${this.profileId}" cannot launch: ${this.detail}`;
  }
}

export type RunProfileResolveError =
  | RunProfilesMalformed
  | RunProfileNotFound
  | RunProfilePathEscape
  | RunProfileExecutableMissing
  | RunProfileExecutableNotExecutable
  | RunProfileInvalid;

/** A decoded profile and whether it can launch as written. */
export interface RunProfileStatus {
  readonly profile: RunProfile;
  readonly valid: boolean;
  readonly issues: ReadonlyArray<RunProfileIssue>;
}

/** What the runner spawns: no shell, no build step, argv passed through untouched. */
export interface LaunchPlan {
  readonly profileId: string;
  readonly absExecutable: string;
  readonly args: ReadonlyArray<string>;
  readonly absCwd: string;
  readonly envAllowList: ReadonlyArray<string>;
  readonly outputs: ReadonlyArray<RunProfileOutput & { readonly absPath: string }>;
  readonly logPatterns: ReadonlyArray<string>;
}

/** Service tag for reading run profiles and resolving launch plans. */
export class RunProfiles extends Context.Service<
  RunProfiles,
  {
    /**
     * Read and validate `<workspaceRoot>/devgame.runtime.json`.
     *
     * A missing file is an empty list. A file that cannot be read or decoded
     * fails with {@link RunProfilesMalformed}. A profile that decodes but
     * cannot launch is still listed, with `valid: false` and its issues.
     */
    readonly load: (
      workspaceRoot: string,
    ) => Effect.Effect<ReadonlyArray<RunProfileStatus>, RunProfilesMalformed>;
    /** The launch plan for one valid profile, or a typed reason it cannot launch. */
    readonly resolve: (
      workspaceRoot: string,
      profileId: string,
    ) => Effect.Effect<LaunchPlan, RunProfileResolveError>;
  }
>()("t3/projectRuntime/RunProfiles") {}

const errnoCode = (cause: unknown): string | undefined =>
  typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
    ? cause.code
    : undefined;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const isValidRegExp = (pattern: string) => {
  try {
    return Boolean(new RegExp(pattern));
  } catch {
    return false;
  }
};
const ANY_EXECUTE_BIT = 0o111;

type Checked =
  | { readonly _tag: "escape" }
  | { readonly _tag: "missing"; readonly absPath: string }
  | { readonly _tag: "ok"; readonly absPath: string; readonly realPath: string };

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;

  const malformed = (workspaceRoot: string, reason: RunProfilesMalformed["reason"], detail = "") =>
    new RunProfilesMalformed({ reason, workspaceRoot, detail });

  const readProfilesText = (workspaceRoot: string) =>
    workspaceFileSystem
      // Always the literal relative name: an absolute path would skip the root check.
      .readFile({ cwd: workspaceRoot, relativePath: RUN_PROFILES_FILE_NAME })
      .pipe(
        Effect.catchTags({
          WorkspaceFileSystemOperationError: (error) => {
            const code = errnoCode(error.cause);
            return error.operation === "realpath-target" &&
              (code === "ENOENT" || code === "ENOTDIR")
              ? Effect.succeed(null)
              : Effect.fail(malformed(workspaceRoot, "read", code ?? error.operation));
          },
          WorkspaceFilePathEscapeError: () => Effect.fail(malformed(workspaceRoot, "escape")),
          WorkspacePathOutsideRootError: () => Effect.fail(malformed(workspaceRoot, "escape")),
          WorkspacePathNotFileError: () =>
            Effect.fail(malformed(workspaceRoot, "malformed", "not a regular file")),
          WorkspaceBinaryFileError: () =>
            Effect.fail(malformed(workspaceRoot, "malformed", "binary content")),
        }),
      );

  const isOutside = (realRoot: string, realTarget: string) => {
    const relative = path.relative(realRoot, realTarget);
    return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  };

  /** Lexical then realpath containment. `.` (the root itself) only when allowed. */
  const checkPath = Effect.fn("RunProfiles.checkPath")(function* (
    roots: { workspaceRoot: string; realRoot: string },
    relativePath: string,
    allowRoot: boolean,
  ) {
    const trimmed = relativePath.trim();
    let absPath: string;
    if (allowRoot && (trimmed === "" || trimmed === "." || trimmed === "./")) {
      absPath = roots.workspaceRoot;
    } else {
      const lexical = yield* workspacePaths
        .resolveRelativePathWithinRoot({ workspaceRoot: roots.workspaceRoot, relativePath })
        .pipe(Effect.option);
      if (lexical._tag === "None") return { _tag: "escape" } satisfies Checked;
      absPath = lexical.value.absolutePath;
    }
    const real = yield* fileSystem.realPath(absPath).pipe(Effect.result);
    if (real._tag === "Failure") return { _tag: "missing", absPath } satisfies Checked;
    if (isOutside(roots.realRoot, real.success)) return { _tag: "escape" } satisfies Checked;
    return { _tag: "ok", absPath, realPath: real.success } satisfies Checked;
  });

  /** An output need not exist yet; its nearest existing ancestor must resolve inside the root. */
  const checkOutputPath = Effect.fn("RunProfiles.checkOutputPath")(function* (
    roots: { workspaceRoot: string; realRoot: string },
    relativePath: string,
  ) {
    const checked = yield* checkPath(roots, relativePath, false);
    if (checked._tag !== "missing") return checked;
    let ancestor = path.dirname(checked.absPath);
    while (true) {
      const real = yield* fileSystem.realPath(ancestor).pipe(Effect.result);
      if (real._tag === "Success") {
        return isOutside(roots.realRoot, real.success) ? ({ _tag: "escape" } as const) : checked;
      }
      // The lexical check guarantees the walk reaches the root, whose realpath is known.
      if (ancestor === roots.workspaceRoot || ancestor === path.dirname(ancestor)) return checked;
      ancestor = path.dirname(ancestor);
    }
  });

  const validateProfile = Effect.fn("RunProfiles.validateProfile")(function* (
    profile: RunProfile,
    roots: { workspaceRoot: string; realRoot: string },
    duplicate: boolean,
  ) {
    const issues: Array<RunProfileIssue> = [];
    if (duplicate) {
      issues.push({
        kind: "duplicate-id",
        message: `Profile id "${profile.id}" is already used by an earlier profile.`,
      });
    }

    const executable = yield* checkPath(roots, profile.executable, false);
    if (executable._tag === "escape") {
      issues.push({
        kind: "executable-escape",
        message: `Executable "${profile.executable}" is not inside the project root.`,
      });
    } else if (executable._tag === "missing") {
      issues.push({
        kind: "executable-missing",
        message: `Executable "${profile.executable}" does not exist. Build it first.`,
      });
    } else {
      const stat = yield* fileSystem.stat(executable.realPath).pipe(Effect.option);
      if (
        stat._tag === "None" ||
        stat.value.type !== "File" ||
        (stat.value.mode & ANY_EXECUTE_BIT) === 0
      ) {
        issues.push({
          kind: "executable-not-executable",
          message: `"${profile.executable}" is not an executable file.`,
        });
      }
    }

    const cwdPath = profile.cwd ?? ".";
    const cwd = yield* checkPath(roots, cwdPath, true);
    if (cwd._tag === "escape") {
      issues.push({
        kind: "cwd-escape",
        message: `cwd "${cwdPath}" is not inside the project root.`,
      });
    } else {
      const stat =
        cwd._tag === "ok" ? yield* fileSystem.stat(cwd.realPath).pipe(Effect.option) : null;
      if (stat === null || stat._tag === "None" || stat.value.type !== "Directory") {
        issues.push({ kind: "cwd-missing", message: `cwd "${cwdPath}" is not a directory.` });
      }
    }

    for (const name of profile.envAllowList ?? []) {
      if (!ENV_NAME.test(name)) {
        issues.push({
          kind: "env-name-invalid",
          message: `"${name}" is not an environment variable name.`,
        });
      }
    }

    const outputs: Array<RunProfileOutput & { absPath: string }> = [];
    let escapedOutputPath: string | null = null;
    const outputNames = new Set<string>();
    for (const output of profile.outputs ?? []) {
      if (outputNames.has(output.name)) {
        issues.push({
          kind: "output-name-duplicate",
          message: `Output name "${output.name}" is used more than once.`,
        });
      }
      outputNames.add(output.name);
      const checked = yield* checkOutputPath(roots, output.path);
      if (checked._tag === "escape") {
        escapedOutputPath ??= output.path;
        issues.push({
          kind: "output-escape",
          message: `Output "${output.name}" path "${output.path}" is not inside the project root.`,
        });
      } else {
        outputs.push({ ...output, absPath: checked.absPath });
      }
    }

    const logPatterns = profile.evidence?.logPatterns ?? [];
    for (const pattern of logPatterns) {
      if (!isValidRegExp(pattern)) {
        issues.push({
          kind: "log-pattern-invalid",
          message: `Log pattern "${pattern}" is not a valid regular expression.`,
        });
      }
    }

    const plan: LaunchPlan | null =
      issues.length === 0 && executable._tag === "ok" && cwd._tag === "ok"
        ? {
            profileId: profile.id,
            absExecutable: executable.absPath,
            args: profile.args,
            absCwd: cwd.absPath,
            envAllowList: profile.envAllowList ?? [],
            outputs,
            logPatterns,
          }
        : null;
    return { status: { profile, valid: issues.length === 0, issues }, plan, escapedOutputPath };
  });

  const loadWithPlans = Effect.fn("RunProfiles.loadWithPlans")(function* (rawRoot: string) {
    const workspaceRoot = path.resolve(rawRoot);
    const file = yield* readProfilesText(workspaceRoot);
    if (file === null) return [];
    if (file.truncated) {
      return yield* malformed(workspaceRoot, "truncated", `${file.byteLength} bytes`);
    }
    const decoded = yield* decodeRunProfilesJson(file.contents).pipe(
      Effect.mapError((error) => malformed(workspaceRoot, "malformed", error.message)),
    );
    // readFile already resolved the root, so this only fails on a race.
    const realRoot = yield* fileSystem
      .realPath(workspaceRoot)
      .pipe(Effect.mapError((error) => malformed(workspaceRoot, "read", error.message)));

    const seenIds = new Set<string>();
    const results = [];
    for (const profile of decoded.profiles) {
      results.push(
        yield* validateProfile(profile, { workspaceRoot, realRoot }, seenIds.has(profile.id)),
      );
      seenIds.add(profile.id);
    }
    return results;
  });

  const load: RunProfiles["Service"]["load"] = (workspaceRoot) =>
    loadWithPlans(workspaceRoot).pipe(
      Effect.map((results) => results.map((result) => result.status)),
    );

  const resolve: RunProfiles["Service"]["resolve"] = Effect.fn("RunProfiles.resolve")(
    function* (workspaceRoot, profileId) {
      const results = yield* loadWithPlans(workspaceRoot);
      // The first profile with the id wins; later duplicates are flagged invalid.
      const found = results.find((result) => result.status.profile.id === profileId);
      if (found === undefined) return yield* new RunProfileNotFound({ profileId });
      if (found.plan !== null) return found.plan;

      const { profile, issues } = found.status;
      const kinds = new Set(issues.map((issue) => issue.kind));
      if (kinds.has("executable-escape")) {
        return yield* new RunProfilePathEscape({
          profileId,
          field: "executable",
          path: profile.executable,
        });
      }
      if (kinds.has("cwd-escape")) {
        return yield* new RunProfilePathEscape({
          profileId,
          field: "cwd",
          path: profile.cwd ?? ".",
        });
      }
      if (found.escapedOutputPath !== null) {
        return yield* new RunProfilePathEscape({
          profileId,
          field: "output",
          path: found.escapedOutputPath,
        });
      }
      if (kinds.has("executable-missing")) {
        return yield* new RunProfileExecutableMissing({
          profileId,
          executable: profile.executable,
        });
      }
      if (kinds.has("executable-not-executable")) {
        return yield* new RunProfileExecutableNotExecutable({
          profileId,
          executable: profile.executable,
        });
      }
      return yield* new RunProfileInvalid({
        profileId,
        detail: issues.map((issue) => issue.message).join(" "),
      });
    },
  );

  return RunProfiles.of({ load, resolve });
});

export const layer = Layer.effect(RunProfiles, make);
