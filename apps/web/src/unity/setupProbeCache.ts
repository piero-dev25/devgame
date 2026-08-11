// A short-TTL, in-flight-deduping cache in front of `fetchUnitySetupProbe`
// (#102). ChatView.tsx's engine toolbar and ConnectionsSettings.tsx's
// "Unity integration" panel both mount-effect their own call to the probe
// with no coordination between them — each is a real ~200ms `unity` CLI
// shell-out server-side, not a cheap read, and the plan's own state table
// specifies "on demand only: panel open, Play click, explicit refresh."
// Two uncoordinated mount-effects racing on every remount, project switch,
// or settings-page visit is looser than that.
//
// Probe identity is `(environmentId, projectId)`: one desktop environment
// serves many projects, and caching by environment alone would let one
// project's classified answer leak into another project's toolbar.
import type { EnvironmentId, ProjectId, UnitySetupProbeSuccess } from "@t3tools/contracts";
import type { PreparedHttpAuthorization } from "@t3tools/client-runtime/connection";
import { scopedProjectKey } from "@t3tools/client-runtime/environment";

import { fetchUnitySetupProbe } from "./fetchSetupProbe";

const TTL_MS = 5_000;

interface CacheEntry {
  readonly promise: Promise<UnitySetupProbeSuccess>;
  readonly expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Same contract as `fetchUnitySetupProbe`, plus the environment/project
 * identity used for cache-keying. Concurrent or near-simultaneous callers
 * for the SAME project within `TTL_MS` share one in-flight
 * request and its resolved value — this is what makes N mounts within the
 * window cost exactly one server call, not just N calls that happen to
 * return the same object.
 *
 * A rejected fetch is evicted immediately rather than cached for the full
 * TTL, so a transient failure doesn't block the next caller's retry.
 */
export function fetchUnitySetupProbeCached(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly httpBaseUrl: string;
  readonly httpAuthorization: PreparedHttpAuthorization | null;
}): Promise<UnitySetupProbeSuccess> {
  const key = scopedProjectKey(input);
  const existing = cache.get(key);
  if (existing !== undefined && Date.now() < existing.expiresAt) {
    return existing.promise;
  }
  const promise = fetchUnitySetupProbe(input);
  const entry: CacheEntry = { promise, expiresAt: Date.now() + TTL_MS };
  cache.set(key, entry);
  promise.catch(() => {
    // Only remove OUR entry — by the time this lands, an explicit
    // `invalidateUnitySetupProbeCache` (or a newer fetch racing ahead of
    // this rejection) may have already replaced it, and that newer entry
    // must not be clobbered by this older failure's cleanup.
    if (cache.get(key) === entry) {
      cache.delete(key);
    }
  });
  return promise;
}

/**
 * Forces the next `fetchUnitySetupProbeCached` call for this project to hit
 * the server again, bypassing whatever's currently cached. Required
 * after a successful `postUnityPipelineInstall` — see
 * `UnitySetupClassifier.ts`'s S13 doc comment (193abfb89) for the exact
 * defect class a stale cache would reintroduce here: reporting a
 * just-installed package as still missing. Called with no argument to
 * clear every entry (test-only convenience — real callers always know the
 * environment and project that changed).
 */
export function invalidateUnitySetupProbeCache(): void;
export function invalidateUnitySetupProbeCache(
  environmentId: EnvironmentId,
  projectId: ProjectId,
): void;
export function invalidateUnitySetupProbeCache(
  environmentId?: EnvironmentId,
  projectId?: ProjectId,
): void {
  if (environmentId === undefined && projectId === undefined) {
    cache.clear();
    return;
  }
  if (environmentId === undefined || projectId === undefined) return;
  cache.delete(scopedProjectKey({ environmentId, projectId }));
}
