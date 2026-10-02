// Launch and stop go to the selected environment's own origin with only
// opaque ids, and the server's answer is reported as it was given: the run it
// recorded, its refusal, or a scope refusal shown as "not permitted".
import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";

import { primaryPreparedConnection } from "../lib/preparedConnectionFixture";
import { describeRuntimeCommand, postRuntimeStart, postRuntimeStop } from "./postRuntimeCommand";

afterEach(() => {
  vi.unstubAllGlobals();
});

const PROJECT_ID = ProjectId.make("project-kaigen");
const REMOTE = "https://remote.example.test:8443";

const run = {
  runId: "run-1",
  profileId: "vfx-arena",
  threadId: null,
  status: "running",
  pid: 77,
  exitCode: null,
  signal: null,
  error: null,
  startedAt: "2026-10-03T10:00:00.000Z",
  endedAt: null,
  logTail: "",
};

async function sentRequest(fetchMock: ReturnType<typeof vi.fn>) {
  const [url, init] = fetchMock.mock.calls[0] ?? [];
  const request = new Request(url as URL, init as RequestInit);
  return { url: request.url, body: await request.json() };
}

describe("postRuntimeStart / postRuntimeStop", () => {
  it("launches on the selected environment with only the opaque ids", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ run, alreadyRunning: false }));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await postRuntimeStart({
      prepared: primaryPreparedConnection({ httpBaseUrl: REMOTE }),
      projectId: PROJECT_ID,
      profileId: "vfx-arena",
      threadId: ThreadId.make("thread-1"),
    });

    expect(await sentRequest(fetchMock)).toEqual({
      url: `${REMOTE}/api/project-runtime/start`,
      body: { projectId: "project-kaigen", profileId: "vfx-arena", threadId: "thread-1" },
    });
    expect(outcome).toMatchObject({ _tag: "accepted", alreadyRunning: false });
    if (outcome._tag === "accepted") expect(outcome.run.pid).toBe(77);
  });

  it("omits threadId for a draft and stops by runId", async () => {
    const startFetch = vi.fn().mockResolvedValue(Response.json({ run, alreadyRunning: true }));
    vi.stubGlobal("fetch", startFetch);
    await postRuntimeStart({
      prepared: primaryPreparedConnection(),
      projectId: PROJECT_ID,
      profileId: "vfx-arena",
      threadId: null,
    });
    expect((await sentRequest(startFetch)).body).toEqual({
      projectId: "project-kaigen",
      profileId: "vfx-arena",
    });

    const stopFetch = vi
      .fn()
      .mockResolvedValue(Response.json({ run: { ...run, status: "stopped", pid: 77 } }));
    vi.stubGlobal("fetch", stopFetch);
    const stopped = await postRuntimeStop({
      prepared: primaryPreparedConnection({ httpBaseUrl: REMOTE }),
      projectId: PROJECT_ID,
      runId: "run-1",
    });
    expect(await sentRequest(stopFetch)).toEqual({
      url: `${REMOTE}/api/project-runtime/stop`,
      body: { projectId: "project-kaigen", runId: "run-1" },
    });
    expect(stopped).toMatchObject({ _tag: "accepted", run: { status: "stopped" } });
  });

  it("reports the server's refusal with its message", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ _tag: "error", message: 'Run profile "nope" was not found.' }),
        ),
    );
    const outcome = await postRuntimeStart({
      prepared: primaryPreparedConnection(),
      projectId: PROJECT_ID,
      profileId: "nope",
      threadId: null,
    });
    expect(outcome).toEqual({ _tag: "refused", message: 'Run profile "nope" was not found.' });
    expect(describeRuntimeCommand("start", outcome)).toBe(
      'Could not launch: Run profile "nope" was not found.',
    );
  });

  it("turns a scope 403 into notPermitted, not a generic failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("Forbidden: insufficient scope", { status: 403 })),
    );
    const outcome = await postRuntimeStop({
      prepared: primaryPreparedConnection(),
      projectId: PROJECT_ID,
      runId: "run-1",
    });
    expect(outcome).toEqual({ _tag: "notPermitted" });
    expect(describeRuntimeCommand("stop", outcome)).toMatch(/^Not permitted:/);
  });

  it("reports a body that does not match the contract as a server answer, not unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ run: { runId: "x" } })));
    const outcome = await postRuntimeStart({
      prepared: primaryPreparedConnection(),
      projectId: PROJECT_ID,
      profileId: "vfx-arena",
      threadId: null,
    });
    expect(outcome).toEqual({
      _tag: "failed",
      message: "It answered with a response this app could not read.",
    });
    expect(describeRuntimeCommand("start", outcome)).toMatch(
      /^The environment answered but did not launch the run:/,
    );
  });

  it("reports a rejected credential as the server's auth answer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json(
          {
            _tag: "EnvironmentAuthInvalidError",
            code: "auth_invalid",
            reason: "invalid_credential",
            traceId: "trace-rejected",
          },
          { status: 401 },
        ),
      ),
    );
    const outcome = await postRuntimeStart({
      prepared: primaryPreparedConnection(),
      projectId: PROJECT_ID,
      profileId: "vfx-arena",
      threadId: null,
    });
    expect(outcome).toEqual({
      _tag: "failed",
      message: "The environment rejected this client's credentials (invalid_credential).",
    });
    expect(describeRuntimeCommand("start", outcome)).not.toMatch(/Could not reach/);
  });

  it("reports a text error status other than 403 with its status", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response("Bad Request: malformed project runtime request", { status: 400 }),
        ),
    );
    const outcome = await postRuntimeStop({
      prepared: primaryPreparedConnection(),
      projectId: PROJECT_ID,
      runId: "run-1",
    });
    expect(outcome).toEqual({ _tag: "failed", message: "It answered with status 400." });
    expect(describeRuntimeCommand("stop", outcome)).toBe(
      "The environment answered but did not stop the run: It answered with status 400.",
    );
  });

  it("reports unreachable only when no answer came back", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const outcome = await postRuntimeStart({
      prepared: primaryPreparedConnection(),
      projectId: PROJECT_ID,
      profileId: "vfx-arena",
      threadId: null,
    });
    expect(outcome._tag).toBe("unreachable");
    expect(describeRuntimeCommand("start", outcome)).toMatch(
      /^Could not reach the environment to launch the run:/,
    );
  });
});
