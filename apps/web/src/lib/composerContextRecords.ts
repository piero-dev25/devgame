import {
  COMPOSER_CONTEXT_REVIEW_DIFF_MAX_CHARS,
  COMPOSER_CONTEXT_REVIEW_TEXT_MAX_CHARS,
} from "@t3tools/contracts";
import type {
  ComposerContextId,
  ComposerContextRecord,
  EnvironmentId,
  FileContextRecord,
  ImageContextRecord,
  KnownComposerContextRecord,
  MessageId,
  OrchestrationMessageContext,
  PreviewAnnotationContextRecord,
  PreviewAnnotationPayload,
  ReviewCommentContextRecord,
  TerminalContextRecord,
  ThreadId,
} from "@t3tools/contracts";
import { upgradeLegacyContextMessage } from "@t3tools/shared/composerContextLegacy";
import { encodeComposerContextFragment } from "@t3tools/shared/composerContextClipboard";
import {
  collectComposerContextReferences,
  sanitizeComposerContextLabel,
} from "@t3tools/shared/composerContextReferences";

import {
  type ComposerContextReference,
  ensureInlineContextReferences,
  producerIdFromComposerContextId,
  toKindScopedComposerContextId,
} from "./composerContextReferences";
import type { ComposerFileAttachment, ComposerImageAttachment } from "~/composerDraftStore";
import type { AttachmentUploadState } from "./attachmentUploadState";
import { normalizeElementContextSelection } from "./elementContext";
import {
  formatTerminalContextLabel,
  normalizeTerminalContextText,
  type TerminalContextDraft,
} from "./terminalContext";
import type { ReviewCommentContext } from "~/reviewCommentContext";

/**
 * Builds the wire records behind a draft's inline references, and the reverse for reading a
 * message. Draft shapes stay what the producing panels emit; only the send boundary converts.
 */

const PREVIEW_LABEL_MAX_CHARS = 48;

/**
 * A review selection can be arbitrarily large, but the wire schema bounds `text` and `diff`.
 * Clamp at the same boundary so an oversized selection still sends, marked where it was cut,
 * rather than failing to encode at send time.
 */
const TRUNCATION_MARKER = "\n… truncated …";

function clampContextText(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - TRUNCATION_MARKER.length))}${TRUNCATION_MARKER}`;
}

type ReviewCommentPresentation = ReviewCommentContext | ReviewCommentContextRecord;

function basename(filePath: string): string {
  return filePath.split(/[\\/]/).at(-1) ?? filePath;
}

export function reviewCommentContextLabel(comment: ReviewCommentPresentation): string {
  const pullRequestNumber = pullRequestContextNumber(comment);
  if (isPullRequestSummaryContext(comment) && pullRequestNumber !== null) {
    return `#${pullRequestNumber}`;
  }
  const diffRange = /^([+-])(\d+)(?: to \1(\d+))?$/u.exec(comment.rangeLabel);
  const rangeLabel = diffRange
    ? `L${diffRange[2]}${diffRange[3] ? ` to L${diffRange[3]}` : ""}${diffRange[1] === "-" ? " (before)" : ""}`
    : comment.rangeLabel;
  return `${basename(comment.filePath)} ${rangeLabel}`;
}

export function isPullRequestSummaryContext(comment: ReviewCommentPresentation): boolean {
  if (comment.pullRequest !== undefined) return true;
  return (
    comment.sectionId.startsWith("pull-request:") &&
    comment.diff.trim().length === 0 &&
    /^PR #\d+$/u.test(comment.filePath)
  );
}

function pullRequestContextNumber(comment: ReviewCommentPresentation): number | null {
  if (comment.pullRequest !== undefined) return comment.pullRequest.number;
  const legacyNumber = /^PR #(\d+)$/u.exec(comment.filePath)?.[1];
  return legacyNumber === undefined ? null : Number(legacyNumber);
}

export type PullRequestContextDisplayState = "open" | "draft" | "merged" | "closed";

