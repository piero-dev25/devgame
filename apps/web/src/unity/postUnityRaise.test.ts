import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";

import { describeUnityRaiseFailure, postUnityRaise } from "./postUnityRaise";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("postUnityRaise", () => {
  it("sends the opaque projectId in the request body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ _tag: "raised" }));
    vi.stubGlobal("fetch", fetchMock);

    await postUnityRaise({
      projectId: ProjectId.make("project-unity"),
      httpBaseUrl: "http://127.0.0.1:3000",
      httpAuthorization: null,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    const request = new Request(url as URL, init as RequestInit);
    expect(await request.json()).toEqual({ projectId: "project-unity" });
  });

  it("rejects a response that does not decode as UnityRaiseResult", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ _tag: "unknown" })));

    await expect(
      postUnityRaise({
        projectId: ProjectId.make("project-unity"),
        httpBaseUrl: "http://127.0.0.1:3000",
        httpAuthorization: null,
      }),
    ).rejects.toBeTruthy();
  });
});

describe("describeUnityRaiseFailure", () => {
  it("returns no toast report for either successful outcome", () => {
    expect(describeUnityRaiseFailure({ _tag: "raised" })).toBeNull();
    expect(describeUnityRaiseFailure({ _tag: "coldStartStarted" })).toBeNull();
  });

  it("maps a typed server failure to the failure-only toast copy", () => {
    expect(describeUnityRaiseFailure({ _tag: "error", message: "Project not found." })).toEqual({
      type: "error",
      title: "Could not bring Unity to the front",
      description: "Project not found.",
    });
  });
});
