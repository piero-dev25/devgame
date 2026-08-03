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
