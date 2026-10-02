// The Run panel's truthfulness rules: nothing is shown as running unless the
// server said so through the current connection, and every action is off
// while what is shown is only "last known".
import type { RunEvidenceView, RunState, RunStatusSuccess } from "@t3tools/contracts";
import { ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isRuntimeLogPinned,
  resolveRuntimePanelView,
  RUNTIME_LOG_LINE_CAP,
  type RuntimePanelView,
  type RuntimeProfileRow,
} from "./resolveRuntimePanelView";

const T = Date.UTC(2026, 9, 3, 10, 0, 0);

const run = (overrides: Partial<RunState> = {}): RunState => ({
  runId: "run-1",
  profileId: "arena",
  threadId: null,
  status: "running",
  pid: 42,
  exitCode: null,
  signal: null,
  error: null,
  startedAt: "2026-10-03T10:00:00.000Z",
  endedAt: null,
  logTail: "boot\nready\n",
  ...overrides,
});

const status = (runs: RunState[] = [], overrides: Partial<RunStatusSuccess> = {}) => ({
  profiles: [{ id: "arena", name: "VFX arena", valid: true, issues: [] }],
  profilesError: null,
  runs,
  ...overrides,
});

type Input = Parameters<typeof resolveRuntimePanelView>[0];

function resolve(overrides: Partial<Input> & { runs?: RunState[]; status?: RunStatusSuccess }) {
  const { runs, status: statusOverride, ...rest } = overrides;
  return resolveRuntimePanelView({
    engine: "unknown",
    connectionReady: true,
    query: {
      data: { status: statusOverride ?? status(runs), requestedAt: T, onCurrentConnection: true },
      error: null,
    },
    receipt: null,
    pending: null,
    selectedProfileId: null,
    ...rest,
  });
}

function statusView(view: RuntimePanelView) {
  if (view.kind !== "status") throw new Error(`Expected a status view, got ${view.kind}.`);
  return view;
}

const arena = (view: RuntimePanelView): RuntimeProfileRow => {
  const row = statusView(view).rows.find((candidate) => candidate.profileId === "arena");
  if (!row) throw new Error("No arena row.");
  return row;
};

describe("resolveRuntimePanelView: never a fabricated running state", () => {
  it("shows a failed refresh with previous 'running' data as last known, with Stop off", () => {
    const view = statusView(
      resolve({
        query: {
          data: { status: status([run()]), requestedAt: T, onCurrentConnection: true },
          error: "Remote environment endpoint returned undeclared status 502.",
        },
      }),
    );
    expect(view.live).toBe(false);
    expect(view.banner?.kind).toBe("error");
    expect(view.asOf).toBe(T);
    expect(arena(view).run?.status).toBe("running");
    expect(arena(view).canStop).toBe(false);
    expect(arena(view).canLaunch).toBe(false);
  });

  it("shows an offline environment's previous 'running' data as last known, with Stop off", () => {
    const view = statusView(resolve({ connectionReady: false, runs: [run()] }));
    expect(view.banner?.kind).toBe("offline");
    expect(view.live).toBe(false);
    expect(arena(view).canStop).toBe(false);
  });

  it("does not trust a read from before a reconnect until the new read lands", () => {
    const view = statusView(
      resolve({
        query: {
          data: { status: status([run()]), requestedAt: T, onCurrentConnection: false },
          error: null,
        },
      }),
    );
    expect(view.banner?.kind).toBe("reconnecting");
    expect(arena(view).canStop).toBe(false);
  });

  it("shows a pending launch on the button only, never as 'starting' before the server answers", () => {
    const row = arena(resolve({ pending: { kind: "start", profileId: "arena" } }));
    expect(row.pendingLabel).toBe("Launching…");
    expect(row.run).toBeNull();
    expect(row.canLaunch).toBe(false);
  });

  it("shows the server's start receipt until a read requested after it, which then wins", () => {
    const receipt = { run: run({ status: "starting", pid: null }), receivedAt: T + 1 };
    expect(arena(resolve({ receipt })).run?.label).toBe("Starting");
    expect(arena(resolve({ receipt })).canStop).toBe(true);

    // A read sent after the receipt no longer lists the run (the server restarted).
    const newer = resolve({
      receipt,
      query: {
        data: { status: status([]), requestedAt: T + 2, onCurrentConnection: true },
        error: null,
      },
    });
    expect(arena(newer).run).toBeNull();

    // And a receipt is never layered over a last-known snapshot.
    expect(arena(resolve({ receipt, connectionReady: false })).run).toBeNull();
  });
});

