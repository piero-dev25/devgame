// Proves the short-TTL cache in front of `fetchUnitySetupProbe` actually
// dedupes concurrent callers, and that `invalidateUnitySetupProbeCache`
// genuinely bypasses it (#102). ChatView.tsx's toolbar and
// ConnectionsSettings.tsx's "Unity integration" panel both call the probe
// on mount with no coordination — this is what makes N near-simultaneous
// mounts cost one server call instead of N, and what keeps a post-install
// refresh (ConnectionsSettings' `refetch`) from serving stale cached data
// — the exact S13 defect class (a just-installed package reported as still
// missing) fixed once already at 193abfb89, now reachable through the
// cache instead of the classifier.
import { afterEach, describe, expect, it, vi } from "@effect/vitest";

import { fetchUnitySetupProbeCached, invalidateUnitySetupProbeCache } from "./setupProbeCache";

function probeResponse(overrides: { readonly pipelinePackageInstalled: boolean }) {
  return {
    facts: {
      isUnityProject: true,
      cliAvailable: true,
      cliDiscoveredPath: null,
      lockfilePresent: true,
      pipelinePackage: {
        installed: overrides.pipelinePackageInstalled,
        resolvedVersion: overrides.pipelinePackageInstalled ? "1.0.0" : null,
        declaredInManifest: overrides.pipelinePackageInstalled,
      },
      selectionPackage: { installed: true, resolvedVersion: "1.0.0", declaredInManifest: true },
      selectionPublisherRegistered: true,
      withinPairingGraceWindow: false,
    },
    primary: { state: "S11" },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  invalidateUnitySetupProbeCache();
});

describe("fetchUnitySetupProbeCached", () => {
  it("collapses concurrent calls for the same environment into one server call", async () => {
    // `mockImplementation` (not `mockResolvedValue`) so each call gets its
    // own fresh `Response` — a real server never serves the same
    // already-consumed body twice, and neither should this fixture.
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(Response.json(probeResponse({ pipelinePackageInstalled: false }))),
      );
    vi.stubGlobal("fetch", fetchMock);

    const input = {
      environmentId: "env-1",
      httpBaseUrl: "http://127.0.0.1:3000",
      httpAuthorization: null,
    };
    const [a, b, c] = await Promise.all([
      fetchUnitySetupProbeCached(input),
      fetchUnitySetupProbeCached(input),
      fetchUnitySetupProbeCached(input),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  it("does not dedupe across different environments", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(Response.json(probeResponse({ pipelinePackageInstalled: false }))),
      );
    vi.stubGlobal("fetch", fetchMock);

    await Promise.all([
      fetchUnitySetupProbeCached({
        environmentId: "env-1",
        httpBaseUrl: "http://127.0.0.1:3000",
        httpAuthorization: null,
      }),
      fetchUnitySetupProbeCached({
        environmentId: "env-2",
        httpBaseUrl: "http://127.0.0.1:3001",
        httpAuthorization: null,
      }),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("invalidateUnitySetupProbeCache forces the next call to observe fresh data — the post-install path", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() =>
        Promise.resolve(Response.json(probeResponse({ pipelinePackageInstalled: false }))),
      )
      .mockImplementationOnce(() =>
        Promise.resolve(Response.json(probeResponse({ pipelinePackageInstalled: true }))),
      );
    vi.stubGlobal("fetch", fetchMock);

    const input = {
      environmentId: "env-1",
      httpBaseUrl: "http://127.0.0.1:3000",
      httpAuthorization: null,
    };
    const before = await fetchUnitySetupProbeCached(input);
    expect(before.facts.pipelinePackage.installed).toBe(false);

    // Without invalidation, a second call within the TTL must be served
    // from cache, not the server — this is what proves the cache is
    // actually consulted here, not merely that two calls happen to return
    // two different things.
    const stillCached = await fetchUnitySetupProbeCached(input);
    expect(stillCached.facts.pipelinePackage.installed).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Simulates a successful `postUnityPipelineInstall` — the caller must
    // invalidate before asking again, or it would get the SAME cached
    // "not installed" answer despite the install having just succeeded.
    // This is the exact S13 defect class (193abfb89), now reachable
    // through the cache instead of the classifier.
    invalidateUnitySetupProbeCache("env-1");

    const after = await fetchUnitySetupProbeCached(input);
    expect(after.facts.pipelinePackage.installed).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("evicts a rejected fetch immediately so the next call gets a real retry, not a replayed failure", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ malformed: true }))
      .mockResolvedValueOnce(Response.json(probeResponse({ pipelinePackageInstalled: true })));
    vi.stubGlobal("fetch", fetchMock);

    const input = {
      environmentId: "env-1",
      httpBaseUrl: "http://127.0.0.1:3000",
      httpAuthorization: null,
    };
    await expect(fetchUnitySetupProbeCached(input)).rejects.toBeTruthy();

    const result = await fetchUnitySetupProbeCached(input);
    expect(result.facts.pipelinePackage.installed).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
