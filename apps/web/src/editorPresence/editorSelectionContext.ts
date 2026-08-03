// Serializes the merged (live + pinned) editor-presence chip set into the
// `<editor_selection>` block appended to the outgoing message — the
// "auto-attach" half of the owner-decided UX (EditorPresenceChips.tsx /
// EditorPresenceChipRow.tsx is the other half, the ambient display).
//
// Deliberately mirrors apps/web/src/lib/elementContext.ts's
// buildElementContextBlock / appendElementContextsToPrompt shape — same
// empty-input contract (no chips -> no block -> prompt returned unchanged,
// never an empty tag pair sitting in every message forever), same
// bullet-plus-indented-fields format — so this reads as the same pattern
// as the existing `<element_context>` / `<terminal_context>` attachments,
// not a new one.
import type { EditorPresenceRenderChip } from "./store";

/**
 * Mirrors the server's own per-publisher cap
 * (`EDITOR_PRESENCE_MAX_ITEMS` in apps/server/src/editorPresence/protocol.ts),
 * applied here to the *aggregate* multi-editor-plus-pinned set, which the
 * server never caps as a whole (it only caps each publisher's own frame).
 */
export const EDITOR_SELECTION_ATTACHMENT_MAX_ITEMS = 64;

/**
 * Pinned items are explicit, deliberate intent ("keep this riding no matter
 * what") — an ambient live item is comparatively low-commitment. If the
 * combined set ever has to be trimmed to the cap, live items are dropped
 * first so a pin is never silently lost to truncation.
 */
function prioritizeForAttachment(
  chips: ReadonlyArray<EditorPresenceRenderChip>,
): ReadonlyArray<EditorPresenceRenderChip> {
  const pinned = chips.filter((chip) => chip.pinned);
  const live = chips.filter((chip) => !chip.pinned);
  return [...pinned, ...live];
}

function buildSingleSelectionLines(item: EditorPresenceRenderChip): string[] {
  const lines: string[] = [];
  const header = item.pinned
    ? `${item.label} (${item.kind}) [pinned]`
    : `${item.label} (${item.kind})`;
  lines.push(`- ${header}:`);
  if (item.id) lines.push(`  id: ${item.id}`);
  if (item.path) lines.push(`  path: ${item.path}`);
  if (item.detail) lines.push(`  detail: ${item.detail}`);
  return lines;
}

/**
 * Serialize the current editor selection into the `<editor_selection>`
 * block. Returns `""` for an empty input — an agent that never received a
 * selection must not see an empty tag pair, matching
 * `buildElementContextBlock`'s contract exactly.
 *
 * Truncation is never silent: if the combined set exceeds
 * `EDITOR_SELECTION_ATTACHMENT_MAX_ITEMS`, a trailing line says so, rather
 * than the agent (or the user, reading the transcript later) having no way
 * to tell fewer objects rode along than were actually selected/pinned.
 */
export function buildEditorSelectionBlock(chips: ReadonlyArray<EditorPresenceRenderChip>): string {
  if (chips.length === 0) return "";
  const prioritized = prioritizeForAttachment(chips);
  const shown = prioritized.slice(0, EDITOR_SELECTION_ATTACHMENT_MAX_ITEMS);
  const truncatedCount = prioritized.length - shown.length;

  const lines: string[] = [];
  for (let index = 0; index < shown.length; index += 1) {
    lines.push(...buildSingleSelectionLines(shown[index]!));
    if (index < shown.length - 1) lines.push("");
  }
  if (truncatedCount > 0) {
    lines.push("");
    lines.push(
      `(+${truncatedCount} more selected/pinned object${truncatedCount === 1 ? "" : "s"} not shown)`,
    );
  }
  return ["<editor_selection>", ...lines, "</editor_selection>"].join("\n");
}

export function appendEditorSelectionToPrompt(
  prompt: string,
  chips: ReadonlyArray<EditorPresenceRenderChip>,
): string {
  const block = buildEditorSelectionBlock(chips);
  if (block.length === 0) return prompt;
  const trimmed = prompt.trim();
  return trimmed.length > 0 ? `${trimmed}\n\n${block}` : block;
}

