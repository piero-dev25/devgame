// Proves `postUnityPipelineInstall` actually validates the HTTP response it
// gets back, rather than trusting a compile-time cast (#99's sibling target
// — see fetchSetupProbe.test.ts for the same shape on the read-only probe).
// The malformed case is load-bearing: before the real
// `Schema.decodeUnknownEffect` decode was wired in, this exact test failed
// (the promise RESOLVED with `{ malformed: true }` reinterpreted as a
// `UnityPipelineInstallResult`).
import { afterEach, describe, expect, it, vi } from "@effect/vitest";

import { postUnityPipelineInstall } from "./postPipelineInstall";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("postUnityPipelineInstall", () => {
  it("rejects when the server response does not match UnityPipelineInstallResult", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ malformed: true })));

    await expect(
      postUnityPipelineInstall({ httpBaseUrl: "http://127.0.0.1:3000", httpAuthorization: null }),
    ).rejects.toBeTruthy();
  });

  it("resolves with the decoded result for a well-formed response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ _tag: "notReady" })));

    const result = await postUnityPipelineInstall({
      httpBaseUrl: "http://127.0.0.1:3000",
      httpAuthorization: null,
    });

    expect(result).toEqual({ _tag: "notReady" });
  });
});