export function pullRequestContextDisplayState(
  comment: ReviewCommentPresentation,
): PullRequestContextDisplayState | null {
  const pullRequest = comment.pullRequest;
  if (pullRequest === undefined) return null;
  return pullRequest.state === "open" && pullRequest.isDraft ? "draft" : pullRequest.state;
}

export function pullRequestContextKindLabel(comment: ReviewCommentPresentation): string {
  const state = pullRequestContextDisplayState(comment);
  if (state === null) return "Pull request";
  return `${state[0]!.toUpperCase()}${state.slice(1)} pull request`;
}

export function previewAnnotationContextLabel(annotation: PreviewAnnotationPayload): string {
  const comment = annotation.comment.trim().replace(/\s+/g, " ");
  if (comment) {
    return comment.length > PREVIEW_LABEL_MAX_CHARS
      ? `${comment.slice(0, PREVIEW_LABEL_MAX_CHARS - 1)}…`
      : comment;
  }
  return annotation.pageTitle?.trim() || "Preview annotation";
}

export function terminalContextReference(context: TerminalContextDraft): ComposerContextReference {
  return {
    kind: "terminal",
    contextId: toKindScopedComposerContextId("terminal", context.id),
    label: formatTerminalContextLabel(context),
  };
}

/** Review producers mint ids in their own grammars; the context id is a folded form of them. */
export function reviewCommentContextId(commentId: string): ComposerContextId {
  return toKindScopedComposerContextId("review-comment", commentId);
}

/** Distinct from the screenshot image, which reuses the annotation id as its attachment id. */
export function previewAnnotationContextId(annotationId: string): ComposerContextId {
  return toKindScopedComposerContextId("preview-annotation", annotationId);
}

export function reviewCommentContextReference(
  comment: ReviewCommentContext,
): ComposerContextReference {
  return {
    kind: "review-comment",
    contextId: reviewCommentContextId(comment.id),
    label: reviewCommentContextLabel(comment),
  };
}

export function previewAnnotationContextReference(
  annotation: PreviewAnnotationPayload,
): ComposerContextReference {
  return {
    kind: "preview-annotation",
    contextId: previewAnnotationContextId(annotation.id),
    label: previewAnnotationContextLabel(annotation),
  };
}

/**
 * DevGame #72: one terminal selection is capped well below the provider's
 * per-turn input limit (PROVIDER_SEND_TURN_MAX_INPUT_CHARS, 120,000). The
 * schema's own 64,000-char bound is a hard encode failure, not a budget, and a
 * drag over a large scrollback crosses it in one ordinary action.
 */
export const TERMINAL_CONTEXT_MAX_CHARS_PER_SELECTION = 8_000;
/** The per-selection cap alone still multiplies by the number of selections. */
export const TERMINAL_CONTEXT_MAX_TOTAL_CHARS = 24_000;
const TERMINAL_LABEL_MAX_CHARS = 255;

function withTerminalNotice(terminalLabel: string, notice: string): string {
  const suffix = ` (${notice})`;
  return `${terminalLabel.slice(0, Math.max(1, TERMINAL_LABEL_MAX_CHARS - suffix.length))}${suffix}`;
}

/**
 * Keeps the TAIL of an oversized selection: a huge selection is almost always
 * "I dragged over the scrollback because something failed", and failures
 * surface at the bottom. `lineStart` moves to the first kept line so the
 * provider's line numbers stay true, and the omission is announced in
 * `terminalLabel`, which the provider reads as `terminal: <label>`. A single
 * line longer than the budget keeps its tail, marked with a leading ellipsis.
 */
function boundTerminalContextRecord(
  record: TerminalContextRecord,
  maxChars: number,
): TerminalContextRecord {
  if (record.text.length <= maxChars) return record;
  const lines = record.text.split("\n");
  let used = 0;
  let keptFrom = lines.length;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const cost = lines[index]!.length + 1;
    if (used + cost > maxChars) break;
    used += cost;
    keptFrom = index;
  }
  if (keptFrom === lines.length) {
    const last = lines[lines.length - 1]!;
    keptFrom = lines.length - 1;
    lines[keptFrom] = `…${last.slice(last.length - Math.max(0, maxChars - 1))}`;
  }
  const omitted = keptFrom;
  const lineStart = Math.min(record.lineEnd, record.lineStart + omitted);
  return {
    ...record,
    lineStart,
    terminalLabel: withTerminalNotice(
      record.terminalLabel,
      omitted > 0
        ? `${omitted} earlier line${omitted === 1 ? "" : "s"} omitted — selection too large to attach in full`
        : "line truncated — selection too large to attach in full",
    ),
    text: lines.slice(keptFrom).join("\n"),
  };
}

