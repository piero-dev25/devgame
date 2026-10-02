import { describe, expect, it } from "vite-plus/test";

import type { ElementContextRecord } from "@t3tools/contracts";
import { upgradeLegacyContextMessage } from "@t3tools/shared/composerContextLegacy";
import { serializeLegacyContextMessage } from "@t3tools/shared/composerContextLegacySend";

import {
  appendEditorSelectionToPrompt,
  buildEditorSelectionBlock,
  buildEditorSelectionContextRecord,
  extractTrailingEditorSelection,
  readEditorSelectionContextRecord,
  EDITOR_SELECTION_ATTACHMENT_MAX_ITEMS,
} from "./editorSelectionContext";
import type { EditorPresenceEntry } from "./protocol";
import {
  deriveLiveEditorPresenceChips,
  mergeEditorPresenceChips,
  selectEditorPresenceChipsForProject,
  type EditorPresenceRenderChip,
} from "./store";

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
    workspaceRoot: "/repo",
    pinned: false,
    ...overrides,
  };
}

describe("the outgoing message is scoped to the thread's own project (#71)", () => {
  function entry(overrides: Partial<EditorPresenceEntry> = {}): EditorPresenceEntry {
    return {
      editor: { id: "unity", name: "Unity", version: "6000.1" },
      session: { id: "session-1" },
      workspace: { root: "/repo" },
      connected: true,
      lastSeenAt: "2026-08-01T00:00:00.000Z",
      selection: null,
      capabilities: [],
      playState: null,
      ...overrides,
    };
  }

  /**
   * Drives the exact composition ChatView.tsx's send path performs: the
   * merged snapshot EditorPresenceChips.tsx publishes for EVERY connected
   * editor in the environment, scoped to this thread's project, then
   * serialized.
   *
   * Asserts the EFFECT, not the call: what does and does not appear in the
   * text that goes to the model. Deleting the scoping step in ChatView must
   * make this fail.
   */
  function outgoingMessageFor(
    editors: ReadonlyArray<EditorPresenceEntry>,
    workspaceRoot: string,
  ): string {
    const snapshot = mergeEditorPresenceChips(deriveLiveEditorPresenceChips(editors), new Map());
    return appendEditorSelectionToPrompt(
      "Fix the double jump",
      selectEditorPresenceChipsForProject(snapshot, { workspaceRoot }),
    );
  }

  const projectA = entry({
    session: { id: "session-a" },
    workspace: { root: "/repo/game-a" },
    selection: {
      seq: 1,
      at: "2026-08-01T00:00:00.000Z",
      items: [
        {
          id: "obj-a",
          kind: "gameObject",
          label: "PlayerA",
          path: "Assets/PlayerA.prefab",
          detail: null,
        },
      ],
    },
  });
  const projectB = entry({
    editor: { id: "godot", name: "Godot", version: "4.3" },
    session: { id: "session-b" },
    workspace: { root: "/repo/game-b" },
    selection: {
      seq: 1,
      at: "2026-08-01T00:00:01.000Z",
      items: [
        {
          id: "obj-b",
          kind: "node",
          label: "SecretBossB",
          path: "/root/SecretBossB",
          detail: null,
        },
      ],
    },
  });

  it("carries this project's selection and not another project's", () => {
    const outgoing = outgoingMessageFor([projectA, projectB], "/repo/game-a");

    expect(outgoing).toContain("PlayerA");
    expect(outgoing).not.toContain("SecretBossB");
  });

  it("omits the block entirely when only another project's editor is selecting", () => {
    // Not an empty `<editor_selection></editor_selection>` pair — the family's
    // empty-input contract has to survive the scoping step.
    expect(outgoingMessageFor([projectB], "/repo/game-a")).toBe("Fix the double jump");
  });
});

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

  it("strips off before the legacy element/terminal upgrade, in the order old sends appended them", () => {
    // Messages sent before the records transport: the legacy element block
    // first, then the editor selection appended outermost.
    const element: ElementContextRecord = {
      version: 1,
      contextId: "element_1" as ElementContextRecord["contextId"],
      kind: "element",
      label: "SubmitButton",
      pageUrl: "http://localhost:3000/",
      pageTitle: "Preview",
      tagName: "button",
      selector: "#submit",
      htmlPreview: "<button>Submit</button>",
      componentName: "SubmitButton",
      source: null,
      styles: "",
    };
    const withElement = serializeLegacyContextMessage({
      text: "move that object left",
      records: [element],
    });
    const sent = appendEditorSelectionToPrompt(withElement, [
      chip({ label: "PlayerRoot", pinned: true }),
    ]);

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

    // MessagesTimeline then hands the rest to the upstream legacy upgrade.
    const upgraded = upgradeLegacyContextMessage(editorSelection.promptText);
    expect(upgraded.records.map((record) => record.kind)).toContain("element");
    expect(upgraded.text).toContain("move that object left");
    expect(upgraded.text).not.toContain("editor_selection");
  });
});

describe("buildEditorSelectionContextRecord / readEditorSelectionContextRecord", () => {
  it("builds no record when nothing is selected or pinned", () => {
    expect(buildEditorSelectionContextRecord([])).toBeNull();
  });

  it("round-trips the entries, pinned-first, through the record payload", () => {
    const record = buildEditorSelectionContextRecord([
      chip({ id: "live", key: "s:live", label: "Live" }),
      chip({ id: "pin", key: "s:pin", label: "Pinned", pinned: true }),
    ]);

    expect(record?.kind).toBe("editor-selection");
    expect(record?.label).toBe("Pinned +1");
    expect(readEditorSelectionContextRecord(record!)?.entries.map((entry) => entry.label)).toEqual([
      "Pinned",
      "Live",
    ]);
  });

  it("carries truncation in the payload instead of dropping objects silently", () => {
    const many = Array.from({ length: EDITOR_SELECTION_ATTACHMENT_MAX_ITEMS + 3 }, (_, index) =>
      chip({ id: `obj-${index}`, key: `s:obj-${index}`, label: `Obj${index}` }),
    );

    const selection = readEditorSelectionContextRecord(buildEditorSelectionContextRecord(many)!);

    expect(selection?.entries).toHaveLength(EDITOR_SELECTION_ATTACHMENT_MAX_ITEMS);
    expect(selection?.truncatedCount).toBe(3);
  });

  it("keeps an oversized payload inside the wire bound and counts what it dropped", () => {
    const huge = Array.from({ length: 30 }, (_, index) =>
      chip({ id: `obj-${index}`, key: `s:obj-${index}`, detail: "d".repeat(100_000) }),
    );

    const record = buildEditorSelectionContextRecord(huge)!;

    expect(JSON.stringify(record.payload).length).toBeLessThanOrEqual(64_000);
    expect(readEditorSelectionContextRecord(record)?.truncatedCount).toBeGreaterThan(0);
  });

  it("ignores another kind or a payload this build does not recognize", () => {
    const record = buildEditorSelectionContextRecord([chip()])!;

    expect(readEditorSelectionContextRecord({ ...record, kind: "something-else" })).toBeNull();
    expect(
      readEditorSelectionContextRecord({ ...record, payload: { entries: "nope" } }),
    ).toBeNull();
  });
});
