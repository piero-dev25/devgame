// The import fetchers send only opaque project ids, the reviewed plan's id and
// the user's choices to the prepared environment's own origin, and report the
// server's answer as it was given.
import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";

import { primaryPreparedConnection } from "../lib/preparedConnectionFixture";
import {
  fetchImportStatus,
  MrMakImportStatusError,
  postImportApply,
  postImportPlan,
} from "./fetchMrMakImport";

afterEach(() => {
  vi.unstubAllGlobals();
});

const MRMAK = ProjectId.make("project-mrmak");
const COMPARISON = ProjectId.make("project-comparison");
const REMOTE = "https://remote.example.test:8443";

const summaryBody = {
  planId: "plan-1",
  source: { path: "/projects/mr-mak", revision: "6248c9ec", branch: "main", dirtyPaths: [] },
  destination: { path: "/projects/comparison", kind: "empty" },
  roots: ["workspace"],
  totals: {
    files: 1,
    bytes: 10,
    new: 1,
    existsIdentical: 0,
    existsDifferent: 0,
    exclusions: 0,
    issues: 0,
  },
  conflicts: [],
  skills: [],
  skillFiles: { fullTreeFiles: 0, distributionFiles: 0 },
  exclusions: [],
  requirements: [],
  issues: [],
  excludedStores: [],
};

async function sentRequest(fetchMock: ReturnType<typeof vi.fn>) {
  const [url, init] = fetchMock.mock.calls[0] ?? [];
  const request = new Request(url as URL, init as RequestInit);
  return { url: request.url, body: await request.json() };
}

describe("Mr. Mak import fetchers", () => {
  it("dry-runs with only the two opaque project ids, on the selected environment", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(summaryBody));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await postImportPlan({
      prepared: primaryPreparedConnection({ httpBaseUrl: REMOTE }),
      sourceProjectId: MRMAK,
      destinationProjectId: COMPARISON,
    });

    expect(await sentRequest(fetchMock)).toEqual({
      url: `${REMOTE}/api/project-import/plan`,
      body: { sourceProjectId: "project-mrmak", destinationProjectId: "project-comparison" },
    });
    expect(outcome).toMatchObject({ _tag: "ok", value: { planId: "plan-1" } });
  });

  it("applies the reviewed plan with the user's choices and reports a refusal as given", async () => {
    const message = "The source or destination changed since the dry run.";
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ _tag: "error", message }));
    vi.stubGlobal("fetch", fetchMock);
    const request = {
      sourceProjectId: MRMAK,
      destinationProjectId: COMPARISON,
      planId: "plan-1",
      choices: { "docs/readme.md": "take-source" as const },
      skillChoices: [{ skill: "alpha", action: "keep-existing" as const }],
      confirmExistingProject: false,
    };

    const outcome = await postImportApply({ prepared: primaryPreparedConnection(), request });

    expect((await sentRequest(fetchMock)).body).toEqual(request);
    expect(outcome).toEqual({ _tag: "refused", message });
  });

  it("turns a scope 403 into notPermitted and a malformed body into failed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("Forbidden: insufficient scope", { status: 403 })),
    );
    const request = {
      sourceProjectId: MRMAK,
      destinationProjectId: COMPARISON,
      planId: "plan-1",
      choices: {},
      skillChoices: [],
      confirmExistingProject: false,
    };
    expect(await postImportApply({ prepared: primaryPreparedConnection(), request })).toEqual({
      _tag: "notPermitted",
    });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ planId: 7 })));
    expect(
      await postImportPlan({
        prepared: primaryPreparedConnection(),
        sourceProjectId: MRMAK,
        destinationProjectId: COMPARISON,
      }),
    ).toEqual({ _tag: "failed", message: "It answered with a response this app could not read." });
  });

  it("reads status by project id, rejecting the server's typed error with its message", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ import: null }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      fetchImportStatus({ prepared: primaryPreparedConnection(), projectId: COMPARISON }),
    ).resolves.toEqual({ import: null });
    expect((await sentRequest(fetchMock)).body).toEqual({ projectId: "project-comparison" });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ _tag: "error", message: "Project not found." })),
    );
    const rejection = fetchImportStatus({
      prepared: primaryPreparedConnection(),
      projectId: COMPARISON,
    });
    await expect(rejection).rejects.toBeInstanceOf(MrMakImportStatusError);
    await expect(rejection).rejects.toMatchObject({ message: "Project not found." });
  });
});
