// Proves `fetchGenerationList` actually DECODES the HTTP response through
// `GenerationListResult` rather than trusting a compile-time cast — same
// #99/#100 fix class `fetchSetupProbe.test.ts` already proves for the Unity
// probe, applied here. The malformed case is the load-bearing one: without
// the real `Schema.decodeUnknownEffect` decode wired in, a malformed body
// would resolve as if it were a real `GenerationListSuccess`.
import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";

import { fetchGenerationList } from "./fetchGenerationList";

afterEach(() => {
  vi.unstubAllGlobals();
});

const wellFormedBody = {
  entries: [
    {
      job: {
        id: "gen_1",
        projectId: "project-gen",
        threadId: "thread-1",
        modality: "model3d",
        provider: "tripo",
        providerTaskId: "provider-task-1",
        status: "succeeded",
        progress: 100,
        prompt: "a wooden barrel",
        parameters: {},
        assetId: "asset_1",
        error: null,
        createdAt: 1_000,
        startedAt: 1_100,
        completedAt: 1_500,
      },
      asset: {
        id: "asset_1",
        projectId: "project-gen",
        generationJobId: "gen_1",
        modality: "model3d",
        provider: "tripo",
        files: { glb: "generated/project-gen/asset_1/model.glb" },
        preview: { imageUrl: "https://tripo.example/render.png" },
        metadata: { triangles: 4200, materials: 1, images: 3, fileBytes: 654_321 },
        createdAt: 1_500,
      },
      previewMediaUrl: "/api/generation-assets/token.signature",
    },
  ],
};

describe("fetchGenerationList", () => {
  it("sends the opaque projectId in the request body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(wellFormedBody));
    vi.stubGlobal("fetch", fetchMock);

    await fetchGenerationList({
      projectId: ProjectId.make("project-gen"),
      httpBaseUrl: "http://127.0.0.1:3000",
      httpAuthorization: null,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    const request = new Request(url as URL, init as RequestInit);
    expect(await request.json()).toEqual({ projectId: "project-gen" });
  });

  it("rejects when the server response does not match GenerationListResult", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ malformed: true })));

    await expect(
      fetchGenerationList({
        projectId: ProjectId.make("project-gen"),
        httpBaseUrl: "http://127.0.0.1:3000",
        httpAuthorization: null,
      }),
    ).rejects.toBeTruthy();
  });

  it("resolves with the decoded result for a well-formed response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(wellFormedBody)));

    const result = await fetchGenerationList({
      projectId: ProjectId.make("project-gen"),
      httpBaseUrl: "http://127.0.0.1:3000",
      httpAuthorization: null,
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.job.status).toBe("succeeded");
    expect(result.entries[0]?.asset?.metadata.triangles).toBe(4200);
    expect(result.entries[0]?.previewMediaUrl).toBe("/api/generation-assets/token.signature");
  });

  it("rejects with the server's typed error message on an unresolved project", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ _tag: "error", message: "Project not found." })),
    );

    await expect(
      fetchGenerationList({
        projectId: ProjectId.make("project-unknown"),
        httpBaseUrl: "http://127.0.0.1:3000",
        httpAuthorization: null,
      }),
    ).rejects.toMatchObject({ message: "Project not found." });
  });
});
