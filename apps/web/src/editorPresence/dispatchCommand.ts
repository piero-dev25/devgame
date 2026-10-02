// Posts a real HTTP request to `POST /editor-presence/command`
// (`apps/server/src/editorPresence/EditorPresenceRoute.ts`'s
// `editorPresenceCommandRouteLayer`) — the toolbar's (#52) one and only
// path for sending a Play/Stop/Pause/Step command to a Godot-class,
// Editor-Presence-backed engine. Unity and three.js never call this; see
// `EngineToolbar.logic.ts`'s `EngineDispatchBackend` doc comment for why.
//
// This route is deliberately outside the contracts' `EnvironmentHttpApi`,
// matching the WS route it sits beside (see `EditorPresenceRoute.ts`'s own
// module doc for why), so it posts through `../lib/forkEnvironmentRoute.ts`,
// which runs upstream's `executeAuthenticatedEnvironmentHttpRequest` for a
// plain route.
import {
  EDITOR_PRESENCE_DISPATCH_COMMAND_PATH,
  EditorPresenceDispatchCommandResult,
} from "@t3tools/contracts";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/unstable/http";

import { postForkEnvironmentRoute } from "../lib/forkEnvironmentRoute";
import { runtime } from "../lib/runtime";

// Pre-composed once at module scope — same convention as
// `unity/dispatchCommand.ts`'s `decodeUnityCommandResult` (#101). This is
// Godot's Play/Stop dispatch path.
const decodeEditorPresenceDispatchCommandResult = Schema.decodeUnknownEffect(
  EditorPresenceDispatchCommandResult,
);

/** Bounds the whole authenticated call. The server waits at most 10s
 * (`COMMAND_TIMEOUT_MS`) for the plugin's `commandResult`, so this leaves
 * headroom over that. */
const EDITOR_PRESENCE_COMMAND_TIMEOUT_MS = 30_000;

function dispatchEffect(input: {
  readonly prepared: PreparedConnection;
  readonly sessionId: string;
  readonly action: string;
  readonly params?: Record<string, unknown>;
}) {
  return Effect.gen(function* () {
    const body = yield* postForkEnvironmentRoute({
      prepared: input.prepared,
      path: EDITOR_PRESENCE_DISPATCH_COMMAND_PATH,
      body: {
        sessionId: input.sessionId,
        action: input.action,
        ...(input.params ? { params: input.params } : {}),
      },
      timeoutMs: EDITOR_PRESENCE_COMMAND_TIMEOUT_MS,
    });
    return yield* decodeEditorPresenceDispatchCommandResult(body);
  }).pipe(Effect.provide(FetchHttpClient.layer));
}

/**
 * Sends one Play/Stop/Pause/Step command and resolves with the server's
 * outcome — `{ok:true}` means the command reached a plugin that understood
 * it, NEVER that the engine is now playing; see spec-unity-play-stop.md's
 * "acceptance is an edge, play state is a level" ruling. The toolbar's
 * button state is driven by presence (`playState`), never by this
 * function's return value, for exactly that reason.
 *
 * Rejects (with a value that is not an `EditorPresenceDispatchCommandResult`)
 * on a transport-level failure (no response at all, an unparseable body), on
 * an environment-level refusal (a typed `EnvironmentHttpCommonError` or an
 * undeclared non-2xx status), or on a body that does not decode. That is
 * distinct from a well-formed `{ok:false, error}` the server explicitly sent
 * back. A caller should treat a rejection as "couldn't reach the server,"
 * not as a specific engine-side rejection reason.
 */
export function dispatchEditorPresenceCommand(input: {
  readonly prepared: PreparedConnection;
  readonly sessionId: string;
  readonly action: string;
  readonly params?: Record<string, unknown>;
}): Promise<EditorPresenceDispatchCommandResult> {
  return runtime.runPromise(dispatchEffect(input));
}
