// `fetchRuntimeStatus` posts only the opaque projectId to the selected
// environment's own origin and decodes the reply through the contract.
import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";

import { primaryPreparedConnection } from "../lib/preparedConnectionFixture";
import { fetchRuntimeStatus, RuntimeStatusServerError } from "./fetchRuntimeStatus";

afterEach(() => {
  vi.unstubAllGlobals();
});

const PROJECT_ID = ProjectId.make("project-kaigen");

const statusBody = {
  profiles: [{ id: "vfx-arena", name: "VFX arena", valid: true, issues: [] }],
  profilesError: null,
  runs: [
    {
      runId: "run-1",
      profileId: "vfx-arena",
      threadId: null,
      status: "exited",
      pid: 41,
      exitCode: 3,
      signal: null,
      error: null,
      startedAt: "2026-10-03T10:00:00.000Z",
      endedAt: "2026-10-03T10:00:05.000Z",
      logTail: "boot\ncrash\n",
    },
  ],
};

describe("fetchRuntimeStatus", () => {
  it("posts only the opaque projectId to the selected environment's origin", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(statusBody));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchRuntimeStatus({
      projectId: PROJECT_ID,
      prepared: primaryPreparedConnection({ httpBaseUrl: "https://remote.example.test:8443" }),
    });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    const request = new Request(url as URL, init as RequestInit);
    expect(request.url).toBe("https://remote.example.test:8443/api/project-runtime/status");
    expect(await request.json()).toEqual({ projectId: "project-kaigen" });
    expect(result.runs[0]?.exitCode).toBe(3);
  });

  it("rejects with the server's message for its typed error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ _tag: "error", message: "Project not found." })),
    );
    const rejection = fetchRuntimeStatus({
      projectId: PROJECT_ID,
      prepared: primaryPreparedConnection(),
    });
    await expect(rejection).rejects.toBeInstanceOf(RuntimeStatusServerError);
    await expect(rejection).rejects.toMatchObject({ message: "Project not found." });
  });

  it("rejects a body that does not match the contract", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ ...statusBody, runs: [{ ...statusBody.runs[0], status: "zombie" }] }),
        ),
    );
    await expect(
      fetchRuntimeStatus({ projectId: PROJECT_ID, prepared: primaryPreparedConnection() }),
    ).rejects.toMatchObject({ _tag: "SchemaError" });
  });
});
