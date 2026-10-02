// Posts a real HTTP request to `POST /unity/pipeline-install`
// (`apps/server/src/unity/UnityPipelineInstallRoute.ts`'s
// `unityPipelineInstallRouteLayer`) — plan §5's increment 4a, the consented
// `unity pipeline install`. Modeled closely on `./fetchSetupProbe.ts`: both
// post through `../lib/forkEnvironmentRoute.ts` (upstream's
// `executeAuthenticatedEnvironmentHttpRequest`) at the same
// `runtime.runPromise` boundary. The body carries only the opaque project id;
// the canonical root is server-resolved, never caller-supplied — see
// `UnityPipelineInstallInput`'s own doc comment). Kept as its own file for
// the same reason `fetchSetupProbe.ts` is: this call has nothing in common
// with the read-only probe beyond the transport, and it is the one call in
// this whole feature that WRITES to the user's project — worth being able
// to find, read, and reason about on its own.
import {
  type ProjectId,
  UNITY_PIPELINE_INSTALL_PATH,
  UnityPipelineInstallResult,
} from "@t3tools/contracts";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/unstable/http";

import { postForkEnvironmentRoute } from "../lib/forkEnvironmentRoute";
import { runtime } from "../lib/runtime";

// Pre-composed once at module scope — same convention as
// `fetchSetupProbe.ts`'s `decodeUnitySetupProbeResult` (#99).
const decodeUnityPipelineInstallResult = Schema.decodeUnknownEffect(UnityPipelineInstallResult);

/** Bounds the whole authenticated call. The install runs one or more `unity`
 * CLI commands server-side (each capped at 35s) plus the selection package
 * install and pairing, so this is deliberately generous. */
const UNITY_PIPELINE_INSTALL_TIMEOUT_MS = 5 * 60_000;

function postEffect(input: {
  readonly projectId: ProjectId;
  readonly prepared: PreparedConnection;
}) {
  return Effect.gen(function* () {
    // A `presence:command`-scope refusal is a text 403, which the shared
    // helper fails as an undeclared status before any decode is attempted.
    const body = yield* postForkEnvironmentRoute({
      prepared: input.prepared,
      path: UNITY_PIPELINE_INSTALL_PATH,
      body: { projectId: input.projectId },
      timeoutMs: UNITY_PIPELINE_INSTALL_TIMEOUT_MS,
    });
    return yield* decodeUnityPipelineInstallResult(body);
  }).pipe(Effect.provide(FetchHttpClient.layer));
}

/**
 * Fires the consented `unity pipeline install` for the requested project.
 * The server resolves its canonical root from the opaque `projectId`; no
 * path crosses the wire. There is no server-side
 * "did the user consent" flag for this function to check — every caller is
 * responsible for treating its own click as the consent, by construction.
 * Two callers today, two different but equally valid consent shapes:
 * `ConnectionsSettings.tsx`'s `UnityPipelineInstallButton` gates this behind
 * an explicit confirm-dialog click; `EngineToolbar.tsx`'s `Setup Unity
 * Integrations` CTA (owner ruling: the click IS the consent, no dialog) goes
 * straight from a single header click to this call, via
 * `ChatView.tsx`'s `handleSetupUnityIntegrations`. Rejects on a
 * transport-level failure, a `presence:command`-scope refusal (HTTP 403), a
 * rejected credential, or a timeout only — a resolved value always has a real
 * `UnityPipelineInstallResult` to render, same posture `fetchUnitySetupProbe`
 * documents for its own 403 case.
 */
export function postUnityPipelineInstall(input: {
  readonly projectId: ProjectId;
  readonly prepared: PreparedConnection;
}): Promise<UnityPipelineInstallResult> {
  return runtime.runPromise(postEffect(input));
}
