/**
 * "Use in chat": a bounded, visible packet describing one workspace card,
 * attached to the next message of ONE thread as a fork-kind composer context
 * record (the same transport as the editor selection, see
 * editorPresence/editorSelectionContext.ts and ambientContext.ts).
 *
 * The packet carries the card's brief and project-relative reference paths
 * only. File bodies are never inlined: the agent opens the paths with its own
 * tools when it needs them, and nothing here reads or imports skills.
 */
import type {
  ComposerContextId,
  ComposerContextRecord,
  ResolvedWorkspaceEntity,
  UnknownContextRecord,
} from "@t3tools/contracts";
import { sanitizeComposerContextLabel } from "@t3tools/shared/composerContextReferences";

export const WORKSPACE_PACKET_CONTEXT_KIND = "workspace-packet";
/** One packet per message, so a fixed producer id is enough. */
const WORKSPACE_PACKET_CONTEXT_ID = "workspace-packet_current";
/** Whole-payload JSON budget; far below the 64,000-char schema bound. */
export const WORKSPACE_PACKET_MAX_CHARS = 16_000;
const BRIEF_MAX_CHARS = 2_000;
const FIELD_MAX_CHARS = 500;
const MAX_REFS = 64;
const TRUNCATION_MARKER = "… [truncated]";
const PACKET_NOTE =
  "Workspace card attached by the user. Paths are project-relative; read them with your tools when needed. File contents are not included.";

export interface WorkspacePacketRunSummary {
  readonly runId: string;
  readonly profileId: string;
  readonly state: string;
  readonly exitCode: number | null;
}

export interface WorkspacePacket {
  readonly version: 1;
  readonly note: string;
  readonly projectId: string;
  readonly entityId: string;
  readonly title: string;
  readonly brief: string | null;
  /** Project-relative paths of the chosen steps whose files exist. */
  readonly referencePaths: ReadonlyArray<string>;
  /** Chosen steps whose file is missing, unreadable or outside the workspace. */
  readonly missingRefs: ReadonlyArray<string>;
  readonly acceptedVersion: string | null;
  readonly runSummary: WorkspacePacketRunSummary | null;
  /** Reference paths (existing or missing) dropped to stay inside the budget. */
  readonly truncatedCount: number;
}

