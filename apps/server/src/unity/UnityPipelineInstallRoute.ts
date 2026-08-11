/**
 * `POST /unity/pipeline-install` — the browser -> server leg for plan §5's
 * increment 4a: consented `unity pipeline install`. The client supplies an
 * opaque `projectId`; this route resolves the canonical workspace root from
 * the server's projection store. No caller-supplied filesystem path reaches
 * this disk-writing operation.
 *
 * SCOPE CHOICE: gated by `AuthPresenceCommandScope`, the SAME scope
 * `UnityCommandRoute.ts` uses for Play/Stop/Pause — NOT
 * `AuthPresenceReadScope` (the setup-probe route's scope). That scope's own
 * doc comment is explicit about why it's safe to grant broadly: "this scope
 * authorizes no code execution and no project mutation." This route DOES
 * mutate the project (`Packages/manifest.json`, the embedded selection
 * package directory, and indirectly `packages-lock.json` once Unity resolves
 * them) — the same risk class
 * `AuthPresenceCommandScope`'s own doc comment already covers
 * (`projectsWriteFile`). A second scope for the same capability reached
 * through a different mechanism (CLI shell-out vs. WS command frame) would
 * fragment the security model for no benefit, the identical reasoning
 * `UnityCommandRoute.ts`'s own doc comment gives for reusing this scope.
 *
 * CONSENT IS ENFORCED CLIENT-SIDE, NOT BY A SERVER-SIDE FLAG: this route has
 * no separate "did the user click confirm" input to check. The deliberate
 * "Setup Unity Integrations" click in the chat header (`ChatView.tsx`'s
 * `handleSetupUnityIntegrations`; the old `ConnectionsSettings.tsx` dialog
 * was deleted with that panel, and the owner ruled the click itself IS the
 * consent) is what stands between a page load and this call ever firing —
 * same posture `UnityCommandRoute.ts`'s Play/Stop/Pause buttons already
 * have (the server's own enforcement is the scope check, not a second flag
 * it would have no way to verify was genuine anyway).
 */
import {
  AuthPresenceCommandScope,
  UnityPipelineInstallInput,
  type UnityPackageResolveOutcome,
  type UnityPipelineInstallResult,
  UNITY_PIPELINE_INSTALL_PATH,
} from "@t3tools/contracts";
import { normalizeWorkspaceRoot } from "@t3tools/shared/workspaceRootPath";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  HttpServerRespondable,
} from "effect/unstable/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { failEnvironmentAuthInvalid, failEnvironmentInternal } from "../auth/http.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";

import * as UnityPipelineClient from "./UnityPipelineClient.ts";
import * as UnityPairingHandoff from "./UnityPairingHandoff.ts";
import {
  installUnityEmbeddedSelectionPackage,
  unitySelectionPackageSourceCandidates,
} from "./UnityEmbeddedSelectionPackage.ts";

export { unitySelectionPackageSourceCandidates };

export type UnityPipelineInstallDispatchOutcome =
  | { readonly _tag: "ok"; readonly value: UnityPipelineInstallResult }
  | { readonly _tag: "insufficientScope" };

/**
 * Checks `AuthPresenceCommandScope`, resolves the opaque project id through
 * the server projection, then runs the install against that project's
 * canonical root — the same "route authenticates WHO, this function decides
 * WHAT" split every other route in this family uses, so a missing scope is
 * an ordinary result value this layer chooses how to render (below), not an
 * HTTP-layer rejection that would make this check unreachable dead code.
 *
 * Exported (not just used by the route below) for the same reason
 * `dispatchUnitySetupProbe`/`dispatchUnityCommand` are: testable directly,
 * without a real HTTP request.
 */
export const dispatchUnityPipelineInstall = (
  session: EnvironmentAuth.AuthenticatedSession,
  projectId: UnityPipelineInstallInput["projectId"],
): Effect.Effect<
  UnityPipelineInstallDispatchOutcome,
  never,
  | FileSystem.FileSystem
  | Path.Path
  | UnityPipelineClient.UnityPipelineClient
  | UnityPairingHandoff.UnityPairingHandoff
  | ProjectionSnapshotQuery.ProjectionSnapshotQuery
