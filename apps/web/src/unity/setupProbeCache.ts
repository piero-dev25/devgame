// A short-TTL, in-flight-deduping cache in front of `fetchUnitySetupProbe`
// (#102). ChatView.tsx's engine toolbar and ConnectionsSettings.tsx's
// "Unity integration" panel both mount-effect their own call to the probe
// with no coordination between them — each is a real ~200ms `unity` CLI
// shell-out server-side, not a cheap read, and the plan's own state table
// specifies "on demand only: panel open, Play click, explicit refresh."
// Two uncoordinated mount-effects racing on every remount, project switch,
// or settings-page visit is looser than that.
//
// Keyed by `environmentId` alone, NOT the full
// `[activeProjectRef, resolvedEngineType, environmentId]` triple
// ChatView's own effect uses to decide WHEN to re-fetch:
// `POST /unity/setup-probe` takes no project argument at all — the server
// resolves ITS OWN project from `ServerConfig.cwd`, one project per server
// process (see `UnitySetupProbeInput`'s own doc comment in
// packages/contracts). A given `environmentId` always answers about the
// same project, so it's the only key that can affect correctness; the
// other two are UI-side "should I even ask" gates, not data identity —
// and ConnectionsSettings.tsx has no equivalent of `resolvedEngineType`
// to key on regardless.
import type { UnitySetupProbeResult } from "@t3tools/contracts";
import type { PreparedHttpAuthorization } from "@t3tools/client-runtime/connection";

import { fetchUnitySetupProbe } from "./fetchSetupProbe";

const TTL_MS = 5_000;

interface CacheEntry {
  readonly promise: Promise<UnitySetupProbeResult>;
  readonly expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Same contract as `fetchUnitySetupProbe`, plus the `environmentId` this
 * request is scoped to for cache-keying. Concurrent or near-simultaneous
 * callers for the SAME environment within `TTL_MS` share one in-flight
 * request and its resolved value — this is what makes N mounts within the
 * window cost exactly one server call, not just N calls that happen to
 * return the same object.
 *
 * A rejected fetch is evicted immediately rather than cached for the full
 * TTL, so a transient failure doesn't block the next caller's retry.
 */
export function fetchUnitySetupProbeCached(input: {
  readonly environmentId: string;
  readonly httpBaseUrl: string;
  readonly httpAuthorization: PreparedHttpAuthorization | null;
}): Promise<UnitySetupProbeResult> {
  const existing = cache.get(input.environmentId);
  if (existing !== undefined && Date.now() < existing.expiresAt) {
    return existing.promise;
  }
  const promise = fetchUnitySetupProbe(input);
  const entry: CacheEntry = { promise, expiresAt: Date.now() + TTL_MS };
  cache.set(input.environmentId, entry);
  promise.catch(() => {
    // Only remove OUR entry — by the time this lands, an explicit
    // `invalidateUnitySetupProbeCache` (or a newer fetch racing ahead of
    // this rejection) may have already replaced it, and that newer entry
    // must not be clobbered by this older failure's cleanup.
    if (cache.get(input.environmentId) === entry) {
      cache.delete(input.environmentId);
    }
  });
  return promise;
}

/**
 * Forces the next `fetchUnitySetupProbeCached` call for this environment to
 * hit the server again, bypassing whatever's currently cached. Required
 * after a successful `postUnityPipelineInstall` — see
 * `UnitySetupClassifier.ts`'s S13 doc comment (193abfb89) for the exact
 * defect class a stale cache would reintroduce here: reporting a
 * just-installed package as still missing. Called with no argument to
 * clear every entry (test-only convenience — real callers always know
 * which environment just changed).
 */
export function invalidateUnitySetupProbeCache(environmentId?: string): void {
  if (environmentId === undefined) {
    cache.clear();
    return;
  }
  cache.delete(environmentId);
}
