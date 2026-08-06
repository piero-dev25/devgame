/**
 * `POST /unity/cold-start` — the browser -> server leg for launching Unity
 * when no Editor instance currently has the open project's workspace root.
 *
 * ORIGIN: task #92's cost analysis of the Unity setup flow's not-ready
 * states (`UnitySetupClassifier.ts`) found that S5 ("Pipeline missing,
 * Unity closed") and S6 ("Pipeline present, Unity closed") both resolve to
 * "open Unity" — and that `UnityColdStart.ts`'s `unity open <projectRoot>`
 * argv builder already existed, tested and VERIFIED live (task #49), with
 * ZERO callers anywhere in the codebase. This route is the wiring, not new
 * capability — matching the owner's Bezi-style "just a button, no agent"
 * ruling for Unity setup (#92, #114): the hard part was already built.
 *
 * Mirrors `UnityPipelineInstallRoute.ts`'s shape closely (same "route
 * authenticates WHO, the dispatch function decides WHAT" split, same
 * server-resolved-`ServerConfig.cwd`-never-caller-supplied posture, same
 * empty POST input) — deliberately NOT `UnityCommandRoute.ts`'s
 * caller-supplied `workspaceRoot` pattern, for the identical reason that
 * route gives: this server process is scoped to exactly one project, and
 * accepting a caller-supplied path here would reopen a validation gap this
 * route has no reason to reproduce.
 *
 * SCOPE CHOICE: gated by `AuthPresenceCommandScope`, the SAME scope
 * `UnityCommandRoute.ts` and `UnityPipelineInstallRoute.ts` both use. This
 * capability is at least as consequential as either of those — it spawns a
 * whole new OS-level GUI process (a Unity Editor) for the user's project,
 * squarely inside that scope's own doc comment: "make the user's editor
 * execute code or change what it's doing." A second scope for the same
 * risk class reached through a third mechanism would fragment the security
 * model for no benefit, the same reasoning both sibling routes already
 * give.
 *
 * ALREADY-OPEN IS NOT AN ERROR: before ever attempting `unity open`, this
 * route checks `UnityPipelineClient.list`'s LIVE instance state (not
 * `UnityColdStart.ts`'s cheaper lockfile probe — see that module's own doc
 * comment for why: a crashed Editor can leave `Temp/UnityLockfile` behind
 * with nothing actually running, and `pipeline list`'s `isRunning` is the
 * same authoritative signal `UnitySetupClassifier.ts` already trusts for
 * the identical "is this genuinely live" question). A project that already
 * has a running, matched instance returns `{_tag: "alreadyOpen"}` — a
 * normal, expected outcome — and `open` is never called, since Unity's own
 * project lock would just reject a second instance anyway (per
 * `UnityColdStart.ts`'s module doc), and a pre-check produces a cleaner
 * result than letting Unity's own rejection surface as a raw CLI error.
 * `list` itself failing (CLI error, or `cliUnavailable`) is treated the
 * SAME conservative way: liveness could not be confirmed, so no launch is
 * attempted — a false "nothing's running" risks a second Editor instance,
 * which is worse than a refused launch the user can retry.
 *
 * SPAWNING IS NOT THE SAME AS "UNITY IS OPEN": `launchIssued`'s `launched:
 * true` claims only that the `unity open` invocation succeeded — see
 * `UnityPipelineClient.ts`'s `open`/`UnityPipelineOpenResult` doc comments.
 * `open` DOES follow the play/stop/pause `dispatchAndConfirm` precedent —
 * it polls `status` afterward with its own bounded budget
 * (`COLD_START_CONFIRM_RETRY_ATTEMPTS`) and this route forwards whatever it
 * found as `launchIssued.value.confirmedStatus` — but that budget is sized
 * to catch the fast/warm-reopen case, not a full cold boot (license check,
 * first import, asset database rebuild can run well past it). `null` is
 * the ORDINARY outcome for a genuinely cold launch, never an error. A
 * client that still wants a fresher answer after `confirmedStatus: null`
 * polls `POST /unity/command` with `action: "status"` itself.
 */
import {
  AuthPresenceCommandScope,
  type UnityColdStartLaunchResult,
  UNITY_COLD_START_PATH,
} from "@t3tools/contracts";
import { normalizeWorkspaceRoot } from "@t3tools/shared/workspaceRootPath";
import * as Effect from "effect/Effect";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  HttpServerRespondable,
} from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { failEnvironmentAuthInvalid, failEnvironmentInternal } from "../auth/http.ts";

import * as UnityPipelineClient from "../unity/UnityPipelineClient.ts";

export type UnityColdStartLaunchDispatchOutcome =
  | { readonly _tag: "ok"; readonly value: UnityColdStartLaunchResult }
  | { readonly _tag: "insufficientScope" };

