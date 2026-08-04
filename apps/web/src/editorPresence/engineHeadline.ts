// The `<engine>` headline — one line of ambient engine state on every
// outgoing message. See docs/workbench/plan-engine-context.md.
//
// This block is NOT here to inform the model. It is here to make the model
// *ask*: the engine tools are a pull mechanism, and pull's weakness is that
// the model must know a tool exists. The only per-turn instruction seam in
// this codebase is Codex-specific (CodexDeveloperInstructions.ts) — Claude
// gets a preset system prompt DevGame does not author at all — so one line of
// ambient state in the message stream is the only way to tell all five
// providers, uniformly, that an engine is present and live.
//
// Hence the hard rule this file exists to enforce: **the headline carries
// counts and levels, never contents.** The moment it grows "and the last 3
// errors" it has become the unbounded per-turn push the plan rejects, and its
// whole cost argument (~18 tokens/turn) dies with it. Payload belongs in
// tools; this carries the pointer.
//
// Deliberately its own block rather than a field on `<editor_selection>`:
//   - that block is omitted entirely when nothing is selected
//     (buildEditorSelectionBlock's empty-input contract), and play state
//     matters MOST when nothing is selected — "why isn't my game running";
//   - play state is per-editor while that block may carry items from several
//     publishers on one project, so a header line there has no well-defined
//     owner.
import type { EditorPresenceEntry } from "./protocol";
import { normalizeWorkspaceRoot } from "./resolveProjectEditor";
import type { EditorPresenceProjectRef } from "./store";

/**
 * Human-readable rendering of the publisher's own reported play state.
 * `null` (an older publisher, a fresh registration that hasn't reported yet,
 * or one whose capabilities don't include play/stop at all) contributes
 * NOTHING rather than a guessed "stopped" — mirrors the protocol's own
 * "absent means unknown, never a lie" default. A headline that says "stopped"
 * about an engine that never reports play state is exactly the confidently
 * wrong output that makes a headline worse than no headline.
 */
function playStateSegment(entry: EditorPresenceEntry): string | null {
  return entry.playState;
}

function selectionSegment(entry: EditorPresenceEntry): string {
  const count = entry.selection?.items.length ?? 0;
  return count === 1 ? "1 selected" : `${count} selected`;
}

function buildEditorLine(entry: EditorPresenceEntry): string {
  const segments = [`${entry.editor.name} ${entry.editor.version}`.trim()];
  const play = playStateSegment(entry);
  if (play) segments.push(play);
  segments.push(selectionSegment(entry));
  return segments.join(" · ");
}

/**
 * Build the headline for the editors publishing for ONE project.
 *
 * Returns `""` when no editor is connected for this project — same
 * empty-input contract as every other block in this family
 * (`buildEditorSelectionBlock`, `buildElementContextBlock`): no engine means
 * no block, never an empty tag pair riding on every message forever.
 *
 * Disconnected publishers are excluded. A headline is a statement about what
 * is live right now; an editor that has dropped off is not live, and saying
 * "playing" about a dead connection is worse than saying nothing.
 *
 * One line per connected editor. Normally that is exactly one line; two
 * publishers on one project (the case `selectEditorPresenceChipsForProject`
 * deliberately supports) get one line each rather than an arbitrary winner.
 *
 * Active scene is absent because it is absent from the protocol — see task
 * #73. When it lands it belongs in `buildEditorLine`, between the version and
 * the play state.
 */
export function buildEngineHeadlineBlock(
  editors: ReadonlyArray<EditorPresenceEntry>,
  project: EditorPresenceProjectRef | null,
): string {
  if (!project) return "";
  const targetRoot = normalizeWorkspaceRoot(project.workspaceRoot);
  const mine = editors.filter(
    (entry) => entry.connected && normalizeWorkspaceRoot(entry.workspace.root) === targetRoot,
  );
  if (mine.length === 0) return "";
  return ["<engine>", ...mine.map(buildEditorLine), "</engine>"].join("\n");
}

export function appendEngineHeadlineToPrompt(
  prompt: string,
  editors: ReadonlyArray<EditorPresenceEntry>,
  project: EditorPresenceProjectRef | null,
): string {
  const block = buildEngineHeadlineBlock(editors, project);
  if (block.length === 0) return prompt;
  const trimmed = prompt.trim();
  return trimmed.length > 0 ? `${trimmed}\n\n${block}` : block;
}

// --------------------------------------------------------------------------
// Transcript-side counterpart
// --------------------------------------------------------------------------

export interface ExtractedEngineHeadline {
  readonly promptText: string;
  /** One entry per connected editor, in the order the block listed them. */
  readonly lines: ReadonlyArray<string>;
}

const TRAILING_ENGINE_BLOCK_PATTERN = /\n*<engine>\n([\s\S]*?)\n<\/engine>\s*$/;

/**
 * Detects (and strips) a trailing `<engine>` block so a sent message shows the
 * headline as a chip rather than raw markup.
 *
 * Returns the prompt unchanged when the block isn't there, isn't well-formed,
 * or is well-formed but empty — the last case matters as much as the first
 * two, matching `extractTrailingEditorSelection`: an `<engine></engine>` pair
 * that isn't ours (hand-typed, or a future format this build doesn't
 * understand) must render as plain text, not silently vanish because the outer
 * tags matched.
 */
export function extractTrailingEngineHeadline(prompt: string): ExtractedEngineHeadline {
  const match = TRAILING_ENGINE_BLOCK_PATTERN.exec(prompt);
  if (!match) return { promptText: prompt, lines: [] };
  const lines = (match[1] ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return { promptText: prompt, lines: [] };
  return { promptText: prompt.slice(0, match.index).replace(/\n+$/, ""), lines };
}