// --------------------------------------------------------------------------
// Transcript-side counterpart: extract, don't render raw markup
// --------------------------------------------------------------------------
//
// Mirrors apps/web/src/lib/elementContext.ts's extractTrailingElementContexts
// exactly: same trailing-anchored match, same "not found -> return the
// prompt unchanged" contract, same header/body-style entry shape (adapted to
// this block's own fields) so a message with both an `<element_context>` and
// an `<editor_selection>` block extracts and renders in the same pattern.

export interface ExtractedEditorSelectionEntry {
  readonly label: string;
  readonly kind: string;
  readonly pinned: boolean;
  readonly id: string | null;
  readonly path: string | null;
  readonly detail: string | null;
}

export interface ExtractedEditorSelection {
  readonly promptText: string;
  readonly entries: ReadonlyArray<ExtractedEditorSelectionEntry>;
  /** From the block's own truncation notice, if present — surfaced in the
   * transcript too, for the same reason it's surfaced at send time: fewer
   * objects rode along than were actually selected/pinned, and that must
   * never be silent. */
  readonly truncatedCount: number;
}

const TRAILING_EDITOR_SELECTION_BLOCK_PATTERN =
  /\n*<editor_selection>\n([\s\S]*?)\n<\/editor_selection>\s*$/;
const EDITOR_SELECTION_HEADER_PATTERN = /^- (.+) \(([^()]+)\)( \[pinned\])?:$/;
const EDITOR_SELECTION_TRUNCATION_PATTERN =
  /^\(\+(\d+) more selected\/pinned objects? not shown\)$/;

interface MutableEditorSelectionEntry {
  label: string;
  kind: string;
  pinned: boolean;
  id: string | null;
  path: string | null;
  detail: string | null;
}

function parseEditorSelectionBlockBody(body: string): {
  entries: ExtractedEditorSelectionEntry[];
  truncatedCount: number;
} {
  const entries: ExtractedEditorSelectionEntry[] = [];
  let truncatedCount = 0;
  let current: MutableEditorSelectionEntry | null = null;
  const commit = () => {
    if (current) entries.push(current);
    current = null;
  };
  for (const line of body.split("\n")) {
    const truncationMatch = EDITOR_SELECTION_TRUNCATION_PATTERN.exec(line);
    if (truncationMatch) {
      commit();
      truncatedCount = Number(truncationMatch[1]);
      continue;
    }
    const headerMatch = EDITOR_SELECTION_HEADER_PATTERN.exec(line);
    if (headerMatch) {
      commit();
      current = {
        label: headerMatch[1]!,
        kind: headerMatch[2]!,
        pinned: headerMatch[3] !== undefined,
        id: null,
        path: null,
        detail: null,
      };
      continue;
    }
    if (!current) continue;
    const idMatch = /^ {2}id: (.+)$/.exec(line);
    if (idMatch) {
      current.id = idMatch[1]!;
      continue;
    }
    const pathMatch = /^ {2}path: (.+)$/.exec(line);
    if (pathMatch) {
      current.path = pathMatch[1]!;
      continue;
    }
    const detailMatch = /^ {2}detail: (.+)$/.exec(line);
    if (detailMatch) {
      current.detail = detailMatch[1]!;
    }
  }
  commit();
  return { entries, truncatedCount };
}

/**
 * Detects (and strips) a trailing `<editor_selection>` block for transcript
 * display, so a sent message shows its chips rather than raw `<editor_selection>`
 * markup. Returns the prompt unchanged, with no entries, whenever the block
 * isn't there, isn't well-formed, or is well-formed but contains no
 * recognizable entry — the last case matters as much as the first two: a
 * `<editor_selection>...</editor_selection>` block that happens not to be
 * ours (hand-typed by a user, or from a future format this build doesn't
 * understand) must render as plain text, not silently vanish because the
 * outer tags matched.
 */
export function extractTrailingEditorSelection(prompt: string): ExtractedEditorSelection {
  const match = TRAILING_EDITOR_SELECTION_BLOCK_PATTERN.exec(prompt);
  if (!match) {
    return { promptText: prompt, entries: [], truncatedCount: 0 };
  }
  const { entries, truncatedCount } = parseEditorSelectionBlockBody(match[1] ?? "");
  if (entries.length === 0) {
    return { promptText: prompt, entries: [], truncatedCount: 0 };
  }
  const promptText = prompt.slice(0, match.index).replace(/\n+$/, "");
  return { promptText, entries, truncatedCount };
}