describe("resolveRuntimePanelView: launch and stop", () => {
  it("enables Launch only for a valid profile whose run is absent or ended", () => {
    expect(arena(resolve({ runs: [] })).canLaunch).toBe(true);
    expect(arena(resolve({ runs: [run()] })).canLaunch).toBe(false);
    expect(arena(resolve({ runs: [run()] })).canStop).toBe(true);
    for (const ended of ["exited", "stopped", "launchFailed"] as const) {
      expect(arena(resolve({ runs: [run({ status: ended })] })).canLaunch).toBe(true);
      expect(arena(resolve({ runs: [run({ status: ended })] })).canStop).toBe(false);
    }
  });

  it("explains a profile whose executable is missing and keeps Launch off", () => {
    const row = arena(
      resolve({
        status: status([], {
          profiles: [
            {
              id: "arena",
              name: "VFX arena",
              valid: false,
              issues: [
                {
                  kind: "executable-missing",
                  message: "Runtime/out/macos/debug/kaigen-horde-spike does not exist.",
                },
              ],
            },
          ],
        }),
      }),
    );
    expect(row.canLaunch).toBe(false);
    expect(row.unavailableReason).toBe(
      "Runtime/out/macos/debug/kaigen-horde-spike does not exist.",
    );
  });

  it("keeps a running run of a profile removed from the manifest stoppable", () => {
    const view = statusView(resolve({ runs: [run({ profileId: "old" })] }));
    const old = view.rows.find((row) => row.profileId === "old");
    expect(old?.canStop).toBe(true);
    expect(old?.canLaunch).toBe(false);
    expect(old?.unavailableReason).toBe("No longer listed in devgame.runtime.json.");
  });

  it("states how a run ended: exit code, signal or launch failure", () => {
    const label = (overrides: Partial<RunState>) => arena(resolve({ runs: [run(overrides)] })).run;
    expect(label({ status: "exited", exitCode: 3 })).toMatchObject({
      label: "Exited with code 3",
      tone: "error",
    });
    expect(label({ status: "exited", exitCode: 0 })?.tone).toBe("ok");
    expect(label({ status: "exited", signal: "SIGSEGV" })?.label).toBe("Exited on signal SIGSEGV");
    expect(label({ status: "launchFailed", pid: null, error: "EACCES" })).toMatchObject({
      label: "Failed to launch: EACCES",
      tone: "error",
    });
    expect(label({ status: "stopped" })?.label).toBe("Stopped");
    expect(label({})?.label).toBe("Running · pid 42");
  });

  it("caps the rendered log tail to the newest lines", () => {
    const lines = Array.from({ length: RUNTIME_LOG_LINE_CAP + 50 }, (_, index) => `line ${index}`);
    const shown = arena(resolve({ runs: [run({ logTail: `${lines.join("\n")}\n` })] })).run;
    expect(shown?.logLines).toHaveLength(RUNTIME_LOG_LINE_CAP);
    expect(shown?.logLines.at(-1)).toBe(`line ${lines.length - 1}`);
    expect(shown?.logTruncated).toBe(true);
  });
});

