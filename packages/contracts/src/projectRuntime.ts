import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Project run profiles: `devgame.runtime.json` at a game project's root, a
 * sibling of `devgame.json`. Fork-owned and kept out of `devgame.json`, whose
 * schema is shared with upstream and published.
 *
 * A profile launches an existing executable directly. There is no shell: the
 * executable is spawned with `args` exactly as written, so `;`, `$HOME`,
 * quotes and spaces are passed through literally and never interpolated; the
 * only substitution is {@link RUN_DIR_TOKEN}. A profile never builds or
 * installs anything; a build is its own profile with the build tool as its
 * executable.
 *
 * Every path is relative to the project root and must stay inside it, except
 * an output under {@link RUN_DIR_TOKEN}.
 */

/** File name of the run-profile manifest, resolved at the project root. */
export const RUN_PROFILES_FILE_NAME = "devgame.runtime.json";

/**
 * The one substitution a profile gets. Wherever an argument or an output path
 * contains this exact text, the runner puts the run's own absolute directory
 * under the DevGame state directory (`<stateDir>/runs/<projectId>/<runId>`).
 * Each run then writes its captures to a fresh place outside the project.
 * Nothing else in `args` is ever interpolated.
 */
export const RUN_DIR_TOKEN = "{{runDir}}";

/** A file the run produces that DevGame should collect after it exits. */
export const RunProfileOutput = Schema.Struct({
  /** Unique within the profile, used to refer to the output in evidence. */
  name: TrimmedNonEmptyString,
  kind: Schema.Literals(["image", "log", "file"]),
  /** Project-root-relative, or `{{runDir}}/<relative path>` for a file in the run's own directory. */
  path: Schema.String,
});
export type RunProfileOutput = typeof RunProfileOutput.Type;

export const RunProfile = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  /** Project-root-relative path of an existing executable file. */
  executable: Schema.String,
  /** Literal argv after the executable. Never trimmed, split or interpolated, except `{{runDir}}`. */
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
   * Present when every run of the profile should be recorded as evidence
   * (declaring outputs also turns recording on). `logPatterns` are regular
   * expressions a successful run's log must match. The log is the child's
   * stdout and stderr, which the runner records; the runner also creates each
   * output's parent directory before the run.
   */
  evidence: Schema.optionalKey(
    Schema.Struct({
      logPatterns: Schema.Array(Schema.String),
      /**
       * Project-root-relative path of the build the run exercises, fingerprinted
       * at launch and compared on every read. Defaults to the executable; set it
       * when the executable is a wrapper script around the real build.
       */
      build: Schema.optionalKey(Schema.String),
      /** The workspace card (and optionally its step, by `path`) this profile's runs belong to. */
      workspaceCard: Schema.optionalKey(
        Schema.Struct({
          entityId: TrimmedNonEmptyString,
          stepPath: Schema.optionalKey(Schema.String),
        }),
      ),
    }),
  ),
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
 * - `build-escape`: `evidence.build` is not inside the project root.
 */
