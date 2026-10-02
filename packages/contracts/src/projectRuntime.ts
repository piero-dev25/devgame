import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Project run profiles: `devgame.runtime.json` at a game project's root, a
 * sibling of `devgame.json`. Fork-owned and kept out of `devgame.json`, whose
 * schema is shared with upstream and published.
 *
 * A profile launches an existing executable directly. There is no shell: the
 * executable is spawned with `args` exactly as written, so `;`, `$HOME`,
 * quotes and spaces are passed through literally and never interpolated. A
 * profile never builds or installs anything; a build is its own profile with
 * the build tool as its executable.
 *
 * Every path is relative to the project root and must stay inside it.
 */

/** File name of the run-profile manifest, resolved at the project root. */
export const RUN_PROFILES_FILE_NAME = "devgame.runtime.json";

/** A file the run produces that DevGame should collect after it exits. */
export const RunProfileOutput = Schema.Struct({
  /** Unique within the profile, used to refer to the output in evidence. */
  name: TrimmedNonEmptyString,
  kind: Schema.Literals(["image", "log", "file"]),
  /** Project-root-relative. */
  path: Schema.String,
});
export type RunProfileOutput = typeof RunProfileOutput.Type;

export const RunProfile = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  /** Project-root-relative path of an existing executable file. */
  executable: Schema.String,
  /** Literal argv after the executable. Never trimmed, split or interpolated. */
  args: Schema.Array(Schema.String),
  /** Project-root-relative working directory. Defaults to the root (`.`). */
  cwd: Schema.optionalKey(Schema.String),
  /**
   * Names of server environment variables the child may inherit, on top of
   * `PATH` and `HOME`, which every run gets (programs and `#!/usr/bin/env`
   * scripts need them to start). Omitted or empty means only those two.
   * Names that look like secrets (`*TOKEN*`, `*SECRET*`, `*_KEY`, ...) or
   * loader variables (`DYLD_*`, `LD_*`, `NODE_OPTIONS`) are refused.
   */
  envAllowList: Schema.optionalKey(Schema.Array(Schema.String)),
  outputs: Schema.optionalKey(Schema.Array(RunProfileOutput)),
  /**
   * Regular expressions a successful run's log must match. The log is the
   * child's stdout and stderr, which the runner records; the runner also
   * creates each output's parent directory before the run.
   */
  evidence: Schema.optionalKey(Schema.Struct({ logPatterns: Schema.Array(Schema.String) })),
});
export type RunProfile = typeof RunProfile.Type;

export const RunProfilesFile = Schema.Struct({
  version: Schema.Literal(1),
  profiles: Schema.Array(RunProfile),
});
export type RunProfilesFile = typeof RunProfilesFile.Type;

/**
 * Why a profile that decoded cannot be launched:
 * - `*-escape`: the path is absolute, climbs out of the project root, or is a
 *   symlink whose target lies outside it. An output path through a dangling
 *   symlink also counts, since writing it would follow the link.
 * - `executable-missing`: nothing exists at the executable path.
 * - `executable-not-executable`: the path is not a regular file the server
 *   user may execute.
 * - `cwd-missing`: the working directory does not exist or is not a directory.
 * - `duplicate-id`: an earlier profile already uses this id.
 * - `env-name-invalid`: not a variable name, or a refused secret or loader
 *   variable (see `envAllowList`).
 * - `output-name-duplicate`, `log-pattern-invalid`: a field is present but
 *   unusable as written.
 */
export const RunProfileIssueKind = Schema.Literals([
  "executable-escape",
  "executable-missing",
  "executable-not-executable",
  "cwd-escape",
  "cwd-missing",
  "output-escape",
  "duplicate-id",
  "env-name-invalid",
  "output-name-duplicate",
  "log-pattern-invalid",
]);
export type RunProfileIssueKind = typeof RunProfileIssueKind.Type;

export const RunProfileIssue = Schema.Struct({
  kind: RunProfileIssueKind,
  message: Schema.String,
});
export type RunProfileIssue = typeof RunProfileIssue.Type;

