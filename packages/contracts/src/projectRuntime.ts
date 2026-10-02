import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

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
   * Names of server environment variables the child may inherit. Omitted or
   * empty means the child inherits none of them. Names that look like secrets
   * (`*TOKEN*`, `*SECRET*`, `*_KEY`, ...) or loader variables (`DYLD_*`,
   * `LD_*`, `NODE_OPTIONS`) are refused.
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
