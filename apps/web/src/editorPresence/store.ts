// Pure derivation from the raw `presence` fan-out into the flat chip row the
// composer renders, plus the (client-only) pin layer on top of it.
//
// Pinning is not part of the wire protocol — a pinned chip is a client-side
// promise to keep showing an item after it drops out of the live selection,
// so a pin stores a full item snapshot, not just a key: once an item leaves
// the live frame there is nowhere else to read its label/kind/path from.
//
// Global, not per-thread (owner ruling — presence is a property of the
// connected editor, not of a conversation): a plain module-scope Zustand
// store, the same pattern `promptStashStore.ts` / `composerDraftStore.ts`
// use for state that must survive whatever remounts happen as the user
// switches threads, rather than component state scoped to one
// `<EditorPresenceChips>` mount.
import { create } from "zustand";

import type { EditorPresenceEntry, EditorPresenceItem } from "./protocol";
import { normalizeWorkspaceRoot } from "./resolveProjectEditor";

export interface EditorPresenceChipItem extends EditorPresenceItem {
  /**
   * Stable identity for one selectable object from one publisher: the
   * editor's own `id` when it has one, otherwise a composite of the fields
   * that are always present. Deliberately never the item's position in the
   * `items[]` array — array index is not identity, and using it would make
   * a pin silently jump to whatever item next occupies that slot once the
   * live selection reorders.
   */
  readonly key: string;
  readonly editorId: string;
  readonly editorName: string;
  readonly sessionId: string;
  /**
   * The publishing editor's own `hello.workspace.root` — the only identity a
   * publisher carries that a T3 project also has (a third-party editor has no
   * notion of a project id; see resolveProjectEditor.ts).
   *
   * Carried ON the chip rather than looked up at send time because the send
   * path reads a flat, non-reactive snapshot (see
   * `publishCurrentEditorPresenceChips` below) with no route back to the
   * `EditorPresenceEntry` a chip came from. Without this field the outgoing
   * message physically cannot be scoped to the thread's own project — which
   * is how task #71 happened.
   */
  readonly workspaceRoot: string;
}

function itemKey(sessionId: string, item: EditorPresenceItem): string {
  const identity = item.id ?? `${item.kind}:${item.label}:${item.path ?? ""}`;
  return `${sessionId}:${identity}`;
}

/**
 * Flattens every connected, currently-selecting publisher's items into one
 * ordered list. Publishers with no selection or an empty selection
 * contribute nothing — `items: []` is a meaningful "nothing selected"
 * state, not an error, so it simply yields no chips for that editor.
 */
export function deriveLiveEditorPresenceChips(
  editors: ReadonlyArray<EditorPresenceEntry>,
): ReadonlyArray<EditorPresenceChipItem> {
  const chips: EditorPresenceChipItem[] = [];
  for (const entry of editors) {
    const items = entry.selection?.items ?? [];
    for (const item of items) {
      chips.push({
        ...item,
        key: itemKey(entry.session.id, item),
        editorId: entry.editor.id,
        editorName: entry.editor.name,
        sessionId: entry.session.id,
        workspaceRoot: entry.workspace.root,
      });
    }
  }
  return chips;
}

interface EditorPresencePinState {
  readonly pinned: ReadonlyMap<string, EditorPresenceChipItem>;
  /** Pins the item if it isn't pinned, unpins it if it is — the composer's
   * single click-to-pin/click-to-unpin gesture. */
  readonly togglePin: (item: EditorPresenceChipItem) => void;
  readonly unpin: (key: string) => void;
}

export const useEditorPresencePinStore = create<EditorPresencePinState>()((set) => ({
  pinned: new Map(),
  togglePin: (item) =>
    set((state) => {
      const next = new Map(state.pinned);
      if (next.has(item.key)) {
        next.delete(item.key);
      } else {
        next.set(item.key, item);
      }
      return { pinned: next };
    }),
  unpin: (key) =>
    set((state) => {
      if (!state.pinned.has(key)) return state;
      const next = new Map(state.pinned);
      next.delete(key);
      return { pinned: next };
    }),
}));

export interface EditorPresenceRenderChip extends EditorPresenceChipItem {
  readonly pinned: boolean;
}

/**
 * Merges the live selection with pinned items: every live item first (in
 * server order, tagged `pinned` accordingly), followed by any pinned item
 * that has since dropped out of the live selection — still shown, from its
 * last-known snapshot, until clicked again to unpin.
 */
