import { type ThreadId } from "@t3tools/contracts";

import { extractTrailingElementContexts, type ParsedElementContextEntry } from "./elementContext";

export interface TerminalContextSelection {
  terminalId: string;
  terminalLabel: string;
  lineStart: number;
  lineEnd: number;
  text: string;
}

export interface TerminalContextDraft extends TerminalContextSelection {
  id: string;
  threadId: ThreadId;
  createdAt: string;
}

export interface ExtractedTerminalContexts {
  promptText: string;
  contextCount: number;
  previewTitle: string | null;
  contexts: ParsedTerminalContextEntry[];
}

export interface DisplayedUserMessageState {
  visibleText: string;
  copyText: string;
  contextCount: number;
  previewTitle: string | null;
  contexts: ParsedTerminalContextEntry[];
  /**
   * Element-context entries extracted from the trailing `<element_context>`
   * block (if any). Stripped from `visibleText` so the raw block doesn't
   * leak into the user's bubble.
   */
  elementContexts: ParsedElementContextEntry[];
}

export interface ParsedTerminalContextEntry {
  header: string;
  body: string;
}

export const INLINE_TERMINAL_CONTEXT_PLACEHOLDER = "\uFFFC";

const TRAILING_TERMINAL_CONTEXT_BLOCK_PATTERN =
  /\n*<terminal_context>\n([\s\S]*?)\n<\/terminal_context>\s*$/;

export function normalizeTerminalContextText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
}

export function hasTerminalContextText(context: { text: string }): boolean {
  return normalizeTerminalContextText(context.text).length > 0;
}

export function isTerminalContextExpired(context: { text: string }): boolean {
  return !hasTerminalContextText(context);
}

export function filterTerminalContextsWithText<T extends { text: string }>(
  contexts: ReadonlyArray<T>,
): T[] {
  return contexts.filter((context) => hasTerminalContextText(context));
}

function previewTerminalContextText(text: string): string {
  const normalized = normalizeTerminalContextText(text);
  if (normalized.length === 0) {
    return "";
  }
  const lines = normalized.split("\n");
  const visibleLines = lines.slice(0, 3);
  if (lines.length > 3) {
    visibleLines.push("...");
  }
  const preview = visibleLines.join("\n");
  return preview.length > 180 ? `${preview.slice(0, 177)}...` : preview;
}

export function normalizeTerminalContextSelection(
  selection: TerminalContextSelection,
): TerminalContextSelection | null {
  const text = normalizeTerminalContextText(selection.text);
  const terminalId = selection.terminalId.trim();
  const terminalLabel = selection.terminalLabel.trim();
  if (text.length === 0 || terminalId.length === 0 || terminalLabel.length === 0) {
    return null;
  }
  const lineStart = Math.max(1, Math.floor(selection.lineStart));
  const lineEnd = Math.max(lineStart, Math.floor(selection.lineEnd));
  return {
    terminalId,
    terminalLabel,
    lineStart,
    lineEnd,
    text,
  };
}

export function formatTerminalContextRange(selection: {
  lineStart: number;
  lineEnd: number;
}): string {
  return selection.lineStart === selection.lineEnd
    ? `line ${selection.lineStart}`
    : `lines ${selection.lineStart}-${selection.lineEnd}`;
}

export function formatTerminalContextLabel(selection: {
  terminalLabel: string;
  lineStart: number;
  lineEnd: number;
}): string {
  return `${selection.terminalLabel} ${formatTerminalContextRange(selection)}`;
}

export function formatInlineTerminalContextLabel(selection: {
  terminalLabel: string;
  lineStart: number;
  lineEnd: number;
}): string {
  const terminalLabel = selection.terminalLabel.trim().toLowerCase().replace(/\s+/g, "-");
  const range =
    selection.lineStart === selection.lineEnd
      ? `${selection.lineStart}`
      : `${selection.lineStart}-${selection.lineEnd}`;
  return `@${terminalLabel}:${range}`;
}