export function terminalContextRecord(context: TerminalContextDraft): TerminalContextRecord {
  return boundTerminalContextRecord(
    {
      version: 1,
      contextId: toKindScopedComposerContextId("terminal", context.id),
      kind: "terminal",
      label: sanitizeComposerContextLabel(formatTerminalContextLabel(context), "terminal"),
      terminalId: context.terminalId,
      terminalLabel: context.terminalLabel,
      lineStart: context.lineStart,
      lineEnd: context.lineEnd,
      text: normalizeTerminalContextText(context.text),
    },
    TERMINAL_CONTEXT_MAX_CHARS_PER_SELECTION,
  );
}

/**
 * Applies the per-message terminal budget in send order. The first selection
 * always attaches (already per-selection bounded). Later ones shrink to what
 * is left, and once the budget is spent they still travel, empty, with the
 * omission named in `terminalLabel`, so a chip the user placed never resolves
 * to a silently missing payload.
 */
function budgetTerminalContextRecords(
  records: ReadonlyArray<TerminalContextRecord>,
): TerminalContextRecord[] {
  let used = 0;
  return records.map((record, index) => {
    const remaining = TERMINAL_CONTEXT_MAX_TOTAL_CHARS - used;
    if (index > 0 && remaining <= 0) {
      return {
        ...record,
        lineStart: record.lineEnd,
        terminalLabel: withTerminalNotice(
          record.terminalLabel,
          "not attached — terminal attachment limit reached",
        ),
        text: "",
      };
    }
    const bounded =
      index === 0 ? record : boundTerminalContextRecord(record, Math.max(1, remaining));
    used += bounded.text.length;
    return bounded;
  });
}

export function reviewCommentContextRecord(
  comment: ReviewCommentContext,
): ReviewCommentContextRecord {
  return {
    version: 1,
    contextId: reviewCommentContextId(comment.id),
    kind: "review-comment",
    label: sanitizeComposerContextLabel(reviewCommentContextLabel(comment), "review-comment"),
    sectionId: comment.sectionId,
    sectionTitle: comment.sectionTitle,
    filePath: comment.filePath,
    startIndex: comment.startIndex,
    endIndex: comment.endIndex,
    rangeLabel: comment.rangeLabel,
    text: clampContextText(comment.text, COMPOSER_CONTEXT_REVIEW_TEXT_MAX_CHARS),
    diff: clampContextText(comment.diff, COMPOSER_CONTEXT_REVIEW_DIFF_MAX_CHARS),
    ...(comment.fenceLanguage !== undefined ? { fenceLanguage: comment.fenceLanguage } : {}),
    ...(comment.pullRequest !== undefined ? { pullRequest: comment.pullRequest } : {}),
  };
}

function previewAnnotationTargetSummary(annotation: PreviewAnnotationPayload): string {
  const parts: string[] = [];
  const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
  if (annotation.elements.length > 0)
    parts.push(plural(annotation.elements.length, "selected element"));
  if (annotation.regions.length > 0) parts.push(plural(annotation.regions.length, "marked region"));
  if (annotation.strokes.length > 0) parts.push(plural(annotation.strokes.length, "drawing"));
  return parts.join(", ");
}

