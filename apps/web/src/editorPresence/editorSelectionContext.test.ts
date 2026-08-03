import { describe, expect, it } from "vite-plus/test";

import {
  appendEditorSelectionToPrompt,
  buildEditorSelectionBlock,
  EDITOR_SELECTION_ATTACHMENT_MAX_ITEMS,
} from "./editorSelectionContext";
import type { EditorPresenceRenderChip } from "./store";

function chip(overrides: Partial<EditorPresenceRenderChip> = {}): EditorPresenceRenderChip {
  return {
    id: "obj-1",
    kind: "gameObject",
    label: "Player",
    path: "Assets/Player.prefab",
    detail: null,
    key: "session-1:obj-1",
    editorId: "unity",
    editorName: "Unity",
    sessionId: "session-1",
    pinned: false,
    ...overrides,
  };
}

describe("buildEditorSelectionBlock / appendEditorSelectionToPrompt", () => {
  it("attaches nothing when there is nothing selected or pinned", () => {
    expect(buildEditorSelectionBlock([])).toBe("");
    expect(appendEditorSelectionToPrompt("move that object left", [])).toBe(
      "move that object left",
    );
  });

  it("attaches the merged pinned-and-live set, with label, kind, id, and path", () => {
    const live = chip({
      key: "session-1:live",
      label: "Ground",
      kind: "gameObject",
      pinned: false,
    });
    const pinned = chip({
      key: "session-1:pinned",
      label: "PlayerRoot",
      kind: "gameObject",
      pinned: true,
    });

    const block = buildEditorSelectionBlock([live, pinned]);
    expect(block).toContain("<editor_selection>");
    expect(block).toContain("</editor_selection>");
    expect(block).toContain("Ground (gameObject)");
    expect(block).toContain("PlayerRoot (gameObject) [pinned]");
    expect(block).toContain("id: obj-1");
    expect(block).toContain("path: Assets/Player.prefab");

    const appended = appendEditorSelectionToPrompt("why do these clip", [live, pinned]);
    expect(appended.startsWith("why do these clip\n\n<editor_selection>")).toBe(true);
    expect(appended.endsWith("</editor_selection>")).toBe(true);
  });

  it("attaches a pinned item using its last-known snapshot even once it is no longer live", () => {
    const pinnedOnly = chip({ label: "PlayerRoot", pinned: true });
    const block = buildEditorSelectionBlock([pinnedOnly]);
    expect(block).toContain("PlayerRoot (gameObject) [pinned]");
  });

  it("truncation is visible, never silent, and never drops a pinned item before a live one", () => {
    const liveItems = Array.from({ length: EDITOR_SELECTION_ATTACHMENT_MAX_ITEMS }, (_, index) =>
      chip({
        key: `session-1:live-${index}`,
        id: `live-${index}`,
        label: `Live ${index}`,
        pinned: false,
      }),
    );
    const pinnedItem = chip({
      key: "session-1:pinned",
      id: "pinned-1",
      label: "Pinned",
      pinned: true,
    });

    const block = buildEditorSelectionBlock([...liveItems, pinnedItem]);
    // The pinned item survives truncation — a live one is dropped instead.
    expect(block).toContain("Pinned (gameObject) [pinned]");
    expect(block).not.toContain("Live 63");
    expect(block).toMatch(/\(\+1 more selected\/pinned object not shown\)/);
  });

  it("pluralizes the truncation notice for more than one dropped item", () => {
    const items = Array.from({ length: EDITOR_SELECTION_ATTACHMENT_MAX_ITEMS + 2 }, (_, index) =>
      chip({ key: `session-1:item-${index}`, id: `item-${index}`, label: `Item ${index}` }),
    );
    const block = buildEditorSelectionBlock(items);
    expect(block).toMatch(/\(\+2 more selected\/pinned objects not shown\)/);
  });

  it("serializes an unrecognized item kind without throwing", () => {
    const item = chip({ kind: "a-brand-new-object-kind-nobody-has-seen" });
    expect(() => buildEditorSelectionBlock([item])).not.toThrow();
    expect(buildEditorSelectionBlock([item])).toContain("a-brand-new-object-kind-nobody-has-seen");
  });

  it("omits id/path/detail lines that are null rather than printing empty fields", () => {
    const item = chip({ id: null, path: null, detail: null });
    const block = buildEditorSelectionBlock([item]);
    expect(block).not.toContain("id:");
    expect(block).not.toContain("path:");
    expect(block).not.toContain("detail:");
  });
});
