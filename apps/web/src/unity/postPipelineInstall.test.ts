// Proves `postUnityPipelineInstall` actually validates the HTTP response it
// gets back, rather than trusting a compile-time cast (#99's sibling target
// — see fetchSetupProbe.test.ts for the same shape on the read-only probe).
// The malformed case is load-bearing: before the real
// `Schema.decodeUnknownEffect` decode was wired in, this exact test failed
// (the promise RESOLVED with `{ malformed: true }` reinterpreted as a
// `UnityPipelineInstallResult`).
import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";

import { postUnityPipelineInstall } from "./postPipelineInstall";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("postUnityPipelineInstall", () => {
  it("sends the opaque projectId in the request body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ _tag: "notReady" }));
    vi.stubGlobal("fetch", fetchMock);
    const input = {
      projectId: ProjectId.make("project-unity"),
      httpBaseUrl: "http://127.0.0.1:3000",
      httpAuthorization: null,
    };

    await postUnityPipelineInstall(input);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    const request = new Request(url as URL, init as RequestInit);
    expect(await request.json()).toEqual({ projectId: "project-unity" });
  });

  it("rejects when the server response does not match UnityPipelineInstallResult", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ malformed: true })));

    await expect(
      postUnityPipelineInstall({
        projectId: ProjectId.make("project-unity"),
        httpBaseUrl: "http://127.0.0.1:3000",
        httpAuthorization: null,
      }),
    ).rejects.toBeTruthy();
  });

  it("resolves with both decoded package outcomes for a well-formed success response", async () => {
    const response = {
      _tag: "ok",
      value: { packageId: "com.unity.pipeline", version: "1.2.3", alreadyInstalled: false },
      selectionPackage: {
        packageId: "com.ironmind.editor-presence",
        version: "0.3.0",
        operation: "installed",
      },
      pairingOutcome: { _tag: "minted" },
    } as const;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(response)));

    const result = await postUnityPipelineInstall({
      projectId: ProjectId.make("project-unity"),
      httpBaseUrl: "http://127.0.0.1:3000",
      httpAuthorization: null,
    });

    expect(result).toEqual(response);
  });
});
