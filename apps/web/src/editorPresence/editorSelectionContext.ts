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