// ---------------------------------------------------------------------------
// `POST /api/project-runtime/{start,stop,status}`: launch, stop and watch a
// project's run profiles. Same Input/Result/PATH trios as
// `ProjectWorkspaceReadInput`. The client sends only the opaque projectId; the
// server resolves the project's canonical root. Runs live in the server's
// memory: after a restart the list is empty and no earlier process is adopted.
// ---------------------------------------------------------------------------

/**
 * - `starting`: reserved, the process is being spawned.
 * - `running`: the process was spawned and has not exited.
 * - `exited`: it exited on its own (`exitCode`, or `signal` if something else killed it).
 * - `stopped`: it exited after a stop request or server shutdown.
 * - `launchFailed`: it never started; `error` says why.
 */
export const RunStatusKind = Schema.Literals([
  "starting",
  "running",
  "exited",
  "stopped",
  "launchFailed",
]);
export type RunStatusKind = typeof RunStatusKind.Type;

export const RunState = Schema.Struct({
  runId: TrimmedNonEmptyString,
  profileId: Schema.String,
  threadId: Schema.NullOr(ThreadId),
  status: RunStatusKind,
  /** The process id captured at spawn; it is also the process-group id. */
  pid: Schema.NullOr(Schema.Number),
  exitCode: Schema.NullOr(Schema.Number),
  signal: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  startedAt: IsoDateTime,
  endedAt: Schema.NullOr(IsoDateTime),
  /** The last few KiB of combined stdout and stderr. The full log stays on the server. */
  logTail: Schema.String,
});
export type RunState = typeof RunState.Type;

const RunError = Schema.TaggedStruct("error", { message: Schema.String });

export const RunStartInput = Schema.Struct({
  projectId: ProjectId,
  profileId: TrimmedNonEmptyString,
  /** The thread that asked for the run. Must belong to `projectId`. */
  threadId: Schema.optionalKey(ThreadId),
});
export type RunStartInput = typeof RunStartInput.Type;

/** `alreadyRunning`: the profile was running, so nothing new was started and `run` is that run. */
export const RunStartSuccess = Schema.Struct({ run: RunState, alreadyRunning: Schema.Boolean });
export type RunStartSuccess = typeof RunStartSuccess.Type;

export const RunStartResult = Schema.Union([RunStartSuccess, RunError]);
export type RunStartResult = typeof RunStartResult.Type;

export const RunStopInput = Schema.Struct({
  projectId: ProjectId,
  runId: TrimmedNonEmptyString,
});
export type RunStopInput = typeof RunStopInput.Type;

/** The run after the stop. Stopping a run that already ended returns it unchanged. */
export const RunStopSuccess = Schema.Struct({ run: RunState });
export type RunStopSuccess = typeof RunStopSuccess.Type;

export const RunStopResult = Schema.Union([RunStopSuccess, RunError]);
export type RunStopResult = typeof RunStopResult.Type;

export const RunStatusInput = Schema.Struct({ projectId: ProjectId });
export type RunStatusInput = typeof RunStatusInput.Type;

export const RunProfileSummary = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  valid: Schema.Boolean,
  issues: Schema.Array(RunProfileIssue),
});
export type RunProfileSummary = typeof RunProfileSummary.Type;

/**
 * The project's profiles and this server's runs of them, newest first.
 * `profilesError` is set when `devgame.runtime.json` cannot be read; the runs
 * are listed either way.
 */
export const RunStatusSuccess = Schema.Struct({
  profiles: Schema.Array(RunProfileSummary),
  profilesError: Schema.NullOr(Schema.String),
  runs: Schema.Array(RunState),
});
export type RunStatusSuccess = typeof RunStatusSuccess.Type;

export const RunStatusResult = Schema.Union([RunStatusSuccess, RunError]);
export type RunStatusResult = typeof RunStatusResult.Type;

/** Under `/api` so single-origin dev already proxies them (see devProxy.ts). */
export const PROJECT_RUNTIME_START_PATH = "/api/project-runtime/start";
export const PROJECT_RUNTIME_STOP_PATH = "/api/project-runtime/stop";
export const PROJECT_RUNTIME_STATUS_PATH = "/api/project-runtime/status";