describe("isRuntimeLogPinned: the log follows the newest output", () => {
  it("follows new lines while the reader is at the bottom, including a fresh log", () => {
    // A log that fits the view is at its end.
    expect(isRuntimeLogPinned({ scrollTop: 0, scrollHeight: 100, clientHeight: 100 })).toBe(true);
    expect(isRuntimeLogPinned({ scrollTop: 900, scrollHeight: 1200, clientHeight: 300 })).toBe(
      true,
    );
    // Within a line of the end still counts as the end.
    expect(isRuntimeLogPinned({ scrollTop: 890, scrollHeight: 1200, clientHeight: 300 })).toBe(
      true,
    );
  });

  it("stops following once the reader scrolls up to older lines", () => {
    expect(isRuntimeLogPinned({ scrollTop: 0, scrollHeight: 1200, clientHeight: 300 })).toBe(false);
    expect(isRuntimeLogPinned({ scrollTop: 600, scrollHeight: 1200, clientHeight: 300 })).toBe(
      false,
    );
  });
});

describe("resolveRuntimePanelView: missing manifest", () => {
  it("guides toward devgame.runtime.json when there are no profiles", () => {
    const view = statusView(resolve({ status: status([], { profiles: [] }) }));
    expect(view.rows).toEqual([]);
    expect(view.guidance).toMatch(/devgame\.runtime\.json/);
  });

  it("says no engine was detected for a project that is not a game", () => {
    const generic = statusView(resolve({ status: status([], { profiles: [] }) })).guidance;
    const notGame = statusView(
      resolve({ engine: "none", status: status([], { profiles: [] }) }),
    ).guidance;
    expect(notGame).not.toBe(generic);
    expect(notGame).toMatch(/No game engine was detected/);
  });

  it("shows an unreadable manifest's error instead of guidance, and still lists runs", () => {
    const view = statusView(
      resolve({
        status: status([run({ profileId: "arena" })], {
          profiles: [],
          profilesError: "devgame.runtime.json is not valid JSON.",
        }),
      }),
    );
    expect(view.guidance).toBeNull();
    expect(view.profilesError).toBe("devgame.runtime.json is not valid JSON.");
    expect(view.rows.map((row) => row.profileId)).toEqual(["arena"]);
    // The profile may still be in the file; it just failed to parse.
    const row = arena(view);
    expect(row.unavailableReason).toMatch(/could not be read/);
    expect(row.unavailableReason).not.toMatch(/No longer listed/);
    expect(row.canStop).toBe(true);
    expect(row.canLaunch).toBe(false);
  });

  it("shows a profile's recorded evidence even when the server no longer lists its run", () => {
    const evidence: RunEvidenceView = {
      record: {
        schema: "devgame.run-evidence/1",
        runId: "run-before-restart",
        projectId: ProjectId.make("project-1"),
        profileId: "arena",
        threadId: null,
        workspaceCard: null,
        source: { revision: "unknown", dirty: "unknown" },
        build: { path: "bin/game", bytes: "unknown", mtime: "unknown", sha256: "unknown" },
        startedAt: "2026-10-03T09:00:00.000Z",
        endedAt: "2026-10-03T09:00:05.000Z",
        registeredAt: "2026-10-03T09:00:05.000Z",
        runStatus: "exited",
        exitCode: 3,
        signal: null,
        log: {
          absolutePath: "/state/run.log",
          exists: true,
          bytes: 10,
          bytesReceived: 10,
          sha256: null,
          problem: null,
        },
        checks: [],
        artifacts: [],
        outcome: "failed",
        failures: ["The program exited with code 3."],
      },
      freshness: "stale",
      freshnessReasons: ["Build changed: bin/game is gone or unreadable now."],
    };

    const row = arena(statusView(resolve({ status: status([], { evidence: [evidence] }) })));

    expect(row.run).toBeNull();
    expect(row.evidence).toMatchObject({
      runId: "run-before-restart",
      passed: false,
      freshnessLabel: "Stale",
      failures: ["The program exited with code 3."],
    });
  });

  it("is loading before the first read, and offline with nothing known when never read", () => {
    const empty = { data: null, error: null };
    expect(resolve({ query: empty }).kind).toBe("loading");
    const offline = statusView(resolve({ query: empty, connectionReady: false }));
    expect(offline.banner?.kind).toBe("offline");
    expect(offline.rows).toEqual([]);
  });
});
