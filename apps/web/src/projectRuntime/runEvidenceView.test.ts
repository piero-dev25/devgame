// Run evidence as the Run and Workspace panels show it: what the server
// recorded and judged, never upgraded on the client.
import type { RunEvidenceRecord, RunEvidenceView, RunStatusSuccess } from "@t3tools/contracts";
import { ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { cardEvidence, latestProfileEvidence, toRunEvidenceSummary } from "./runEvidenceView";

const HEAD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const BUILD_SHA = "f".repeat(64);
const PROBE = "VFX capture probe:.*effect age 0\\.65(,|$)";

const record = (overrides: Partial<RunEvidenceRecord> = {}): RunEvidenceRecord => ({
  schema: "devgame.run-evidence/1",
  runId: "run-1",
  projectId: ProjectId.make("project-1"),
  profileId: "capture-fire-front-0.65",
  threadId: null,
  workspaceCard: { entityId: "fire-front", stepPath: null },
  source: { revision: HEAD, dirty: false },
  build: {
    path: "Runtime/out/game",
    bytes: 10,
    mtime: "2026-10-03T09:00:00.000Z",
    sha256: BUILD_SHA,
  },
  startedAt: "2026-10-03T10:00:00.000Z",
  endedAt: "2026-10-03T10:00:03.000Z",
  registeredAt: "2026-10-03T10:00:03.100Z",
  runStatus: "exited",
  exitCode: 0,
  signal: null,
  log: {
    absolutePath: "/state/runs/project-1/run-1/run.log",
    exists: true,
    bytes: 120,
    bytesReceived: 120,
    sha256: "e".repeat(64),
    problem: null,
  },
  checks: [{ pattern: PROBE, status: "matched", line: "VFX capture probe: effect age 0.65, ok" }],
  artifacts: [
    {
      name: "capture",
      kind: "image",
      location: "run",
      path: "fire-front.png",
      absolutePath: "/state/runs/project-1/run-1/fire-front.png",
      exists: true,
      bytes: 2048,
      sha256: "c".repeat(64),
      problem: null,
    },
    {
      name: "report",
      kind: "file",
      location: "project",
      path: "work/reports/fire.html",
      absolutePath: "/game/work/reports/fire.html",
      exists: true,
      bytes: 300,
      sha256: "d".repeat(64),
      problem: null,
    },
  ],
  outcome: "passed",
  failures: [],
  ...overrides,
});

const view = (
  overrides: Partial<RunEvidenceRecord> = {},
  freshness: RunEvidenceView["freshness"] = "fresh",
  freshnessReasons: ReadonlyArray<string> = [],
): RunEvidenceView => ({ record: record(overrides), freshness, freshnessReasons });

const status = (evidence?: ReadonlyArray<RunEvidenceView>): RunStatusSuccess => ({
  profiles: [],
  profilesError: null,
  runs: [],
  ...(evidence === undefined ? {} : { evidence }),
});

describe("toRunEvidenceSummary", () => {
  it("shows a passing, current run with its provenance, checks and artifacts", () => {
    const summary = toRunEvidenceSummary(view());

    expect(summary).toMatchObject({
      passed: true,
      freshness: "fresh",
      freshnessLabel: "Current",
      sourceLabel: "Source a1b2c3d4e5f6",
      buildLabel: "Build Runtime/out/game · sha256 ffffffffffff",
      failures: [],
    });
    expect(summary.checks).toEqual([
      {
        key: `0:${PROBE}`,
        pattern: PROBE,
        ok: true,
        label: "Matched",
        line: "VFX capture probe: effect age 0.65, ok",
      },
    ]);
    expect(summary.artifacts.map((row) => [row.name, row.path, row.openPath, row.detail])).toEqual([
      // In the run's own directory, outside the project: listed, never opened.
      [
        "capture",
        "/state/runs/project-1/run-1/fire-front.png",
        null,
        "2.0 KB · sha256 cccccccccccc",
      ],
      ["report", "work/reports/fire.html", "work/reports/fire.html", "300 B · sha256 dddddddddddd"],
    ]);
  });

  it("keeps a stale run's reasons and never shows it as current", () => {
    const reason = "Source changed: HEAD is 0123456789ab, the run used a1b2c3d4e5f6.";

    const summary = toRunEvidenceSummary(view({}, "stale", [reason]));

    expect(summary.freshnessLabel).toBe("Stale");
    expect(summary.freshnessReasons).toEqual([reason]);
    expect(summary.passed).toBe(true);
  });

  it("shows a failed run's failures, a wrong capture age and a missing capture", () => {
    const summary = toRunEvidenceSummary(
      view({
        outcome: "failed",
        failures: ['Log line "VFX capture probe: effect age 0.50" does not match /x/.'],
        checks: [
          { pattern: PROBE, status: "mismatch", line: "VFX capture probe: effect age 0.50" },
          { pattern: "screenshot saved:", status: "missing", line: null },
        ],
        artifacts: [
          {
            ...record().artifacts[1]!,
            exists: false,
            bytes: null,
            sha256: null,
            problem: "Not found.",
          },
        ],
      }),
    );

    expect(summary.passed).toBe(false);
    expect(summary.failures).toHaveLength(1);
    expect(summary.checks.map((check) => [check.ok, check.label, check.line])).toEqual([
      [false, "Wrong value", "VFX capture probe: effect age 0.50"],
      [false, "No matching line", null],
    ]);
    // A missing artifact cannot be opened, even inside the project.
    expect(summary.artifacts[0]).toMatchObject({ ok: false, openPath: null, detail: "Not found." });
  });

  it("says unknown provenance is unknown", () => {
    const summary = toRunEvidenceSummary(
      view(
        {
          source: { revision: "unknown", dirty: "unknown" },
          build: { path: "bin/game", bytes: "unknown", mtime: "unknown", sha256: "unknown" },
        },
        "unknown",
        ["The project's source revision at launch is unknown."],
      ),
    );

    expect(summary.sourceLabel).toBe("Source revision unknown");
    expect(summary.buildLabel).toBe("Build bin/game · not fingerprinted");
    expect(summary.freshnessLabel).toBe("Freshness unknown");
  });

  it("flags uncommitted changes at launch", () => {
    expect(
      toRunEvidenceSummary(view({ source: { revision: HEAD, dirty: true } })).sourceLabel,
    ).toBe("Source a1b2c3d4e5f6 with uncommitted changes");
  });
});

describe("latestProfileEvidence", () => {
  it("picks the profile's record, and none from a server without evidence", () => {
    const evidence = [view({ runId: "run-2", profileId: "arena" }), view()];

    expect(latestProfileEvidence(status(evidence), "capture-fire-front-0.65")?.runId).toBe("run-1");
    expect(latestProfileEvidence(status(evidence), "other")).toBeNull();
    expect(latestProfileEvidence(status(), "arena")).toBeNull();
  });
});

describe("cardEvidence", () => {
  const evidence = [
    view({ runId: "older", endedAt: "2026-10-03T09:00:00.000Z" }),
    view({ runId: "unlinked", workspaceCard: null }),
    view({ runId: "newer", profileId: "p2", endedAt: "2026-10-03T11:00:00.000Z" }),
    view({ runId: "other-card", workspaceCard: { entityId: "smoke", stepPath: null } }),
  ];

  it("lists the card's linked records, newest first", () => {
    const result = cardEvidence({ data: { status: status(evidence) }, error: null }, "fire-front");

    expect(result.map((item) => item.runId)).toEqual(["newer", "older"]);
  });

  it("shows nothing after a failed read, even with an earlier read in hand", () => {
    expect(
      cardEvidence({ data: { status: status(evidence) }, error: "offline" }, "fire-front"),
    ).toEqual([]);
    expect(cardEvidence({ data: null, error: null }, "fire-front")).toEqual([]);
  });
});