export function previewAnnotationContextRecord(
  annotation: PreviewAnnotationPayload,
  options?: { screenshotContextId?: string | undefined },
): PreviewAnnotationContextRecord {
  const targets = annotation.elements.flatMap((target) => {
    const element = normalizeElementContextSelection(target.element);
    return element ? [{ id: target.id, element }] : [];
  });
  return {
    version: 1,
    contextId: previewAnnotationContextId(annotation.id),
    kind: "preview-annotation",
    label: sanitizeComposerContextLabel(
      previewAnnotationContextLabel(annotation),
      "preview-annotation",
    ),
    annotationId: annotation.id,
    pageUrl: annotation.pageUrl,
    pageTitle: annotation.pageTitle,
    comment: annotation.comment.trim(),
    targetSummary: previewAnnotationTargetSummary(annotation),
    styleChanges: annotation.styleChanges.map(
      (change) => `${change.property}: ${change.previousValue || "(unset)"} → ${change.value}`,
    ),
    ...(targets.length > 0
      ? {
          elements: targets.map((target) => target.element),
          elementIds: targets.map((target) => target.id),
        }
      : {}),
    styleChangeDetails: annotation.styleChanges.map((change) => ({ ...change })),
    ...(annotation.regions.length > 0 ? { regionCount: annotation.regions.length } : {}),
    ...(annotation.strokes.length > 0 ? { strokeCount: annotation.strokes.length } : {}),
    ...(options?.screenshotContextId !== undefined
      ? { screenshotContextId: toKindScopedComposerContextId("image", options.screenshotContextId) }
      : {}),
  };
}

export function imageContextReference(image: ComposerImageAttachment): ComposerContextReference {
  return {
    kind: "image",
    contextId: toKindScopedComposerContextId("image", image.id),
    label: image.name,
  };
}

export function fileContextReference(file: ComposerFileAttachment): ComposerContextReference {
  return {
    kind: "file",
    contextId: toKindScopedComposerContextId("file", file.id),
    label: file.name,
  };
}

/** Binds a draft attachment to the id the receiving side will know it by. */
export interface BoundComposerAttachment {
  attachment: ComposerImageAttachment | ComposerFileAttachment;
  attachmentId: string;
}

/** Clipboard payloads may only point at attachments that already exist on the server. */
export function uploadedAttachmentContextRecord(
  attachment: ComposerImageAttachment | ComposerFileAttachment,
  upload: AttachmentUploadState | undefined,
): ImageContextRecord | FileContextRecord | null {
  const attachmentId =
    attachment.type === "file" && attachment.uploadedAttachmentId !== undefined
      ? attachment.uploadedAttachmentId
      : upload?.status === "ready"
        ? upload.attachmentId
        : undefined;
  return attachmentId === undefined ? null : attachmentContextRecord({ attachment, attachmentId });
}

export function attachmentContextRecord(
  bound: BoundComposerAttachment,
): ImageContextRecord | FileContextRecord {
  const { attachment, attachmentId } = bound;
  const base = {
    version: 1 as const,
    contextId: toKindScopedComposerContextId(attachment.type, attachment.id),
    label: sanitizeComposerContextLabel(attachment.name, attachment.type),
    attachmentId,
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
  };
  return attachment.type === "image" ? { ...base, kind: "image" } : { ...base, kind: "file" };
}

/**
 * Records the app attaches to a send without a composer chip (DevGame: the
 * editor selection and the engine state). Each needs an inline reference in
 * the text, because the provider projection only emits referenced records.
 */
export function appendAmbientContextReferences(
  text: string,
  ambientRecords: ReadonlyArray<ComposerContextRecord> | undefined,
): string {
  if (!ambientRecords || ambientRecords.length === 0) return text;
  const withReferences = ensureInlineContextReferences(
    text,
    ambientRecords.map((record) => ({
      kind: record.kind,
      contextId: record.contextId,
      label: record.label,
    })),
  );
  // Upstream pads an appended reference with a trailing space for the
  // composer caret. A send has no caret, so the text ends at the last
  // reference; anything the user typed sits before the appended references.
  return withReferences === text ? text : withReferences.trimEnd();
}

