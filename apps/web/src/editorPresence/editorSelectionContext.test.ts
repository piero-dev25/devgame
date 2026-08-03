import { describe, expect, it } from "vite-plus/test";

import { appendElementContextsToPrompt, type ElementContextSelection } from "../lib/elementContext";
import { deriveDisplayedUserMessageState } from "../lib/terminalContext";
import {
  appendEditorSelectionToPrompt,
  buildEditorSelectionBlock,
  extractTrailingEditorSelection,
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

describe("extractTrailingEditorSelection", () => {
  it("a message with no block renders unchanged", () => {
    const extracted = extractTrailingEditorSelection("just a normal message");
    expect(extracted).toEqual({
      promptText: "just a normal message",
      entries: [],
      truncatedCount: 0,
    });
  });

  it("round-trips label, kind, pinned, id, and path through build then extract", () => {
    const live = chip({
      key: "session-1:live",
      id: "obj-live",
      label: "Ground",
      kind: "gameObject",
      path: "Assets/Ground.prefab",
      detail: null,
      pinned: false,
    });
    const pinned = chip({
      key: "session-1:pinned",
      id: "obj-pinned",
      label: "PlayerRoot",
      kind: "gameObject",
      path: null,
      detail: "root of the rig",
      pinned: true,
    });
    const sent = appendEditorSelectionToPrompt("why do these clip", [live, pinned]);

    const extracted = extractTrailingEditorSelection(sent);
    expect(extracted.promptText).toBe("why do these clip");
    // Pinned entries serialize first (see prioritizeForAttachment) — the
    // extraction faithfully preserves whatever order was actually sent.
    expect(extracted.entries).toEqual([
      {
        label: "PlayerRoot",
        kind: "gameObject",
        pinned: true,
        id: "obj-pinned",
        path: null,
        detail: "root of the rig",
      },
      {
        label: "Ground",
        kind: "gameObject",
        pinned: false,
        id: "obj-live",
        path: "Assets/Ground.prefab",
        detail: null,
      },
    ]);
  });

  it("round-trips the truncation notice", () => {
    const items = Array.from({ length: EDITOR_SELECTION_ATTACHMENT_MAX_ITEMS + 3 }, (_, index) =>
      chip({ key: `session-1:item-${index}`, id: `item-${index}`, label: `Item ${index}` }),
    );
    const sent = appendEditorSelectionToPrompt("prompt", items);
    const extracted = extractTrailingEditorSelection(sent);
    expect(extracted.entries).toHaveLength(EDITOR_SELECTION_ATTACHMENT_MAX_ITEMS);
    expect(extracted.truncatedCount).toBe(3);
  });

  it("round-trips an unrecognized item kind", () => {
    const item = chip({ kind: "a-brand-new-object-kind-nobody-has-seen" });
    const sent = appendEditorSelectionToPrompt("prompt", [item]);
    const extracted = extractTrailingEditorSelection(sent);
    expect(extracted.entries[0]?.kind).toBe("a-brand-new-object-kind-nobody-has-seen");
  });

  it("a malformed block (unclosed tag) renders as plain text rather than swallowing the message", () => {
    const malformed = "move that object\n\n<editor_selection>\n- Ground (gameObject):\n  id: obj-1";
    const extracted = extractTrailingEditorSelection(malformed);
    expect(extracted).toEqual({ promptText: malformed, entries: [], truncatedCount: 0 });
  });

  it("a well-formed but unrecognized block (not ours) renders as plain text rather than swallowing the message", () => {
    const notOurs =
      "some message\n\n<editor_selection>\nthis is not our format at all\n</editor_selection>";
    const extracted = extractTrailingEditorSelection(notOurs);
    expect(extracted).toEqual({ promptText: notOurs, entries: [], truncatedCount: 0 });
  });

  it("a block not at the trailing position renders as plain text", () => {
    const midMessage =
      "<editor_selection>\n- Ground (gameObject):\n</editor_selection>\n\nand then I typed more after it";
    const extracted = extractTrailingEditorSelection(midMessage);
    expect(extracted).toEqual({ promptText: midMessage, entries: [], truncatedCount: 0 });
  });

  it("composes with the existing terminal/element extraction chain in the same order the send path appends them", () => {
    const elementFixture: ElementContextSelection = {
      pageUrl: "http://localhost:3000/",
      pageTitle: "Preview",
      tagName: "button",
      selector: "#submit",
      htmlPreview: "<button>Submit</button>",
      componentName: "SubmitButton",
      source: null,
      styles: "",
    };
    const editorChip = chip({ label: "PlayerRoot", pinned: true });

    // Mirrors ChatView.tsx's send path: element context first, editor
    // selection appended outermost (after everything else).
    const withElement = appendElementContextsToPrompt("move that object left", [elementFixture]);
    const sent = appendEditorSelectionToPrompt(withElement, [editorChip]);

    // Mirrors MessagesTimeline.tsx's read path: editor selection stripped
    // first (it's the one unconditional trailing block), then the existing
    // terminal/element chain runs on what's left.
    const editorSelection = extractTrailingEditorSelection(sent);
    expect(editorSelection.entries).toEqual([
      {
        label: "PlayerRoot",
        kind: "gameObject",
        pinned: true,
        id: "obj-1",
        path: "Assets/Player.prefab",
        detail: null,
      },
    ]);

    const displayed = deriveDisplayedUserMessageState(editorSelection.promptText);
    expect(displayed.elementContexts).toHaveLength(1);
    expect(displayed.elementContexts[0]?.header).toBe("<SubmitButton>");
    expect(displayed.visibleText).toBe("move that object left");
  });
});
