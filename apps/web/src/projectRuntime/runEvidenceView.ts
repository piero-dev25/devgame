/**
 * Run evidence as plain display data, for the Run panel (latest record of a
 * profile) and the Workspace panel (latest records linked to a card). Every
 * judgement comes from the server: freshness, outcome and each check's status
 * are shown as recorded, never re-derived here, and unknown provenance is
 * shown as unknown.
 */
import type { RunEvidenceRecord, RunEvidenceView, RunStatusSuccess } from "@t3tools/contracts";

export interface EvidenceCheckRow {
  readonly key: string;
  readonly pattern: string;
  readonly ok: boolean;
  /** "Matched", "Wrong value", "No matching line", "No log to check". */
  readonly label: string;
  /** The log line the check looked at, when there was one. */
  readonly line: string | null;
}

export interface EvidenceArtifactRow {
  readonly key: string;
  readonly name: string;
  readonly kind: RunEvidenceRecord["artifacts"][number]["kind"];
  /** Where it is: project-relative, or the absolute path in the run's directory. */
  readonly path: string;
  /** Project-relative path the Files panel can open, or null (outside the project, or missing). */
  readonly openPath: string | null;
  readonly ok: boolean;
  /** "12.3 KB · sha256 1a2b3c4d5e6f", or the problem. */
  readonly detail: string;
}

export interface RunEvidenceSummaryView {
  readonly key: string;
  readonly runId: string;
  readonly profileId: string;
  readonly endedAt: string;
  readonly passed: boolean;
  readonly freshness: RunEvidenceView["freshness"];
  readonly freshnessLabel: string;
  readonly freshnessReasons: ReadonlyArray<string>;
  readonly failures: ReadonlyArray<string>;
  /** "Source a1b2c3d4e5f6 with uncommitted changes" or "Source revision unknown". */
  readonly sourceLabel: string;
  /** "Build Runtime/out/game · sha256 1a2b3c4d5e6f" or "... · not fingerprinted". */
  readonly buildLabel: string;
  /** The linked workspace step's path, when the profile names one. */
  readonly stepPath: string | null;
  readonly checks: ReadonlyArray<EvidenceCheckRow>;
  readonly artifacts: ReadonlyArray<EvidenceArtifactRow>;
}

const FRESHNESS_LABELS: Readonly<Record<RunEvidenceView["freshness"], string>> = {
  fresh: "Current",
  stale: "Stale",
  unknown: "Freshness unknown",
};

const CHECK_LABELS: Readonly<Record<RunEvidenceRecord["checks"][number]["status"], string>> = {
  matched: "Matched",
  mismatch: "Wrong value",
  missing: "No matching line",
  "log-unavailable": "No log to check",
};

const shortHash = (hash: string) => hash.slice(0, 12);

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function sourceLabel(source: RunEvidenceRecord["source"]): string {
  if (source.revision === "unknown") return "Source revision unknown";
  const changes =
    source.dirty === "unknown"
      ? ", working tree state unknown"
      : source.dirty
        ? " with uncommitted changes"
        : "";
  return `Source ${shortHash(source.revision)}${changes}`;
}

function buildLabel(build: RunEvidenceRecord["build"]): string {
  return build.sha256 === "unknown"
    ? `Build ${build.path} · not fingerprinted`
    : `Build ${build.path} · sha256 ${shortHash(build.sha256)}`;
}

export function toRunEvidenceSummary(view: RunEvidenceView): RunEvidenceSummaryView {
  const { record } = view;
  return {
    key: record.runId,
    runId: record.runId,
    profileId: record.profileId,
    endedAt: record.endedAt,
    passed: record.outcome === "passed",
    freshness: view.freshness,
    freshnessLabel: FRESHNESS_LABELS[view.freshness],
    freshnessReasons: view.freshnessReasons,
    failures: record.failures,
    sourceLabel: sourceLabel(record.source),
    buildLabel: buildLabel(record.build),
    stepPath: record.workspaceCard?.stepPath ?? null,
    checks: record.checks.map((check, index) => ({
      key: `${index}:${check.pattern}`,
      pattern: check.pattern,
      ok: check.status === "matched",
      label: CHECK_LABELS[check.status],
      line: check.line,
    })),
    artifacts: record.artifacts.map((artifact, index) => {
      const inProject = artifact.location === "project";
      return {
        key: `${index}:${artifact.name}`,
        name: artifact.name,
        kind: artifact.kind,
        path: inProject ? artifact.path : artifact.absolutePath,
        openPath: inProject && artifact.exists && artifact.problem === null ? artifact.path : null,
        ok: artifact.problem === null,
        detail:
          artifact.problem ??
          `${formatBytes(artifact.bytes ?? 0)}${artifact.sha256 === null ? "" : ` · sha256 ${shortHash(artifact.sha256)}`}`,
      };
    }),
  };
}

/** The newest evidence of one profile, or null (none yet, or a server without evidence). */
export function latestProfileEvidence(
  status: RunStatusSuccess,
  profileId: string,
): RunEvidenceSummaryView | null {
  const view = status.evidence?.find((entry) => entry.record.profileId === profileId);
  return view === undefined ? null : toRunEvidenceSummary(view);
}

/**
 * Evidence linked to a workspace card, newest first. A failed or pending read
 * shows none: the previous read's evidence may no longer be true.
 */
export function cardEvidence(
  query: {
    readonly data: { readonly status: RunStatusSuccess } | null;
    readonly error: string | null;
  },
  entityId: string,
): ReadonlyArray<RunEvidenceSummaryView> {
  if (query.error !== null || query.data === null) return [];
  return (query.data.status.evidence ?? [])
    .filter((entry) => entry.record.workspaceCard?.entityId === entityId)
    .toSorted((a, b) => b.record.endedAt.localeCompare(a.record.endedAt))
    .map(toRunEvidenceSummary);
}
