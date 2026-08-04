/**
 * `POST /unity/command` — the browser -> server leg for Unity Play/Stop/
 * Pause/Status. Deliberately mirrors `EditorPresenceRoute.ts`'s
 * `editorPresenceCommandRouteLayer` / `dispatchEditorCommand` shape (same
 * auth pattern, same "route only authenticates WHO, the dispatch function
 * decides WHAT they may do" split, same route-path-constant-next-to-schema
 * convention) so a client caller has two similarly-shaped things to call —
 * but Unity does NOT go through Editor Presence, `EditorPresenceRegistry`,
 * or the WebSocket `command`/`commandResult` frames at all. It shells out
 * to Unity's own official `com.unity.pipeline` package via
 * `UnityPipelineClient.ts`. See docs/workbench/spec-unity-play-stop.md's
 * status note and unity/README.md for why.
 *
 * SCOPE CHOICE: gated by the SAME `AuthPresenceCommandScope` the Editor
 * Presence command route uses, not a separate Unity-specific scope. This is
 * the identical class of risk spec-editor-presence-commands.md's dedicated-
 * scope ruling was written for — "make the user's editor execute code or
 * change what it's doing" — just reached through a CLI shell-out instead of
 * a WS frame for one specific engine. A second scope for the same
 * capability on a different transport would fragment the security model
 * for no benefit; the whole point of a dedicated scope was to gate that
 * ONE capability uniformly, not per-engine.
 *
 * NON-NEGOTIABLE CONTRACT PROPERTY (owner ruling): `notReady` ("no Editor
 * open for this project", or mid domain-reload) and `cliUnavailable` ("the
 * `unity` CLI isn't installed") must reach the client as their OWN states —
 * `dispatchUnityCommand` below returns `UnityPipelineClient`'s own
 * `UnityPipelineResult` UNCHANGED (never folded into a generic `error`),
 * and `packages/contracts/src/unity.ts`'s `UnityCommandResult` schema
 * mirrors that same four-tag shape on the wire. Losing this distinction at
 * the HTTP boundary would silently undo the entire point of modelling it
 * server-side.
 */
import {
  AuthPresenceCommandScope,
  UnityCommandInput,
  type UnityCommandAction,
  UNITY_COMMAND_PATH,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  HttpServerRespondable,
} from "effect/unstable/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { failEnvironmentAuthInvalid, failEnvironmentInternal } from "../auth/http.ts";

import * as UnityPipelineClient from "./UnityPipelineClient.ts";

/**
 * Checks `AuthPresenceCommandScope`, then dispatches to the matching
 * `UnityPipelineClient` method — the same "route authenticates WHO, this
 * function decides WHAT" split `dispatchEditorCommand` uses, so a missing
 * scope is an ordinary `{_tag:"error", message:"insufficient_scope"}`
 * result value, not an HTTP-layer rejection (gating at the route level too
 * would make this check unreachable dead code).
 *
 * Exported (not just used by the route below) for the same reason
 * `dispatchEditorCommand` is: testable directly, without a real HTTP
 * request, and available to a future non-HTTP caller without duplicating
 * the scope check.
 */
export const dispatchUnityCommand = (
  session: EnvironmentAuth.AuthenticatedSession,
  workspaceRoot: string,
  action: UnityCommandAction,
): Effect.Effect<
  UnityPipelineClient.UnityPipelineResult<UnityPipelineClient.UnityEditorStatus>,
  never,
  UnityPipelineClient.UnityPipelineClient
> =>
  Effect.gen(function* () {
    if (!session.scopes.includes(AuthPresenceCommandScope)) {
      return { _tag: "error", message: "insufficient_scope" } as const;
    }
    const client = yield* UnityPipelineClient.UnityPipelineClient;
    switch (action) {
      case "play":
        return yield* client.play(workspaceRoot);
      case "stop":
        return yield* client.stop(workspaceRoot);
      case "pause":
        return yield* client.pause(workspaceRoot);
      case "status":
        return yield* client.status(workspaceRoot);
    }
  });

// Deliberately NOT `.pipe(Layer.provide(UnityPipelineClient.layer))` here —
// measured live: `HttpRouter.add(...).pipe(Layer.provide(X))` silently
// fails to register the route (every request 404s) when `X` itself has
// unresolved EXTERNAL transitive dependencies, which `UnityPipelineClient.layer`
// does (`ProcessRunner` / `FileSystem` / `Path`). `EditorPresenceRoute.ts`'s
// own `.pipe(Layer.provide(EditorPresenceRegistry.layer))` doesn't hit this,
// because `EditorPresenceRegistry.layer` has NO external deps of its own —
// that's why copying that shape here broke silently instead of loudly. The
// fix: leave `UnityPipelineClient.UnityPipelineClient` as an external
// requirement of this route, and let whoever composes it in (`server.ts`,
// or a test) provide a FULLY RESOLVED `UnityPipelineClient.layer` — see
// `server.ts`'s own comment at its call site for the working composition.
export const unityCommandRouteLayer = HttpRouter.add(
  "POST",
  UNITY_COMMAND_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
      Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
        failEnvironmentAuthInvalid(EnvironmentAuth.serverAuthCredentialReason(error)),
      ),
      Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
        failEnvironmentInternal("internal_error", error),
      ),
    );

    const input = yield* request.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(UnityCommandInput)),
      Effect.orElseSucceed(() => null),
    );
    if (input === null) {
      return HttpServerResponse.text("Bad Request: malformed command", { status: 400 });
    }

    const outcome = yield* dispatchUnityCommand(session, input.workspaceRoot, input.action);
    return yield* HttpServerResponse.json(outcome);
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
    }),
  ),
);
