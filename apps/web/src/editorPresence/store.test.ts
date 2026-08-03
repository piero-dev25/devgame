import { describe, expect, it } from "vite-plus/test";

import type { EditorPresenceEntry } from "./protocol";
import {
  deriveLiveEditorPresenceChips,
  getCurrentEditorPresenceChips,
  mergeEditorPresenceChips,
  publishCurrentEditorPresenceChips,
  useEditorPresencePinStore,
  type EditorPresenceChipItem,
  type EditorPresenceRenderChip,
} from "./store";

function entry(overrides: Partial<EditorPresenceEntry> = {}): EditorPresenceEntry {
  return {
    editor: { id: "unity", name: "Unity", version: "6000.1" },
    session: { id: "session-1" },
    workspace: { root: "/repo" },
    connected: true,
    lastSeenAt: "2026-08-01T00:00:00.000Z",
    selection: null,
    ...overrides,
  };
}

describe("deriveLiveEditorPresenceChips", () => {
  it("flattens items from every selecting publisher", () => {
    const editors: EditorPresenceEntry[] = [
      entry({
        session: { id: "session-1" },
        selection: {
          seq: 1,
          at: "2026-08-01T00:00:00.000Z",
          items: [{ id: "obj-1", kind: "gameObject", label: "Player", path: null, detail: null }],
        },
      }),
      entry({
        editor: { id: "godot", name: "Godot", version: "4.3" },
        session: { id: "session-2" },
        selection: {
          seq: 1,
          at: "2026-08-01T00:00:01.000Z",
          items: [
            { id: "node-1", kind: "node", label: "Enemy", path: "/root/Enemy", detail: null },
          ],
        },
      }),
    ];

    const chips = deriveLiveEditorPresenceChips(editors);

    expect(chips).toHaveLength(2);
    expect(chips[0]).toMatchObject({ label: "Player", editorId: "unity", sessionId: "session-1" });
    expect(chips[1]).toMatchObject({ label: "Enemy", editorId: "godot", sessionId: "session-2" });
  });

  it("contributes nothing for a publisher with no selection or an empty one", () => {
    const editors: EditorPresenceEntry[] = [
      entry({ selection: null }),
      entry({ session: { id: "session-2" }, selection: { seq: 1, at: "t", items: [] } }),
    ];

    expect(deriveLiveEditorPresenceChips(editors)).toEqual([]);
  });

  it("passes an unrecognized item kind through unchanged rather than special-casing it", () => {
    const editors: EditorPresenceEntry[] = [
      entry({
        selection: {
          seq: 1,
          at: "t",
          items: [
            {
              id: "x",
              kind: "some-future-engines-widget-type",
              label: "Widget",
              path: null,
              detail: null,
            },
          ],
        },
      }),
    ];

    const [chip] = deriveLiveEditorPresenceChips(editors);
    expect(chip?.kind).toBe("some-future-engines-widget-type");
  });

  it("derives a stable key independent of the item's position, even without an id", () => {
    const frameA = entry({
      selection: {
        seq: 1,
        at: "t1",
        items: [
          {
            id: null,
            kind: "asset",
            label: "Rock.prefab",
            path: "Assets/Rock.prefab",
            detail: null,
          },
          {
            id: null,
            kind: "asset",
            label: "Tree.prefab",
            path: "Assets/Tree.prefab",
            detail: null,
          },
        ],
      },
    });
    // Same two items, reordered — as could happen if the editor reports a
    // multi-select in a different order on the next frame.
    const frameB = entry({
      selection: {
        seq: 2,
        at: "t2",
        items: [
          {
            id: null,
            kind: "asset",
            label: "Tree.prefab",
            path: "Assets/Tree.prefab",
            detail: null,
          },
          {
            id: null,
            kind: "asset",
            label: "Rock.prefab",
            path: "Assets/Rock.prefab",
            detail: null,
          },
        ],
      },
    });

    const keysA = deriveLiveEditorPresenceChips([frameA])
      .map((c) => c.key)
      .sort();
    const keysB = deriveLiveEditorPresenceChips([frameB])
      .map((c) => c.key)
      .sort();
    expect(keysA).toEqual(keysB);
  });
});