export function buildTerminalContextPreviewTitle(
  contexts: ReadonlyArray<TerminalContextSelection>,
): string | null {
  if (contexts.length === 0) {
    return null;
  }
  const previewParts: string[] = [];
  for (const context of contexts) {
    const normalized = normalizeTerminalContextSelection(context);
    if (!normalized) continue;
    const preview = previewTerminalContextText(normalized.text);
    previewParts.push(
      preview.length > 0
        ? `${formatTerminalContextLabel(normalized)}\n${preview}`
        : formatTerminalContextLabel(normalized),
    );
  }
  const previews = previewParts.join("\n\n");
  return previews.length > 0 ? previews : null;
}

/**
 * Bounds ONE terminal selection. Task #72.
 *
 * This appender used to have no cap of any kind, while `buildTerminalContextBodyLines`
 * ADDED ~6-8 characters of `"  N | "` prefix to every line — it inflated rather
 * than bounded. A user dragging over a large scrollback region crossed
 * `PROVIDER_SEND_TURN_MAX_INPUT_CHARS` (120,000) on its own, in one ordinary
 * action, and the turn failed at the provider boundary.
 *
 * Deliberately capped HERE rather than by a composed-total budget across the
 * six appenders. A shared budget that trimmed "the largest contributor first"
 * would silently trim this one every single time, which is the same
 * silent-degradation shape as the 10 MB diff truncation in #66.
 */
export const TERMINAL_CONTEXT_MAX_CHARS_PER_SELECTION = 8_000;

/**
 * Bounds the whole block, however many selections it holds — a per-selection
 * cap alone still multiplies by the number of selections attached.
 */
export const TERMINAL_CONTEXT_MAX_TOTAL_CHARS = 24_000;

/**
 * Truncation is never silent: the omitted-line count rides INSIDE the block,
 * indented so `parseTerminalContextEntries` keeps it with its entry (an
 * unindented line there is dropped on the floor, so the transcript would show
 * a shortened body with no indication it had been shortened).
 *
 * The TAIL is kept, not the head. Truncation only fires on a very large
 * selection, and a very large selection is almost always "I dragged over the
 * whole scrollback because something failed" rather than a curated excerpt —
 * failures surface at the bottom, which is the same reason `tail` is the
 * convention for bounded log viewing. The retained line numbers say exactly
 * where the kept region starts, so nothing is misrepresented either way.
 */
function buildTerminalContextBodyLines(
  selection: TerminalContextSelection,
  maxChars: number,
): string[] {
  const numbered = normalizeTerminalContextText(selection.text)
    .split("\n")
    .map((line, index) => `  ${selection.lineStart + index} | ${line}`);

  let budget = 0;
  let keptFrom = numbered.length;
  for (let index = numbered.length - 1; index >= 0; index -= 1) {
    const cost = numbered[index]!.length + 1;
    if (budget + cost > maxChars) break;
    budget += cost;
    keptFrom = index;
  }

  if (keptFrom === 0) return numbered;

  // A single line can exceed the whole budget on its own (minified output, a
  // base64 blob). Keeping zero lines and only a notice would be useless, so
  // the last line is hard-truncated instead — still announced.
  if (keptFrom === numbered.length) {
    const last = numbered[numbered.length - 1]!;
    const omitted = numbered.length - 1;
    const kept = `${last.slice(0, Math.max(0, maxChars - 1))}…`;
    return [...(omitted > 0 ? [omittedLinesNotice(omitted)] : []), kept];
  }

  return [omittedLinesNotice(keptFrom), ...numbered.slice(keptFrom)];
}

function omittedLinesNotice(count: number): string {
  return `  (${count} earlier line${count === 1 ? "" : "s"} omitted — selection too large to attach in full)`;
}