> =>
  Effect.gen(function* () {
    if (!session.scopes.includes(AuthPresenceCommandScope)) {
      return { _tag: "insufficientScope" } as const;
    }
    const snapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    const lookup = yield* snapshotQuery.getProjectShellById(projectId).pipe(
      Effect.map((project) => ({ _tag: "ok", project }) as const),
      // Merge-gate F2: same rationale as UnitySetupProbeRoute.ts's twin —
      // without this log a locked DB or a row that fails to decode is
      // indistinguishable from an unknown id, silently, on the WRITE route.
      Effect.tapError((cause) =>
        Effect.logError("unity pipeline install: project lookup failed", { cause }),
      ),
      Effect.orElseSucceed(
        () =>
          ({
            _tag: "error",
            message: "Could not resolve project.",
          }) as const,
      ),
    );
    if (lookup._tag === "error") {
      return { _tag: "ok", value: lookup } as const;
    }
    if (Option.isNone(lookup.project)) {
      return {
        _tag: "ok",
        value: { _tag: "error", message: "Project not found." },
      } as const;
    }
    const client = yield* UnityPipelineClient.UnityPipelineClient;
    // The Editor binds to the canonical root. A thread worktree is
    // deliberately not considered here: installing into a copy no Editor
    // has open would mutate the wrong manifest.
    const pipeline = yield* client.install(lookup.project.value.workspaceRoot);
    if (pipeline._tag !== "ok") {
      return { _tag: "ok", value: pipeline } as const;
    }
    const selectionPackage = yield* installUnityEmbeddedSelectionPackage(
      lookup.project.value.workspaceRoot,
    ).pipe(
      Effect.tapError((cause) =>
        Effect.logError("unity selection package install failed", { cause }),
      ),
      Effect.match({
        onFailure: () => null,
        onSuccess: (outcome) => outcome,
      }),
    );
    if (selectionPackage === null) {
      return {
        _tag: "ok",
        value: { _tag: "error", message: "Could not install Unity selection package." },
      } as const;
    }
    // Hoisted to a local `const` (unlike every other `lookup.project.value.*`
    // read in this function, all at the top level of the generator body):
    // TypeScript's `Option.isNone` narrowing of `lookup.project` does not
    // survive into the `.find()` callback further down — a property access
    // narrowed on the OUTER scope reverts to its widened `Option<...>` type
    // inside a nested closure, which is exactly what tripped a real
    // `Property 'value' does not exist on type 'Option<...>'` typecheck
    // error here.
    const workspaceRoot = lookup.project.value.workspaceRoot;

    // Merge-gate R3: pairing MUST prepare (and, on the minted path, write
    // Library/<id>/pairing.json) BEFORE the packageResolve nudge below.
    // packageResolve triggers Unity to (re)load the just-copied package,
    // and that load path is what reads the pairing handoff — under the OLD
    // ordering, a resolve-triggered load could run against a request that
    // hadn't written its own handoff yet. The C# side self-heals via its
    // own 1s `HandleEditorUpdate` poll regardless (see EditorPresenceSettings.cs),
    // so this was never a correctness bug, but the live round-9 evidence
    // (evidence/qa-round9/REPORT.md) was gathered under the old ordering —
    // this removes the needless race rather than relying on the poll to
    // paper over it.
    const pairingHandoff = yield* UnityPairingHandoff.UnityPairingHandoff;
    const pairingOutcome = yield* pairingHandoff.prepare({
      workspaceRoot,
      projectTitle: lookup.project.value.title,
    });

    // Task #130's zero-touch wire: an Auto-Refresh-OFF Editor does not
    // notice the embedded package this call just replaced on disk until
    // Unity's resolver is nudged (verified live,
    // evidence/qa-round9/REPORT.md — `unity command package_resolve`
    // triggered reimport → recompile → package redemption in 9s where the
    // click alone left it unloaded). Only attempted with POSITIVE evidence
    // of a live, RUNNING matched instance — a missing or unconfirmable
    // match (an absent match, a stale/non-running one, or `list` itself
    // failing) all fold into "skip," never a guess and never a cold start;
    // see `UnityPipelineClient.ts`'s own `open` for why cold-starting Unity
    // is a separate, deliberate user action this route does not take on
    // its own.
    const listResult = yield* client.list(workspaceRoot);
    const liveMatch =
      listResult._tag === "ok"
        ? (listResult.value.instances.find(
            (instance) =>
              normalizeWorkspaceRoot(instance.projectPath) ===
              normalizeWorkspaceRoot(workspaceRoot),
          ) ?? null)
        : null;
    let packageResolve: UnityPackageResolveOutcome;
    if (liveMatch !== null && liveMatch.isRunning) {
      const resolveResult = yield* client.packageResolve(workspaceRoot);
      if (resolveResult._tag === "ok") {
        packageResolve = "invoked";
      } else {
        // Non-fatal to the install either way — the embedded package copy
        // already succeeded; this is only a best-effort nudge so the user
        // doesn't have to refocus Unity themselves. Logged so a real
        // pattern of failures is visible without making the install itself
        // report an error over a resolver nudge.
        packageResolve = "failed";
        yield* Effect.logWarning("unity package_resolve failed after install (non-fatal)", {
          workspaceRoot,
          outcome: resolveResult,
        });
      }
    } else {
      packageResolve = "skipped_no_editor";
    }
    return {
      _tag: "ok",
      value: { ...pipeline, selectionPackage, pairingOutcome, packageResolve },
    } as const;
  });

// Deliberately NOT `.pipe(Layer.provide(UnityPipelineClient.layer))` here —
// see `UnityCommandRoute.ts`'s own comment at its identical call site for
// the full writeup of why `HttpRouter.add(...)`'s branded
// `Request.From<"Requires", X>` marker requires `HttpRouter.provideRequest`,
// not ordinary `Layer.provide`, to discharge a route's own requirements.
export const unityPipelineInstallRouteLayer = HttpRouter.add(
  "POST",
  UNITY_PIPELINE_INSTALL_PATH,
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
      Effect.flatMap(Schema.decodeUnknownEffect(UnityPipelineInstallInput)),
      Effect.orElseSucceed(() => null),
    );
    if (input === null) {
      return HttpServerResponse.text("Bad Request: malformed pipeline install", { status: 400 });
    }

    const outcome = yield* dispatchUnityPipelineInstall(session, input.projectId);
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