describe("useEditorPresencePinStore", () => {
  const item: EditorPresenceChipItem = {
    id: "obj-1",
    kind: "gameObject",
    label: "Player",
    path: null,
    detail: null,
    key: "session-1:obj-1",
    editorId: "unity",
    editorName: "Unity",
    sessionId: "session-1",
  };

  it("togglePin pins an unpinned item and unpins a pinned one", () => {
    useEditorPresencePinStore.setState({ pinned: new Map() });

    useEditorPresencePinStore.getState().togglePin(item);
    expect(useEditorPresencePinStore.getState().pinned.get(item.key)).toEqual(item);

    useEditorPresencePinStore.getState().togglePin(item);
    expect(useEditorPresencePinStore.getState().pinned.has(item.key)).toBe(false);
  });

  it("unpin removes an entry by key and is a no-op for one that isn't pinned", () => {
    useEditorPresencePinStore.setState({ pinned: new Map([[item.key, item]]) });

    useEditorPresencePinStore.getState().unpin("nonexistent-key");
    expect(useEditorPresencePinStore.getState().pinned.has(item.key)).toBe(true);

    useEditorPresencePinStore.getState().unpin(item.key);
    expect(useEditorPresencePinStore.getState().pinned.has(item.key)).toBe(false);
  });
});

describe("mergeEditorPresenceChips", () => {
  const liveItem: EditorPresenceChipItem = {
    id: "obj-1",
    kind: "gameObject",
    label: "Player",
    path: null,
    detail: null,
    key: "session-1:obj-1",
    editorId: "unity",
    editorName: "Unity",
    sessionId: "session-1",
  };
  const otherLiveItem: EditorPresenceChipItem = {
    ...liveItem,
    id: "obj-2",
    label: "Enemy",
    key: "session-1:obj-2",
  };

  it("pin survives the live selection changing", () => {
    // The item is live and gets pinned...
    const pinned = new Map([[liveItem.key, liveItem]]);
    let merged = mergeEditorPresenceChips([liveItem], pinned);
    expect(merged).toEqual([{ ...liveItem, pinned: true }]);

    // ...then the live selection moves on to something else entirely. The
    // pinned item must still render, from its retained snapshot, alongside
    // the new live one.
    merged = mergeEditorPresenceChips([otherLiveItem], pinned);
    expect(merged).toEqual(
      expect.arrayContaining([
        { ...otherLiveItem, pinned: false },
        { ...liveItem, pinned: true },
      ]),
    );
    expect(merged).toHaveLength(2);
  });

  it("unpin returns the chip to live behavior", () => {
    // Pinned, and no longer live: it renders solely because it's pinned.
    const pinned = new Map([[liveItem.key, liveItem]]);
    let merged = mergeEditorPresenceChips([], pinned);
    expect(merged).toEqual([{ ...liveItem, pinned: true }]);

    // Unpinned while still not live: it must disappear.
    merged = mergeEditorPresenceChips([], new Map());
    expect(merged).toEqual([]);

    // Unpinned but back in the live selection: it renders again, now as a
    // plain live (unpinned) chip.
    merged = mergeEditorPresenceChips([liveItem], new Map());
    expect(merged).toEqual([{ ...liveItem, pinned: false }]);
  });

  it("a presence frame replaces the live set wholesale, not a merge, when nothing is pinned", () => {
    let merged = mergeEditorPresenceChips([liveItem], new Map());
    expect(merged).toEqual([{ ...liveItem, pinned: false }]);

    merged = mergeEditorPresenceChips([otherLiveItem], new Map());
    expect(merged).toEqual([{ ...otherLiveItem, pinned: false }]);
  });
});

describe("publishCurrentEditorPresenceChips / getCurrentEditorPresenceChips", () => {
  it("defaults to empty, and returns whatever was last published", () => {
    publishCurrentEditorPresenceChips([]);
    expect(getCurrentEditorPresenceChips()).toEqual([]);

    const chip: EditorPresenceRenderChip = {
      id: "obj-1",
      kind: "gameObject",
      label: "Player",
      path: null,
      detail: null,
      key: "session-1:obj-1",
      editorId: "unity",
      editorName: "Unity",
      sessionId: "session-1",
      pinned: false,
    };
    publishCurrentEditorPresenceChips([chip]);
    expect(getCurrentEditorPresenceChips()).toEqual([chip]);

    // A later publish (e.g. the component unmounting) replaces it, not
    // merges with it.
    publishCurrentEditorPresenceChips([]);
    expect(getCurrentEditorPresenceChips()).toEqual([]);
  });
});
