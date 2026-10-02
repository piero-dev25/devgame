// `fetchProjectWorkspace` decodes the response through the contract rather
// than trusting it, keeps "no registry" distinct from a server error, and
// posts to the prepared environment's own origin.
import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";

import { primaryPreparedConnection } from "../lib/preparedConnectionFixture";
import { fetchProjectWorkspace, ProjectWorkspaceServerError } from "./fetchProjectWorkspace";

afterEach(() => {
  vi.unstubAllGlobals();
});

const PROJECT_ID = ProjectId.make("project-workspace");

const registryBody = {
  manifest: {
    entities: [
      {
        id: "pitch",
        title: "Pitch",
        folder: "pitch",
        type: "group",
        defaultStep: 0,
        steps: [
          {
            name: "Report",
            path: "report.md",
            relativePath: "workspace/pitch/report.md",
            exists: true,
          },
          {
            name: "Deck",
            path: "deck.html",
            relativePath: "workspace/pitch/deck.html",
            exists: false,
            issue: "missing",
          },
        ],
      },
    ],
    issues: [
      {
        kind: "step-missing",
        entityId: "pitch",
        stepIndex: 1,
        message: 'Step "deck.html" does not exist.',
      },
    ],
  },
};

const requestOf = (fetchMock: ReturnType<typeof vi.fn>) => {
  const [url, init] = fetchMock.mock.calls[0] ?? [];
  return new Request(url as URL, init as RequestInit);
};

describe("fetchProjectWorkspace", () => {
  it("posts only the opaque projectId to the prepared environment's own origin", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ manifest: null }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchProjectWorkspace({
      projectId: PROJECT_ID,
      prepared: primaryPreparedConnection({ httpBaseUrl: "https://remote.example.test:8443" }),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = requestOf(fetchMock);
    expect(request.url).toBe("https://remote.example.test:8443/api/project-workspace/read");
    expect(request.method).toBe("POST");
    expect(await request.json()).toEqual({ projectId: "project-workspace" });
  });

  it("resolves a decoded registry with its step checks and issues", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(registryBody)));

    const result = await fetchProjectWorkspace({
      projectId: PROJECT_ID,
      prepared: primaryPreparedConnection(),
    });

    expect(result.manifest?.entities[0]?.steps.map((step) => step.exists)).toEqual([true, false]);
    expect(result.manifest?.issues[0]?.kind).toBe("step-missing");
  });

  it("resolves manifest: null when the project has no registry", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ manifest: null })));

    await expect(
      fetchProjectWorkspace({ projectId: PROJECT_ID, prepared: primaryPreparedConnection() }),
    ).resolves.toEqual({ manifest: null });
  });

  it("rejects with the server's message for a malformed registry or unknown project", async () => {
    for (const message of [
      "workspace/workspace.json is not a valid workspace registry: bad",
      "Project not found.",
    ]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ _tag: "error", message })));
      const rejection = fetchProjectWorkspace({
        projectId: PROJECT_ID,
        prepared: primaryPreparedConnection(),
      });
      await expect(rejection).rejects.toBeInstanceOf(ProjectWorkspaceServerError);
      await expect(rejection).rejects.toMatchObject({ message });
    }
  });

  it("rejects a body that does not match the contract", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ manifest: { entities: "nope" } })),
    );

    await expect(
      fetchProjectWorkspace({ projectId: PROJECT_ID, prepared: primaryPreparedConnection() }),
    ).rejects.toMatchObject({ _tag: "SchemaError" });
  });

  it("rejects a 403 scope refusal instead of resolving", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("Forbidden: insufficient scope", { status: 403 })),
    );

    await expect(
      fetchProjectWorkspace({ projectId: PROJECT_ID, prepared: primaryPreparedConnection() }),
    ).rejects.toBeTruthy();
  });
});
