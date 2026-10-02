/**
 * Every decision behind the Run dock panel, as plain data, so the panel stays
 * a thin renderer (apps/web has no DOM test environment).
 *
 * Truthfulness rules this enforces:
 * - Only a status read through the current connection, with no newer error,
 *   is live. Anything else (offline, a failed refresh, a reconnect whose first
 *   read has not landed) is shown as "last known" with Launch and Stop off.
 *   `useEnvironmentQuery.data` keeps the previous success after a failure, so
 *   the error is checked first.
 * - A run's state comes from the server: a status read, or a start/stop
 *   receipt. A receipt is layered over a status read only when that read was
 *   requested before the receipt arrived; a newer read always wins, so a run
 *   the server lost (a restart) is never kept alive by an old receipt.
 * - A request in flight disables the buttons and says so on the button; the
 *   run itself is never shown as starting until the server says it is.
 */
import type { EngineType, RunState, RunStatusKind, RunStatusSuccess } from "@t3tools/contracts";

import { latestProfileEvidence, type RunEvidenceSummaryView } from "./runEvidenceView";

/** Client-side cap on rendered log lines; the server already bounds the tail to a few KiB. */
export const RUNTIME_LOG_LINE_CAP = 200;

/** How close (px) to the end the log must be scrolled to keep following new lines. */
const RUNTIME_LOG_PIN_SLACK_PX = 24;

/**
 * Whether the log view should follow new output: true while the reader is at
 * (or within a line of) the newest lines, false once they scroll up to read.
 */
export function isRuntimeLogPinned(metrics: {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}): boolean {
  return (
    metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= RUNTIME_LOG_PIN_SLACK_PX
  );
}

export interface RuntimeRunView {
  readonly runId: string;
  readonly status: RunStatusKind;
  /** "Running · pid 42", "Exited with code 3", "Failed to launch: ...". */
  readonly label: string;
  readonly tone: "active" | "ok" | "error" | "neutral";
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly logLines: ReadonlyArray<string>;
  /** True when lines were dropped from the front by the client cap. */
  readonly logTruncated: boolean;
}

export interface RuntimeProfileRow {
  readonly profileId: string;
  readonly name: string;
  /** Why the profile cannot launch (manifest problem), or null. */
  readonly unavailableReason: string | null;
  /** This profile's newest run, or null. */
  readonly run: RuntimeRunView | null;
  /** The newest recorded evidence of this profile, or null. */
  readonly evidence: RunEvidenceSummaryView | null;
  readonly canLaunch: boolean;
  readonly canStop: boolean;
  /** Button text while this row's request is in flight. */
  readonly pendingLabel: "Launching…" | "Stopping…" | null;
}

export type RuntimeBanner =
  | { readonly kind: "offline"; readonly text: string }
  | { readonly kind: "error"; readonly text: string }
  | { readonly kind: "reconnecting"; readonly text: string };

export type RuntimePanelView =
  | { readonly kind: "loading" }
  | {
      readonly kind: "status";
      /** False when the rows are a last-known snapshot; every action is then off. */
      readonly live: boolean;
      readonly banner: RuntimeBanner | null;
      /** When the shown snapshot was requested, for "last known as of". */
      readonly asOf: number | null;
      readonly rows: ReadonlyArray<RuntimeProfileRow>;
      /** devgame.runtime.json could not be read; runs are still listed. */
      readonly profilesError: string | null;
      /** No profiles: what to add, or null. */
      readonly guidance: string | null;
      /** The row whose run log is shown below the list. */
      readonly selectedProfileId: string | null;
    };

export interface RuntimeReceipt {
  readonly run: RunState;
  /** Epoch ms the receipt arrived, comparable with a snapshot's `requestedAt`. */
  readonly receivedAt: number;
}

export type RuntimePendingCommand =
  | { readonly kind: "start"; readonly profileId: string }
  | { readonly kind: "stop"; readonly runId: string };

const TERMINAL: ReadonlySet<RunStatusKind> = new Set(["exited", "stopped", "launchFailed"]);

const NO_PROFILES_GUIDANCE =
  "No run profiles. Add devgame.runtime.json at the project root with a profile that names the game's executable to launch it from here.";
const NOT_A_GAME_GUIDANCE =
  "No game engine was detected in this project and it has no run profiles. To launch a custom engine build, add devgame.runtime.json at the project root.";
const REMOVED_PROFILE_REASON = "No longer listed in devgame.runtime.json.";
const UNREADABLE_MANIFEST_REASON =
  "devgame.runtime.json could not be read, so this profile's settings are unknown.";

function runLabel(run: RunState): string {
  switch (run.status) {
    case "starting":
      return "Starting";
    case "running":
      return run.pid === null ? "Running" : `Running · pid ${run.pid}`;
    case "exited":
      if (run.exitCode !== null) return `Exited with code ${run.exitCode}`;
      return run.signal === null ? "Exited" : `Exited on signal ${run.signal}`;
    case "stopped":
      return "Stopped";
    case "launchFailed":
      return `Failed to launch: ${run.error ?? "no reason given"}`;
  }
}

function runTone(run: RunState): RuntimeRunView["tone"] {
  if (run.status === "starting" || run.status === "running") return "active";
  if (run.status === "launchFailed") return "error";
  if (run.status === "exited") return run.exitCode === 0 ? "ok" : "error";
  return "neutral";
}

