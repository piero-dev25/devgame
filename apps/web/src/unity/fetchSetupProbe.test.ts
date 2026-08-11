// Proves `fetchUnitySetupProbe` actually validates the HTTP response it
// gets back, rather than trusting a compile-time cast (#100). The malformed
// case is the load-bearing one: before the real `Schema.decodeUnknownEffect`
// decode was wired in, this exact test failed (the promise RESOLVED with
// `{ malformed: true }` reinterpreted as a `UnitySetupProbeResult`) — a
// schema-only unit test bypassing this file's own code would not have
// proven that. See fetchSetupProbe.ts.
import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";

import { fetchUnitySetupProbe } from "./fetchSetupProbe";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchUnitySetupProbe", () => {
  it("sends the opaque projectId in the request body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        facts: {
          isUnityProject: true,
          cliAvailable: true,
          cliDiscoveredPath: null,
          lockfilePresent: true,
          pipelinePackage: {
            installed: true,
            resolvedVersion: "1.0.0",
            declaredInManifest: true,
          },
          selectionPackage: {
            installed: true,
            resolvedVersion: "1.0.0",
            declaredInManifest: true,
          },
          selectionPublisherRegistered: true,
          withinPairingGraceWindow: false,
        },
        primary: { state: "S11" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const input = {
      projectId: ProjectId.make("project-unity"),
      httpBaseUrl: "http://127.0.0.1:3000",
      httpAuthorization: null,
    };

    await fetchUnitySetupProbe(input);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    const request = new Request(url as URL, init as RequestInit);
    expect(await request.json()).toEqual({ projectId: "project-unity" });
  });

  it("rejects when the server response does not match UnitySetupProbeResult", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ malformed: true })));

    await expect(
      fetchUnitySetupProbe({
        projectId: ProjectId.make("project-unity"),
        httpBaseUrl: "http://127.0.0.1:3000",
        httpAuthorization: null,
      }),
    ).rejects.toBeTruthy();
  });

  it("resolves with the decoded result for a well-formed response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          facts: {
            isUnityProject: true,
            cliAvailable: true,
            cliDiscoveredPath: null,
            lockfilePresent: true,
            pipelinePackage: {
              installed: true,
              resolvedVersion: "1.0.0",
              declaredInManifest: true,
            },
            selectionPackage: {
              installed: true,
              resolvedVersion: "1.0.0",
              declaredInManifest: true,
            },
            selectionPublisherRegistered: true,
            withinPairingGraceWindow: false,
          },
          primary: { state: "S11" },
        }),
      ),
    );

    const result = await fetchUnitySetupProbe({
      projectId: ProjectId.make("project-unity"),
      httpBaseUrl: "http://127.0.0.1:3000",
      httpAuthorization: null,
    });

    expect(result.primary).toEqual({ state: "S11" });
    expect(result.facts.isUnityProject).toBe(true);
  });
});