export function buildMessageContext(input: {
  terminalContexts: ReadonlyArray<TerminalContextDraft>;
  reviewComments: ReadonlyArray<ReviewCommentContext>;
  previewAnnotations: ReadonlyArray<PreviewAnnotationPayload>;
  attachments?: ReadonlyArray<BoundComposerAttachment>;
  /** Pair with `appendAmbientContextReferences` on the outgoing text. */
  ambientRecords?: ReadonlyArray<ComposerContextRecord>;
}): OrchestrationMessageContext | undefined {
  // An annotation's screenshot travels as the image attachment that reuses its id.
  const screenshotAttachmentIds = new Set(
    (input.attachments ?? []).flatMap(({ attachment }) =>
      attachment.type === "image" ? [attachment.id] : [],
    ),
  );
  const records: ComposerContextRecord[] = [
    ...budgetTerminalContextRecords(input.terminalContexts.map(terminalContextRecord)),
    ...input.reviewComments.map(reviewCommentContextRecord),
    ...input.previewAnnotations.map((annotation) =>
      previewAnnotationContextRecord(annotation, {
        screenshotContextId: screenshotAttachmentIds.has(annotation.id) ? annotation.id : undefined,
      }),
    ),
    ...(input.attachments ?? []).map(attachmentContextRecord),
  ];
  // The wire schema rejects duplicate context ids, so an ambient record never
  // displaces one the user attached.
  const usedIds = new Set(records.map((record) => record.contextId));
  for (const record of input.ambientRecords ?? []) {
    if (usedIds.has(record.contextId)) continue;
    usedIds.add(record.contextId);
    records.push(record);
  }
  return records.length === 0 ? undefined : { version: 1, records };
}

/**
 * Narrows away the unknown-kind member. Its `kind` is an open string, so a plain
 * `record.kind === "terminal"` check cannot discriminate the union on its own.
 */
export function asKnownContextRecord(
  record: ComposerContextRecord | undefined,
): KnownComposerContextRecord | undefined {
  if (!record || "payload" in record) return undefined;
  return record as KnownComposerContextRecord;
}

/** Candidate keys for finding the draft record an imported wire record would reconstruct. */
export function composerContextImportLookupIds(
  record: KnownComposerContextRecord,
): ReadonlyArray<ComposerContextId> {
  const destinationId = toKindScopedComposerContextId(
    record.kind,
    producerIdFromComposerContextId(record.kind, record.contextId),
  );
  return destinationId === record.contextId
    ? [record.contextId]
    : [destinationId, record.contextId];
}

export interface ResolvedUserMessageContext {
  text: string;
  records: ReadonlyArray<ComposerContextRecord>;
  recordsById: ReadonlyMap<string, ComposerContextRecord>;
}

/**
 * The clipboard fragment behind a timeline message selection: only records for
 * chips actually inside the selection travel, so copying prose next to an
 * image never starts importing that image somewhere else. Returns null when no
 * selected chip has backing records.
 */
export function selectedMessageContextFragment(input: {
  readonly markdown: string;
  readonly records: ReadonlyArray<ComposerContextRecord>;
  readonly environmentId: EnvironmentId;
  readonly threadId?: ThreadId;
  readonly messageId: MessageId;
}): string | null {
  const selectedIds = new Set(
    collectComposerContextReferences(input.markdown).map((occurrence) => occurrence.contextId),
  );
  const records = input.records.filter((record) => selectedIds.has(record.contextId));
  if (records.length === 0) return null;
  return encodeComposerContextFragment({
    version: 1,
    source: {
      environmentId: input.environmentId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      messageId: input.messageId,
    },
    records,
  });
}

/** A message's canonical text plus records; old messages are upgraded in memory on read. */
export function resolveUserMessageContext(message: {
  text: string;
  context?: OrchestrationMessageContext | undefined;
}): ResolvedUserMessageContext {
  const resolved = message.context
    ? { text: message.text, records: message.context.records }
    : upgradeLegacyContextMessage(message.text);
  return {
    text: resolved.text,
    records: resolved.records,
    recordsById: new Map(resolved.records.map((record) => [record.contextId, record])),
  };
}

// ---------------------------------------------------------------------------
// Records back into draft shapes (paste)
// ---------------------------------------------------------------------------