function clamp(value: string, max: number): string {
  return value.length <= max
    ? value
    : `${value.slice(0, max - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

/**
 * Builds the packet for one card. `stepIndexes` are the steps the user chose:
 * every step for the card action, one for a step action. A chosen step whose
 * file cannot be used is reported in `missingRefs`, never dropped silently.
 */
export function buildWorkspacePacket(input: {
  readonly projectId: string;
  readonly entity: ResolvedWorkspaceEntity;
  readonly stepIndexes: ReadonlyArray<number>;
  readonly acceptedVersion?: string | null;
  readonly runSummary?: WorkspacePacketRunSummary | null;
}): WorkspacePacket {
  const { entity } = input;
  const referencePaths: string[] = [];
  const missingRefs: string[] = [];
  for (const index of new Set(input.stepIndexes)) {
    const step = entity.steps[index];
    if (!step) continue;
    if (step.relativePath !== null && step.exists) {
      referencePaths.push(clamp(step.relativePath, FIELD_MAX_CHARS));
    } else {
      missingRefs.push(clamp(step.relativePath ?? step.path, FIELD_MAX_CHARS));
    }
  }
  const total = referencePaths.length + missingRefs.length;
  // Missing refs are kept ahead of existing ones: they are the warning.
  const keptMissing = missingRefs.slice(0, MAX_REFS);
  const keptRefs = referencePaths.slice(0, Math.max(0, MAX_REFS - keptMissing.length));
  const description = entity.description?.trim() ?? "";
  const packet = {
    version: 1 as const,
    note: PACKET_NOTE,
    projectId: input.projectId,
    entityId: clamp(entity.id, FIELD_MAX_CHARS),
    title: clamp(entity.title.trim() || entity.id.trim() || "Untitled", FIELD_MAX_CHARS),
    brief: description.length > 0 ? clamp(description, BRIEF_MAX_CHARS) : null,
    referencePaths: keptRefs,
    missingRefs: keptMissing,
    acceptedVersion:
      input.acceptedVersion == null ? null : clamp(input.acceptedVersion, FIELD_MAX_CHARS),
    runSummary:
      input.runSummary == null
        ? null
        : {
            runId: clamp(input.runSummary.runId, FIELD_MAX_CHARS),
            profileId: clamp(input.runSummary.profileId, FIELD_MAX_CHARS),
            state: clamp(input.runSummary.state, FIELD_MAX_CHARS),
            exitCode: input.runSummary.exitCode,
          },
    truncatedCount: 0,
  };
  while (
    JSON.stringify(packet).length > WORKSPACE_PACKET_MAX_CHARS &&
    (keptRefs.length > 0 || keptMissing.length > 0)
  ) {
    if (keptRefs.length > 0) keptRefs.pop();
    else keptMissing.pop();
  }
  return { ...packet, truncatedCount: total - keptRefs.length - keptMissing.length };
}

export function buildWorkspacePacketRecord(packet: WorkspacePacket): UnknownContextRecord {
  return {
    version: 1,
    kind: WORKSPACE_PACKET_CONTEXT_KIND,
    contextId: WORKSPACE_PACKET_CONTEXT_ID as ComposerContextId,
    label: sanitizeComposerContextLabel(
      `Workspace: ${packet.title}`,
      WORKSPACE_PACKET_CONTEXT_KIND,
    ),
    payload: packet,
  };
}

const isString = (value: unknown): value is string => typeof value === "string";
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isString);
const isNullableString = (value: unknown): value is string | null =>
  value === null || isString(value);

function readRunSummary(value: unknown): WorkspacePacketRunSummary | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") return undefined;
  const run = value as Record<string, unknown>;
  if (!isString(run.runId) || !isString(run.profileId) || !isString(run.state)) return undefined;
  const exitCode = run.exitCode ?? null;
  if (exitCode !== null && typeof exitCode !== "number") return undefined;
  return { runId: run.runId, profileId: run.profileId, state: run.state, exitCode };
}

/** A sent packet, or `null` for another kind or a payload this build does not recognize. */
export function readWorkspacePacketRecord(record: ComposerContextRecord): WorkspacePacket | null {
  if (record.kind !== WORKSPACE_PACKET_CONTEXT_KIND || !("payload" in record)) return null;
  const payload = record.payload;
  if (typeof payload !== "object" || payload === null) return null;
  const value = payload as Record<string, unknown>;
  const acceptedVersion = value.acceptedVersion ?? null;
  const runSummary = readRunSummary(value.runSummary);
  if (
    value.version !== 1 ||
    !isString(value.projectId) ||
    !isString(value.entityId) ||
    !isString(value.title) ||
    !isNullableString(value.brief ?? null) ||
    !isStringArray(value.referencePaths) ||
    !isStringArray(value.missingRefs) ||
    !isNullableString(acceptedVersion) ||
    runSummary === undefined
  ) {
    return null;
  }
  const truncatedCount = value.truncatedCount;
  return {
    version: 1,
    note: isString(value.note) ? value.note : PACKET_NOTE,
    projectId: value.projectId,
    entityId: value.entityId,
    title: value.title,
    brief: (value.brief as string | null | undefined) ?? null,
    referencePaths: value.referencePaths,
    missingRefs: value.missingRefs,
    acceptedVersion,
    runSummary,
    truncatedCount:
      typeof truncatedCount === "number" && Number.isInteger(truncatedCount) && truncatedCount > 0
        ? truncatedCount
        : 0,
  };
}

/** What a chip shows for a packet, in the composer or the transcript. */
export function describeWorkspacePacket(packet: WorkspacePacket): {
  readonly label: string;
  readonly warning: string | null;
  readonly details: string;
} {
  const warnings: string[] = [];
  if (packet.missingRefs.length > 0) {
    warnings.push(
      `${packet.missingRefs.length} missing reference${packet.missingRefs.length === 1 ? "" : "s"}`,
    );
  }
  if (packet.truncatedCount > 0) warnings.push(`${packet.truncatedCount} more not included`);
  const lines = [packet.title];
  if (packet.brief) lines.push(packet.brief);
  for (const path of packet.referencePaths) lines.push(`• ${path}`);
  for (const path of packet.missingRefs) lines.push(`• ${path} (missing)`);
  if (packet.truncatedCount > 0) lines.push(`+${packet.truncatedCount} more not included`);
  if (packet.acceptedVersion) lines.push(`Accepted version: ${packet.acceptedVersion}`);
  if (packet.runSummary) {
    lines.push(`Run ${packet.runSummary.profileId}: ${packet.runSummary.state}`);
  }
  return {
    label: packet.title,
    warning: warnings.length > 0 ? warnings.join(", ") : null,
    details: lines.join("\n"),
  };
}