export function buildTerminalContextBlock(
  contexts: ReadonlyArray<TerminalContextSelection>,
): string {
  const normalizedContexts: TerminalContextSelection[] = [];
  for (const context of contexts) {
    const normalized = normalizeTerminalContextSelection(context);
    if (normalized !== null) {
      normalizedContexts.push(normalized);
    }
  }
  if (normalizedContexts.length === 0) {
    return "";
  }
  const lines: string[] = [];
  let used = 0;
  let attached = 0;
  for (let index = 0; index < normalizedContexts.length; index += 1) {
    const context = normalizedContexts[index]!;
    const header = `- ${formatTerminalContextLabel(context)}:`;
    const body = buildTerminalContextBodyLines(
      context,
      Math.min(
        TERMINAL_CONTEXT_MAX_CHARS_PER_SELECTION,
        Math.max(0, TERMINAL_CONTEXT_MAX_TOTAL_CHARS - used),
      ),
    );
    const cost = [header, ...body].reduce((sum, line) => sum + line.length + 1, 0);
    // Always attach the first selection, however large — it is already bounded
    // by the per-selection cap, and a block that attached nothing at all would
    // be a silent drop of the thing the user explicitly picked.
    if (attached > 0 && used + cost > TERMINAL_CONTEXT_MAX_TOTAL_CHARS) break;
    if (attached > 0) lines.push("");
    lines.push(header, ...body);
    used += cost;
    attached += 1;
  }

  // Same loud-truncation contract as the per-selection notice, and indented for
  // the same reason: `parseTerminalContextEntries` silently discards an
  // unindented line, so an unindented notice would vanish from the transcript.
  const dropped = normalizedContexts.length - attached;
  if (dropped > 0) {
    lines.push(
      `  (+${dropped} more terminal selection${dropped === 1 ? "" : "s"} not shown — attachment limit reached)`,
    );
  }
  return ["<terminal_context>", ...lines, "</terminal_context>"].join("\n");
}

export function materializeInlineTerminalContextPrompt(
  prompt: string,
  contexts: ReadonlyArray<{
    terminalLabel: string;
    lineStart: number;
    lineEnd: number;
  }>,
): string {
  let nextContextIndex = 0;
  let result = "";

  for (const char of prompt) {
    if (char !== INLINE_TERMINAL_CONTEXT_PLACEHOLDER) {
      result += char;
      continue;
    }
    const context = contexts[nextContextIndex] ?? null;
    nextContextIndex += 1;
    if (!context) {
      continue;
    }
    result += formatInlineTerminalContextLabel(context);
  }

  return result;
}

export function appendTerminalContextsToPrompt(
  prompt: string,
  contexts: ReadonlyArray<TerminalContextSelection>,
): string {
  const trimmedPrompt = materializeInlineTerminalContextPrompt(prompt, contexts).trim();
  const contextBlock = buildTerminalContextBlock(contexts);
  if (contextBlock.length === 0) {
    return trimmedPrompt;
  }
  return trimmedPrompt.length > 0 ? `${trimmedPrompt}\n\n${contextBlock}` : contextBlock;
}

export function extractTrailingTerminalContexts(prompt: string): ExtractedTerminalContexts {
  const match = TRAILING_TERMINAL_CONTEXT_BLOCK_PATTERN.exec(prompt);
  if (!match) {
    return {
      promptText: prompt,
      contextCount: 0,
      previewTitle: null,
      contexts: [],
    };
  }
  const promptText = prompt.slice(0, match.index).replace(/\n+$/, "");
  const parsedContexts = parseTerminalContextEntries(match[1] ?? "");
  return {
    promptText,
    contextCount: parsedContexts.length,
    previewTitle:
      parsedContexts.length > 0
        ? parsedContexts
            .map(({ header, body }) => (body.length > 0 ? `${header}\n${body}` : header))
            .join("\n\n")
        : null,
    contexts: parsedContexts,
  };
}