function toRunView(run: RunState): RuntimeRunView {
  const lines = run.logTail.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const logTruncated = lines.length > RUNTIME_LOG_LINE_CAP;
  return {
    runId: run.runId,
    status: run.status,
    label: runLabel(run),
    tone: runTone(run),
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    logLines: logTruncated ? lines.slice(-RUNTIME_LOG_LINE_CAP) : lines,
    logTruncated,
  };
}

/** Server runs, newest first, with a receipt the read predates layered in. */
function mergeReceipt(
  runs: ReadonlyArray<RunState>,
  requestedAt: number,
  receipt: RuntimeReceipt | null,
): ReadonlyArray<RunState> {
  if (receipt === null || receipt.receivedAt <= requestedAt) return runs;
  const others = runs.filter((run) => run.runId !== receipt.run.runId);
  return [receipt.run, ...others];
}

function buildRows(input: {
  status: RunStatusSuccess;
  runs: ReadonlyArray<RunState>;
  live: boolean;
  pending: RuntimePendingCommand | null;
}): ReadonlyArray<RuntimeProfileRow> {
  const latest = new Map<string, RunState>();
  for (const run of input.runs) if (!latest.has(run.profileId)) latest.set(run.profileId, run);
  const profiles = input.status.profiles.map((profile) => ({
    profileId: profile.id,
    name: profile.name,
    unavailableReason: profile.valid
      ? null
      : profile.issues.map((issue) => issue.message).join(" ") || "This profile is not valid.",
  }));
  // A run whose profile is not listed still shows, so it can be stopped. When the
  // manifest could not be read, the profile may still be in it: say that, not "removed".
  const unlistedReason =
    input.status.profilesError === null ? REMOVED_PROFILE_REASON : UNREADABLE_MANIFEST_REASON;
  for (const profileId of latest.keys()) {
    if (!profiles.some((profile) => profile.profileId === profileId)) {
      profiles.push({ profileId, name: profileId, unavailableReason: unlistedReason });
    }
  }
  const idle = input.live && input.pending === null;
  return profiles.map((profile) => {
    const run = latest.get(profile.profileId) ?? null;
    const runEnded = run === null || TERMINAL.has(run.status);
    const pending = input.pending;
    return {
      ...profile,
      run: run === null ? null : toRunView(run),
      evidence: latestProfileEvidence(input.status, profile.profileId),
      canLaunch: idle && profile.unavailableReason === null && runEnded,
      canStop: idle && !runEnded,
      pendingLabel:
        pending?.kind === "start" && pending.profileId === profile.profileId
          ? "Launching…"
          : pending?.kind === "stop" && pending.runId === run?.runId
            ? "Stopping…"
            : null,
    };
  });
}

export function resolveRuntimePanelView(input: {
  /** `resolveEngineChipState`: only shapes the no-profiles guidance; a custom engine has none. */
  readonly engine: "unknown" | "none" | EngineType;
  /** Whether the selected environment's connection is prepared right now. */
  readonly connectionReady: boolean;
  /** `useEnvironmentQuery` output; `data` keeps the last success after a failure. */
  readonly query: {
    readonly data: {
      readonly status: RunStatusSuccess;
      readonly requestedAt: number;
      /** Read through the connection that is current now. */
      readonly onCurrentConnection: boolean;
    } | null;
    readonly error: string | null;
  };
  readonly receipt: RuntimeReceipt | null;
  readonly pending: RuntimePendingCommand | null;
  readonly selectedProfileId: string | null;
}): RuntimePanelView {
  const { query } = input;
  // Error before data: after a failure `data` is the previous success.
  const banner: RuntimeBanner | null = !input.connectionReady
    ? {
        kind: "offline",
        text: "Not connected to this environment. Run status will be read again when it reconnects.",
      }
    : query.error !== null
      ? { kind: "error", text: `Could not read run status: ${query.error}` }
      : query.data !== null && !query.data.onCurrentConnection
        ? { kind: "reconnecting", text: "Reconnected. Reading run status from the server…" }
        : null;
  const live = banner === null;

  if (query.data === null) {
    return live
      ? { kind: "loading" }
      : {
          kind: "status",
          live,
          banner,
          asOf: null,
          rows: [],
          profilesError: null,
          guidance: null,
          selectedProfileId: null,
        };
  }

  const { status, requestedAt } = query.data;
  // A receipt is only trusted alongside a live read.
  const runs = live ? mergeReceipt(status.runs, requestedAt, input.receipt) : status.runs;
  const rows = buildRows({ status, runs, live, pending: input.pending });
  const selected =
    rows.find((row) => row.profileId === input.selectedProfileId) ??
    rows.find((row) => row.run?.runId === runs[0]?.runId) ??
    rows[0] ??
    null;
  return {
    kind: "status",
    live,
    banner,
    asOf: requestedAt,
    rows,
    profilesError: status.profilesError,
    guidance:
      rows.length > 0 || status.profilesError !== null
        ? null
        : input.engine === "none"
          ? NOT_A_GAME_GUIDANCE
          : NO_PROFILES_GUIDANCE,
    selectedProfileId: selected?.profileId ?? null,
  };
}