export function mergeEditorPresenceChips(
  liveChips: ReadonlyArray<EditorPresenceChipItem>,
  pinned: ReadonlyMap<string, EditorPresenceChipItem>,
): ReadonlyArray<EditorPresenceRenderChip> {
  const liveKeys = new Set(liveChips.map((item) => item.key));
  const merged: EditorPresenceRenderChip[] = liveChips.map((item) => ({
    ...item,
    pinned: pinned.has(item.key),
  }));
  for (const [key, item] of pinned) {
    if (!liveKeys.has(key)) {
      merged.push({ ...item, pinned: true });
    }
  }
  return merged;
}

// --------------------------------------------------------------------------
// Project scoping for ATTACHMENT (not for display)
// --------------------------------------------------------------------------

/**
 * The subset of a project this needs — structural, matching
 * `resolveProjectEditor.ts`'s `ProjectWorkspaceRef` for the same reason: a
 * test should not have to build an `EnvironmentProject`'s many unrelated
 * required fields to exercise matching.
 */
export interface EditorPresenceProjectRef {
  readonly workspaceRoot: string;
}

/**
 * Narrows a merged chip set to the editors publishing for ONE project, by
 * normalized `workspace.root`.
 *
 * Task #71. Presence is environment-scoped BY OWNER RULING — every connected
 * editor is visible in the chip row, and that is deliberate ("presence is a
 * property of the connected editor, not of a conversation", see this file's
 * header). This function does not touch that: it is applied at SEND time
 * only, between the snapshot and the `<editor_selection>` block, so the row
 * keeps showing every editor while a thread only ever ships its OWN
 * project's objects to its model.
 *
 * Those are two different questions and the ruling answers only the first.
 * A thread rooted at project A silently attaching project B's selected
 * objects is a correctness bug with a privacy edge, not a display policy.
 *
 * Returns `[]` for a null project — a draft thread with no project resolved
 * yet has no project to scope TO, and attaching every connected editor's
 * selection is exactly the behaviour being fixed. Empty is the conservative
 * answer, and it costs nothing: the block is omitted entirely rather than
 * emitted empty (see editorSelectionContext.ts).
 */
export function selectEditorPresenceChipsForProject(
  chips: ReadonlyArray<EditorPresenceRenderChip>,
  project: EditorPresenceProjectRef | null,
): ReadonlyArray<EditorPresenceRenderChip> {
  if (!project) return [];
  const targetRoot = normalizeWorkspaceRoot(project.workspaceRoot);
  return chips.filter((chip) => normalizeWorkspaceRoot(chip.workspaceRoot) === targetRoot);
}

// --------------------------------------------------------------------------
// Current-selection snapshot: a plain, non-reactive read-model
// --------------------------------------------------------------------------
//
// EditorPresenceChips.tsx (mounted once, always live per the owner's "chips
// appear before you type" requirement) already computes the merged
// live+pinned list on every render for display. It publishes that same
// list here so ChatView.tsx's send path — a different component, one level
// up the tree, that runs at a specific instant rather than reactively — can
// read "what would attach right now" with a single synchronous call
// instead of mounting a second socket connection or subscribing to a hook
// of its own. Not a hook on purpose: a component that only needs this at
// send time must not re-render on every incoming presence frame.
let currentChipsSnapshot: ReadonlyArray<EditorPresenceRenderChip> = [];

export function publishCurrentEditorPresenceChips(
  chips: ReadonlyArray<EditorPresenceRenderChip>,
): void {
  currentChipsSnapshot = chips;
}

export function getCurrentEditorPresenceChips(): ReadonlyArray<EditorPresenceRenderChip> {
  return currentChipsSnapshot;
}

// The same read-model, one level lower: the raw entries the chips were derived
// FROM. A chip is one selected object and deliberately carries no editor-level
// state, so the `<engine>` headline — which reports the editor's play state and
// version, not any object's — cannot be built from `currentChipsSnapshot`.
//
// Published from the same component, in the same effect, so the two snapshots
// can never describe different presence frames. Kept as a SEPARATE snapshot
// rather than folding editors into the chip one because the chip list carries
// the client-side pin layer (pinned items that have dropped out of the live
// frame entirely) and this one must not: a headline reports what the editor is
// doing NOW, and a pin is explicitly a promise to outlive that.
let currentEditorsSnapshot: ReadonlyArray<EditorPresenceEntry> = [];

export function publishCurrentEditorPresenceEditors(
  editors: ReadonlyArray<EditorPresenceEntry>,
): void {
  currentEditorsSnapshot = editors;
}

export function getCurrentEditorPresenceEditors(): ReadonlyArray<EditorPresenceEntry> {
  return currentEditorsSnapshot;
}