/**
 * Checks `AuthPresenceCommandScope`, then checks live instance state before
 * ever attempting a launch — see this file's own module doc for the full
 * reasoning on both. Same "route authenticates WHO, this function decides
 * WHAT" split every other route in this family uses, so a missing scope is
 * an ordinary result value this layer chooses how to render (below), not
 * an HTTP-layer rejection that would make this check unreachable dead
 * code.
 *
 * Exported (not just used by the route below) for the same reason
 * `dispatchUnityPipelineInstall`/`dispatchUnityCommand` are: testable
 * directly, without a real HTTP request, and without ever spawning a real
 * `unity` process — every test in `UnityColdStartRoute.test.ts` provides a
 * fake `UnityPipelineClient`.
 */
export const dispatchUnityColdStartLaunch = (
  session: EnvironmentAuth.AuthenticatedSession,
): Effect.Effect<
  UnityColdStartLaunchDispatchOutcome,
  never,
  UnityPipelineClient.UnityPipelineClient | ServerConfig.ServerConfig
> =>
  Effect.gen(function* () {
    if (!session.scopes.includes(AuthPresenceCommandScope)) {
      return { _tag: "insufficientScope" } as const;
    }
    const serverConfig = yield* ServerConfig.ServerConfig;
    return yield* dispatchUnityColdStartLaunchForWorkspace(session, serverConfig.cwd);
  });

/**
 * Project-root form of the existing cold-start dispatch. `/unity/raise`
 * resolves its opaque project id through the projection store, then delegates
 * here so the live-match guard and `UnityPipelineClient.open` result mapping
 * remain one implementation.
 */
export const dispatchUnityColdStartLaunchForWorkspace = (
  session: EnvironmentAuth.AuthenticatedSession,
  workspaceRoot: string,
): Effect.Effect<
  UnityColdStartLaunchDispatchOutcome,
  never,
  UnityPipelineClient.UnityPipelineClient
> =>
  Effect.gen(function* () {
    if (!session.scopes.includes(AuthPresenceCommandScope)) {
      return { _tag: "insufficientScope" } as const;
    }
    const client = yield* UnityPipelineClient.UnityPipelineClient;

    const listResult = yield* client.list(workspaceRoot);
    if (listResult._tag === "cliUnavailable") {
      return { _tag: "ok", value: { _tag: "cliUnavailable" } } as const;
    }
    if (listResult._tag !== "ok") {
      // `notReady`/`error` — liveness could not be confirmed either way.
      // Refuse to spawn rather than guess: same conservative posture
      // `UnitySetupProbe.ts` takes when `list` itself fails (folds to the
      // verbatim S12 path rather than assuming either "running" or "not
      // running").
      const message =
        listResult._tag === "error"
          ? listResult.message
          : "could not confirm whether Unity is already open for this project";
      return { _tag: "ok", value: { _tag: "error", message } } as const;
    }

    // Same `liveMatch` derivation `UnitySetupClassifier.ts` uses — a match
    // whose own `isRunning` is false is a stale lock, not a running
    // Editor (that file's own comment). Trusting `pipeline list`'s live
    // instance state here, never `UnityColdStart.ts`'s lockfile probe —
    // see this file's own module doc for why.
    const matched =
      listResult.value.instances.find(
        (instance) =>
          normalizeWorkspaceRoot(instance.projectPath) === normalizeWorkspaceRoot(workspaceRoot),
      ) ?? null;
    if (matched !== null && matched.isRunning) {
      return { _tag: "ok", value: { _tag: "alreadyOpen" } } as const;
    }

    const openResult = yield* client.open(workspaceRoot);
    if (openResult._tag === "ok") {
      return {
        _tag: "ok",
        value: {
          _tag: "launchIssued",
          value: {
            launched: true,
            confirmedStatus: openResult.value.confirmedStatus,
          },
        },
      } as const;
    }
    if (openResult._tag === "cliUnavailable") {
      return { _tag: "ok", value: { _tag: "cliUnavailable" } } as const;
    }
    const message =
      openResult._tag === "error" ? openResult.message : "Unity did not confirm the launch";
    return { _tag: "ok", value: { _tag: "error", message } } as const;
  });

// Deliberately NOT `.pipe(Layer.provide(UnityPipelineClient.layer))` here —
// see `UnityCommandRoute.ts`'s own comment at its identical call site for
// the full writeup of why `HttpRouter.add(...)`'s branded
// `Request.From<"Requires", X>` marker requires `HttpRouter.provideRequest`,
// not ordinary `Layer.provide`, to discharge a route's own requirements.
export const unityColdStartRouteLayer = HttpRouter.add(
  "POST",
  UNITY_COLD_START_PATH,
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

    const outcome = yield* dispatchUnityColdStartLaunch(session);
    if (outcome._tag === "insufficientScope") {
      // `HttpServerResponse.text` returns a bare `HttpServerResponse`, NOT
      // an Effect — same pitfall `UnitySetupProbeRoute.ts`'s own comment at
      // its identical call site documents.
      return HttpServerResponse.text("Forbidden: insufficient scope", { status: 403 });
    }
    return yield* HttpServerResponse.json(outcome.value);
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
    }),
  ),
);