export function terminalContextDraftFromRecord(
  record: TerminalContextRecord,
  threadId: ThreadId,
): TerminalContextDraft {
  return {
    id: producerIdFromComposerContextId("terminal", record.contextId),
    threadId,
    createdAt: new Date().toISOString(),
    terminalId: record.terminalId,
    terminalLabel: record.terminalLabel,
    lineStart: record.lineStart,
    lineEnd: record.lineEnd,
    text: record.text,
  };
}

export function reviewCommentFromRecord(record: ReviewCommentContextRecord): ReviewCommentContext {
  return {
    id: producerIdFromComposerContextId("review-comment", record.contextId),
    sectionId: record.sectionId,
    sectionTitle: record.sectionTitle,
    filePath: record.filePath,
    startIndex: record.startIndex,
    endIndex: record.endIndex,
    rangeLabel: record.rangeLabel,
    text: record.text,
    diff: record.diff,
    ...(record.fenceLanguage !== undefined ? { fenceLanguage: record.fenceLanguage } : {}),
    ...(record.pullRequest !== undefined ? { pullRequest: record.pullRequest } : {}),
  };
}

/** Lossy on purpose: geometry and screenshot do not travel; the agent-facing detail does. */
export function previewAnnotationFromRecord(
  record: PreviewAnnotationContextRecord,
): PreviewAnnotationPayload {
  return {
    id:
      record.annotationId ||
      producerIdFromComposerContextId("preview-annotation", record.contextId),
    pageUrl: record.pageUrl,
    pageTitle: record.pageTitle,
    comment: record.comment,
    elements: (record.elements ?? []).map((element, index) => ({
      id: record.elementIds?.[index] ?? `${record.contextId}-element-${index + 1}`,
      rect: { x: 0, y: 0, width: 0, height: 0 },
      element: { ...element, stack: [], pickedAt: new Date().toISOString() },
    })),
    // Geometry does not travel, but the counts do, so the rebuilt summary still reports
    // what the annotation marked.
    regions: Array.from({ length: record.regionCount ?? 0 }, (_unused, index) => ({
      id: `${record.contextId}-region-${index + 1}`,
      rect: { x: 0, y: 0, width: 0, height: 0 },
    })),
    strokes: Array.from({ length: record.strokeCount ?? 0 }, (_unused, index) => ({
      id: `${record.contextId}-stroke-${index + 1}`,
      color: "",
      width: 0,
      points: [],
      bounds: { x: 0, y: 0, width: 0, height: 0 },
    })),
    styleChanges:
      record.styleChangeDetails ??
      record.styleChanges.flatMap((change) => {
        const match = /^(.+?): ([\s\S]*?) → ([\s\S]*)$/.exec(change);
        if (!match) return [];
        return [
          {
            targetId: record.elementIds?.[0] ?? `${record.contextId}-element-1`,
            selector: null,
            property: match[1]!,
            previousValue: match[2] === "(unset)" ? "" : match[2]!,
            value: match[3]!,
          },
        ];
      }),
    screenshot: null,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Whether two records carry the same payload, ignoring the label (display text, never
 * identity). Context ids are a folded form of producer ids, so a collision alone does not mean
 * the records are the same excerpt; the paste path compares payloads before de-duplicating.
 */
export function isSameComposerContextPayload(
  left: ComposerContextRecord,
  right: ComposerContextRecord,
): boolean {
  if (left.kind !== right.kind) return false;
  const stableKey = (record: ComposerContextRecord) => {
    // Labels are display text and context ids are folded producer ids: neither
    // distinguishes excerpts, so an imported legacy id must still match the
    // canonical id reconstructed for the same payload instead of duplicating it.
    const { label: _label, contextId: _contextId, ...rest } = record;
    const sortDeep = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(sortDeep);
      if (value === null || typeof value !== "object") return value;
      return Object.fromEntries(
        Object.entries(value)
          .toSorted(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
          .map(([key, nested]) => [key, sortDeep(nested)]),
      );
    };
    return JSON.stringify(sortDeep(rest));
  };
  return stableKey(left) === stableKey(right);
}