export function deriveDisplayedUserMessageState(prompt: string): DisplayedUserMessageState {
  // Order matters: send-time appends `<terminal_context>` first, then
  // `<element_context>` last. Strip element first so the (now-trailing)
  // terminal block can be matched by `extractTrailingTerminalContexts`.
  const extractedElement = extractTrailingElementContexts(prompt);
  const extractedTerminal = extractTrailingTerminalContexts(extractedElement.promptText);
  return {
    visibleText: extractedTerminal.promptText,
    copyText: prompt,
    contextCount: extractedTerminal.contextCount,
    previewTitle: extractedTerminal.previewTitle,
    contexts: extractedTerminal.contexts,
    elementContexts: extractedElement.contexts,
  };
}

function parseTerminalContextEntries(block: string): ParsedTerminalContextEntry[] {
  const entries: ParsedTerminalContextEntry[] = [];
  let current: { header: string; bodyLines: string[] } | null = null;

  const commitCurrent = () => {
    if (!current) {
      return;
    }
    entries.push({
      header: current.header,
      body: current.bodyLines.join("\n").trimEnd(),
    });
    current = null;
  };

  for (const rawLine of block.split("\n")) {
    const headerMatch = /^- (.+):$/.exec(rawLine);
    if (headerMatch) {
      commitCurrent();
      current = {
        header: headerMatch[1]!,
        bodyLines: [],
      };
      continue;
    }
    if (!current) {
      continue;
    }
    if (rawLine.startsWith("  ")) {
      current.bodyLines.push(rawLine.slice(2));
      continue;
    }
    if (rawLine.length === 0) {
      current.bodyLines.push("");
    }
  }

  commitCurrent();
  return entries;
}

export function countInlineTerminalContextPlaceholders(prompt: string): number {
  let count = 0;
  for (const char of prompt) {
    if (char === INLINE_TERMINAL_CONTEXT_PLACEHOLDER) {
      count += 1;
    }
  }
  return count;
}

export function ensureInlineTerminalContextPlaceholders(
  prompt: string,
  terminalContextCount: number,
): string {
  const missingCount = terminalContextCount - countInlineTerminalContextPlaceholders(prompt);
  if (missingCount <= 0) {
    return prompt;
  }
  return `${INLINE_TERMINAL_CONTEXT_PLACEHOLDER.repeat(missingCount)}${prompt}`;
}

function isInlineTerminalContextBoundaryWhitespace(char: string | undefined): boolean {
  return char === undefined || char === " " || char === "\n" || char === "\t" || char === "\r";
}

export function insertInlineTerminalContextPlaceholder(
  prompt: string,
  cursorInput: number,
): { prompt: string; cursor: number; contextIndex: number } {
  const cursor = Math.max(0, Math.min(prompt.length, Math.floor(cursorInput)));
  const needsLeadingSpace = !isInlineTerminalContextBoundaryWhitespace(prompt[cursor - 1]);
  const replacement = `${needsLeadingSpace ? " " : ""}${INLINE_TERMINAL_CONTEXT_PLACEHOLDER} `;
  const rangeEnd = prompt[cursor] === " " ? cursor + 1 : cursor;
  return {
    prompt: `${prompt.slice(0, cursor)}${replacement}${prompt.slice(rangeEnd)}`,
    cursor: cursor + replacement.length,
    contextIndex: countInlineTerminalContextPlaceholders(prompt.slice(0, cursor)),
  };
}

export function stripInlineTerminalContextPlaceholders(prompt: string): string {
  return prompt.replaceAll(INLINE_TERMINAL_CONTEXT_PLACEHOLDER, "");
}

export function removeInlineTerminalContextPlaceholder(
  prompt: string,
  contextIndex: number,
): { prompt: string; cursor: number } {
  if (contextIndex < 0) {
    return { prompt, cursor: prompt.length };
  }

  let placeholderIndex = 0;
  for (let index = 0; index < prompt.length; index += 1) {
    if (prompt[index] !== INLINE_TERMINAL_CONTEXT_PLACEHOLDER) {
      continue;
    }
    if (placeholderIndex === contextIndex) {
      return {
        prompt: prompt.slice(0, index) + prompt.slice(index + 1),
        cursor: index,
      };
    }
    placeholderIndex += 1;
  }

  return { prompt, cursor: prompt.length };
}