export const RunProfileIssueKind = Schema.Literals([
  "executable-escape",
  "build-escape",
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

// ---------------------------------------------------------------------------
// Run evidence: what a finished run of an evidence profile showed. The server
// keeps one record per run in a DevGame-owned registry in its state directory,
// never in the project and never in `workspace/workspace.json`.
// ---------------------------------------------------------------------------

export const RUN_EVIDENCE_SCHEMA = "devgame.run-evidence/1";

/** Provenance DevGame could not establish. Never replaced by a guess. */
const Unknown = Schema.Literal("unknown");

/**
 * The project's source at launch: `git rev-parse HEAD`, and whether tracked
 * files had uncommitted changes (untracked files do not count).
 */
export const RunSourceProvenance = Schema.Struct({
  revision: Schema.Union([Unknown, Schema.String]),
  dirty: Schema.Union([Unknown, Schema.Boolean]),
});
export type RunSourceProvenance = typeof RunSourceProvenance.Type;

/** The build at launch. Builds are often gitignored, so it is fingerprinted, not versioned. */
export const RunBuildProvenance = Schema.Struct({
  /** Project-root-relative. */
  path: Schema.String,
  bytes: Schema.Union([Unknown, Schema.Number]),
  mtime: Schema.Union([Unknown, Schema.String]),
  sha256: Schema.Union([Unknown, Schema.String]),
});
export type RunBuildProvenance = typeof RunBuildProvenance.Type;

export const RunEvidenceArtifact = Schema.Struct({
  name: Schema.String,
  kind: Schema.Literals(["image", "log", "file"]),
  /** `project`: `path` is project-root-relative. `run`: it is relative to the run's directory. */
  location: Schema.Literals(["project", "run"]),
  path: Schema.String,
  absolutePath: Schema.String,
  exists: Schema.Boolean,
  bytes: Schema.NullOr(Schema.Number),
  sha256: Schema.NullOr(Schema.String),
  /** Why the artifact does not count (missing, empty, not a file, resolves elsewhere), or null. */
  problem: Schema.NullOr(Schema.String),
});
export type RunEvidenceArtifact = typeof RunEvidenceArtifact.Type;

/** The run log: the program's stdout and stderr, which `logPatterns` are checked against. */
export const RunEvidenceLog = Schema.Struct({
  absolutePath: Schema.String,
  exists: Schema.Boolean,
  bytes: Schema.NullOr(Schema.Number),
  /** Bytes the runner received from the program; more than `bytes` means the file lost some. */
  bytesReceived: Schema.Number,
  sha256: Schema.NullOr(Schema.String),
  /** Why the log cannot be trusted (missing, truncated), or null. */
  problem: Schema.NullOr(Schema.String),
});
export type RunEvidenceLog = typeof RunEvidenceLog.Type;

/**
 * One `logPatterns` entry checked against the log:
 * - `matched`: some line matches; `line` is the last one that does.
 * - `mismatch`: no line matches, but one starts like the pattern (its literal
 *   prefix, e.g. `VFX capture probe:`); `line` is the last such line, so a
 *   wrong capture age shows the age the program reported.
 * - `missing`: no line matches or starts like it.
 * - `log-unavailable`: there was no log to check.
 */
export const RunEvidenceLogCheck = Schema.Struct({
  pattern: Schema.String,
  status: Schema.Literals(["matched", "mismatch", "missing", "log-unavailable"]),
  line: Schema.NullOr(Schema.String),
});
export type RunEvidenceLogCheck = typeof RunEvidenceLogCheck.Type;

export const RunEvidenceRecord = Schema.Struct({
  schema: Schema.Literal(RUN_EVIDENCE_SCHEMA),
  runId: TrimmedNonEmptyString,
  projectId: ProjectId,
  profileId: Schema.String,
  threadId: Schema.NullOr(ThreadId),
  /** From the profile's `evidence.workspaceCard`; the card itself is never edited. */
  workspaceCard: Schema.NullOr(
    Schema.Struct({ entityId: Schema.String, stepPath: Schema.NullOr(Schema.String) }),
  ),
  source: RunSourceProvenance,
  build: RunBuildProvenance,
  startedAt: IsoDateTime,
  endedAt: IsoDateTime,
  registeredAt: IsoDateTime,
  runStatus: Schema.Literals(["exited", "stopped"]),
  exitCode: Schema.NullOr(Schema.Number),
  signal: Schema.NullOr(Schema.String),
  log: RunEvidenceLog,
  checks: Schema.Array(RunEvidenceLogCheck),
  artifacts: Schema.Array(RunEvidenceArtifact),
  /** `passed` only when the program exited 0 and every check and artifact holds. */
  outcome: Schema.Literals(["passed", "failed"]),
  /** Why the run failed, one sentence each; empty when it passed. */
  failures: Schema.Array(Schema.String),
});
export type RunEvidenceRecord = typeof RunEvidenceRecord.Type;

/**
 * A record with its freshness, computed each time it is read:
 * - `stale`: the project's HEAD, or the build's sha256, is not what the run
 *   used, or a run on a clean tree now has uncommitted changes in the tree.
 * - `unknown`: nothing DevGame could compare differs, but some provenance
 *   (then or now) is unknown, or the run used uncommitted changes, which
 *   cannot be compared afterwards.
 * - `fresh`: HEAD and build match, and the tree was and is clean.
 */
export const RunEvidenceView = Schema.Struct({
  record: RunEvidenceRecord,
  freshness: Schema.Literals(["fresh", "stale", "unknown"]),
  freshnessReasons: Schema.Array(Schema.String),
});
export type RunEvidenceView = typeof RunEvidenceView.Type;

/**
 * The project's profiles and this server's runs of them, newest first.
 * `profilesError` is set when `devgame.runtime.json` cannot be read; the runs
 * are listed either way. `evidence` holds the newest record per profile,
 * newest first; it is optional so a server without evidence still decodes.
 * `evidenceError` says why evidence cannot be shown or was not recorded (an
 * unreadable registry, a failed write), so missing evidence never looks like
 * evidence that was never captured.
 */
export const RunStatusSuccess = Schema.Struct({
  profiles: Schema.Array(RunProfileSummary),
  profilesError: Schema.NullOr(Schema.String),
  runs: Schema.Array(RunState),
  evidence: Schema.optionalKey(Schema.Array(RunEvidenceView)),
  evidenceError: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type RunStatusSuccess = typeof RunStatusSuccess.Type;

export const RunStatusResult = Schema.Union([RunStatusSuccess, RunError]);
export type RunStatusResult = typeof RunStatusResult.Type;

/** Under `/api` so single-origin dev already proxies them (see devProxy.ts). */
export const PROJECT_RUNTIME_START_PATH = "/api/project-runtime/start";
export const PROJECT_RUNTIME_STOP_PATH = "/api/project-runtime/stop";
export const PROJECT_RUNTIME_STATUS_PATH = "/api/project-runtime/status";
