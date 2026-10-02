// Posts a real HTTP request to `POST /unity/command`
// (`apps/server/src/unity/UnityCommandRoute.ts`'s `unityCommandRouteLayer`)
// — the toolbar's (#52) path for driving Unity's Play/Stop/Pause via the
// server-side `com.unity.pipeline` CLI shell-out. Unity never goes through
// Editor Presence — no publisher, no session id, no presence WebSocket — so
// this is deliberately a SEPARATE file from `editorPresence/dispatchCommand.ts`,
// not a shared one with an engine switch inside it, mirroring
// `packages/contracts/src/unity.ts`'s own "same overall shape, different
// contents, kept as its own file" choice.
//
// Modeled closely on `editorPresence/dispatchCommand.ts`: both post through
// `../lib/forkEnvironmentRoute.ts` (upstream's
// `executeAuthenticatedEnvironmentHttpRequest`) at the same
// `runtime.runPromise` boundary. The two differ only in path, input shape,
// and (critically) in what a caller does with the result: Unity's
// `UnityCommandResult` is a four-tag union (`ok` / `notReady` /
// `cliUnavailable` / `error`), not a two-tag `{ok:boolean}`. See that
// type's own doc comment for why collapsing it would be wrong.
import {
  UNITY_COMMAND_PATH,
  type UnityCommandAction,
  UnityCommandResult,
} from "@t3tools/contracts";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/unstable/http";

import { postForkEnvironmentRoute } from "../lib/forkEnvironmentRoute";
import { runtime } from "../lib/runtime";

// Pre-composed once at module scope — same convention as
// `fetchSetupProbe.ts`'s `decodeUnitySetupProbeResult` (#99/#100). This is
// the Play/Stop dispatch path, so an unvalidated response here would feed
// straight into the toolbar's state (#101).
const decodeUnityCommandResult = Schema.decodeUnknownEffect(UnityCommandResult);

/** Bounds the whole authenticated call. The server caps its own `unity
 * command` run at 35s and then re-reads editor status, so this leaves
 * headroom over that instead of tracking the happy path. */
const UNITY_COMMAND_TIMEOUT_MS = 60_000;

function dispatchEffect(input: {
  readonly prepared: PreparedConnection;
  readonly workspaceRoot: string;
  readonly action: UnityCommandAction;
}) {
  return Effect.gen(function* () {
    const body = yield* postForkEnvironmentRoute({
      prepared: input.prepared,
      path: UNITY_COMMAND_PATH,
      body: { workspaceRoot: input.workspaceRoot, action: input.action },
      timeoutMs: UNITY_COMMAND_TIMEOUT_MS,
    });
    return yield* decodeUnityCommandResult(body);
  }).pipe(Effect.provide(FetchHttpClient.layer));
}

/**
 * Sends one Play/Stop/Pause command (or a `"status"` read) and resolves
 * with the server's four-tag outcome. `notReady` ("no Editor open for this
 * project, or mid domain-reload") and `cliUnavailable` ("the `unity` CLI
 * isn't installed") are NOT errors to fold together — a caller must render
 * them as the different problems they are, per `UnityCommandResult`'s own
 * non-negotiable contract comment. `ok` carries the confirmed
 * `UnityEditorStatus` read back AFTER the action (Unity's own
 * `UnityPipelineClient` re-reads status before returning), so a caller
 * never needs to separately poll to know the resulting play state.
 *
 * Rejects on a transport-level failure (no response at all, an unparseable
 * body), on an environment-level refusal (a typed `EnvironmentHttpCommonError`
 * such as a rejected credential, or an undeclared non-2xx status), or on a
 * body that does not decode. None of these is one of the four well-formed tags
 * the server can send back.
 */
export function dispatchUnityCommand(input: {
  readonly prepared: PreparedConnection;
  readonly workspaceRoot: string;
  readonly action: UnityCommandAction;
}): Promise<UnityCommandResult> {
  return runtime.runPromise(dispatchEffect(input));
}
