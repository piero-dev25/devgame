// Contract for `POST /unity/cold-start` — task #92's cost analysis of the
// Unity setup flow's not-ready states found that "open Unity" (S5/S6) was
// already a fully built, tested, VERIFIED-live capability
// (`apps/server/src/editorPresence/UnityColdStart.ts`'s `unity open
// <projectRoot>` argv builder) with zero callers anywhere in the codebase.
// This is the wire contract for the first caller — see
// `apps/server/src/editorPresence/UnityColdStartRoute.ts` for the dispatch
// logic and `apps/server/src/unity/UnityPipelineClient.ts`'s `open` method
// for the actual CLI invocation.
//
// Same "server-resolved cwd, never caller-supplied" posture as
// `UnityPipelineInstallInput` (unityPipelineInstall.ts) — this server
// process is scoped to exactly one project (plan §1's F6), and there is no
// more reason for THIS route to accept a caller-supplied path than that one
// has.
import * as Schema from "effect/Schema";

import { UnityEditorStatus } from "./unity.ts";

/** Deliberately EMPTY — same reasoning as `UnityPipelineInstallInput`. */
export const UnityColdStartLaunchInput = Schema.Struct({});
export type UnityColdStartLaunchInput = typeof UnityColdStartLaunchInput.Type;

/** `unity open --json`'s successful outcome, restated minimally — see
 * `UnityPipelineClient.ts`'s `UnityPipelineOpenResult`/`open` doc comments
 * for why `launched` carries no fields parsed from the CLI's own `data`:
 * no live-captured sample exists yet for `unity open --json`'s success
 * payload (this round's task explicitly forbids launching a real Editor to
 * get one). `launched: true` is the honest boundary of what this contract
 * can promise on its own — the invocation was accepted, not that Unity has
 * finished opening, or even that it will.
 *
 * `confirmedStatus` is the separate, later-arriving fact from `open`'s own
 * bounded post-launch poll — `null` is the ORDINARY outcome for a
 * genuinely cold launch (the poll's budget is sized to catch the fast/
 * warm-reopen case, not a full cold boot; see
 * `COLD_START_CONFIRM_RETRY_ATTEMPTS`'s own doc comment), never treated as
 * an error. A non-null value is the same `UnityEditorStatus` shape
 * `UnityCommandResult`'s `ok` already carries for Play/Stop/Pause. */
export const UnityColdStartLaunchOutcome = Schema.Struct({
  launched: Schema.Literal(true),
  confirmedStatus: Schema.NullOr(UnityEditorStatus),
});
export type UnityColdStartLaunchOutcome = typeof UnityColdStartLaunchOutcome.Type;

/**
 * `alreadyOpen` is its own tag, not folded into `error` or a no-op `ok` —
 * an Editor already holding this project is a normal, expected outcome
 * (the whole point of checking `unity pipeline list --json`'s live
 * instance state before ever attempting a launch — see
 * `UnityColdStartRoute.ts`), not a failure. `launchIssued` is named for
 * exactly what it claims: the `unity open` invocation was accepted, never
 * that Unity itself is now open — the same "assert the effect you can
 * actually back" posture `UnityCommandResult`'s own doc comment states for
 * Play/Stop/Pause.
 */
export const UnityColdStartLaunchResult = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("launchIssued"), value: UnityColdStartLaunchOutcome }),
  Schema.Struct({ _tag: Schema.Literal("alreadyOpen") }),
  Schema.Struct({ _tag: Schema.Literal("cliUnavailable") }),
  Schema.Struct({ _tag: Schema.Literal("error"), message: Schema.String }),
]);
export type UnityColdStartLaunchResult = typeof UnityColdStartLaunchResult.Type;

/** The route this input is posted to — kept alongside the schema, same
 * convention as `UNITY_PIPELINE_INSTALL_PATH`/`UNITY_COMMAND_PATH`. */
export const UNITY_COLD_START_PATH = "/unity/cold-start";
