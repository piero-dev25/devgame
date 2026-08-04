import { describe, expect, it } from "vite-plus/test";

import {
  appendEngineHeadlineToPrompt,
  buildEngineHeadlineBlock,
  extractTrailingEngineHeadline,
} from "./engineHeadline";
import {
  appendEditorSelectionToPrompt,
  extractTrailingEditorSelection,
} from "./editorSelectionContext";
import type { EditorPresenceEntry } from "./protocol";

function entry(overrides: Partial<EditorPresenceEntry> = {}): EditorPresenceEntry {
  return {
    editor: { id: "unity", name: "Unity", version: "6000.1" },
    session: { id: "session-1" },
    workspace: { root: "/repo/game-a" },
    connected: true,
    lastSeenAt: "2026-08-01T00:00:00.000Z",
    selection: null,
    capabilities: [],
    playState: null,
    ...overrides,
  };
}

const projectA = { workspaceRoot: "/repo/game-a" };

describe("buildEngineHeadlineBlock", () => {
  it("reports the engine, its play state, and how much is selected", () => {
    const block = buildEngineHeadlineBlock(
      [
        entry({
          playState: "playing",
          selection: {
            seq: 1,
            at: "t",
            items: [
              { id: "a", kind: "gameObject", label: "One", path: null, detail: null },
              { id: "b", kind: "gameObject", label: "Two", path: null, detail: null },
            ],
          },
        }),
      ],
      projectA,
    );

    expect(block).toBe("<engine>\nUnity 6000.1 · playing · 2 selected\n</engine>");
  });

  it("singularizes a single selected object", () => {
    const block = buildEngineHeadlineBlock(
      [
        entry({
          playState: "stopped",
          selection: {
            seq: 1,
            at: "t",
            items: [{ id: "a", kind: "gameObject", label: "One", path: null, detail: null }],
          },
        }),
      ],
      projectA,
    );

    expect(block).toContain("1 selected");
  });

  it("omits play state entirely when the publisher has never reported one", () => {
    // Never "stopped" by default — a headline that asserts a play state for an
    // engine that does not report one is confidently wrong, which is worse
    // than absent.
    const block = buildEngineHeadlineBlock([entry({ playState: null })], projectA);

    expect(block).toBe("<engine>\nUnity 6000.1 · 0 selected\n</engine>");
    expect(block).not.toContain("stopped");
  });

  it("still reports the engine when nothing is selected", () => {
    // The whole reason this is not a field on `<editor_selection>`: that block
    // disappears with an empty selection, and "why isn't my game running" is
    // asked with nothing selected.
    const block = buildEngineHeadlineBlock([entry({ playState: "paused" })], projectA);

    expect(block).toContain("paused");
    expect(block).toContain("0 selected");
  });

  it("attaches nothing when no editor is connected for this project", () => {
    expect(buildEngineHeadlineBlock([], projectA)).toBe("");
    expect(appendEngineHeadlineToPrompt("fix the jump", [], projectA)).toBe("fix the jump");
  });

  it("ignores editors belonging to another project", () => {
    const other = entry({ workspace: { root: "/repo/game-b" }, playState: "playing" });

    expect(buildEngineHeadlineBlock([other], projectA)).toBe("");
  });

  it("ignores a disconnected publisher rather than reporting its last-known state", () => {
    const dead = entry({ connected: false, playState: "playing" });

    expect(buildEngineHeadlineBlock([dead], projectA)).toBe("");
  });

  it("normalizes a trailing slash on either side", () => {
    expect(
      buildEngineHeadlineBlock([entry({ workspace: { root: "/repo/game-a/" } })], projectA),
    ).toContain("Unity");
    expect(buildEngineHeadlineBlock([entry()], { workspaceRoot: "/repo/game-a/" })).toContain(
      "Unity",
    );
  });

  it("gives each connected editor on one project its own line", () => {
    const unity = entry({ playState: "playing" });
    const godot = entry({
      editor: { id: "godot", name: "Godot", version: "4.3" },
      session: { id: "session-2" },
      playState: "stopped",
    });

    const block = buildEngineHeadlineBlock([unity, godot], projectA);

    expect(block).toBe(
      "<engine>\nUnity 6000.1 · playing · 0 selected\nGodot 4.3 · stopped · 0 selected\n</engine>",
    );
  });

  it("attaches nothing when the thread has no project resolved yet", () => {
    expect(buildEngineHeadlineBlock([entry()], null)).toBe("");
  });

  it("stays one short line — this block carries counts, never contents", () => {
    // Guards the plan's cost argument (~18 tokens/turn). If this ever fails
    // because someone added a payload here, the payload belongs in a tool.
    const block = buildEngineHeadlineBlock(
      [
        entry({
          playState: "playing",
          selection: {
            seq: 1,
            at: "t",
            items: Array.from({ length: 64 }, (_, index) => ({
              id: `obj-${index}`,
              kind: "gameObject",
              label: `A very long object label number ${index}`,
              path: `Assets/Some/Deep/Path/Object${index}.prefab`,
              detail: "Transform, Renderer, Collider",
            })),
          },
        }),
      ],
      projectA,
    );

    expect(block.length).toBeLessThan(120);
    expect(block).toContain("64 selected");
    expect(block).not.toContain("prefab");
  });
});

describe("appendEngineHeadlineToPrompt / extractTrailingEngineHeadline", () => {
  it("appends the block after the user's text and strips it back off", () => {
    const editors = [entry({ playState: "playing" })];
    const appended = appendEngineHeadlineToPrompt("why is this slow", editors, projectA);

    expect(appended.startsWith("why is this slow\n\n<engine>")).toBe(true);

    const extracted = extractTrailingEngineHeadline(appended);
    expect(extracted.promptText).toBe("why is this slow");
    expect(extracted.lines).toEqual(["Unity 6000.1 · playing · 0 selected"]);
  });

  it("returns an empty prompt's block alone rather than a leading blank line", () => {
    const appended = appendEngineHeadlineToPrompt("", [entry()], projectA);
    expect(appended.startsWith("<engine>")).toBe(true);
  });

  it("leaves a message with no block untouched", () => {
    const extracted = extractTrailingEngineHeadline("just a normal message");
    expect(extracted).toEqual({ promptText: "just a normal message", lines: [] });
  });

  it("renders a hand-typed empty pair as plain text instead of silently eating it", () => {
    const typed = "look at this\n\n<engine>\n\n</engine>";
    const extracted = extractTrailingEngineHeadline(typed);
    expect(extracted.promptText).toBe(typed);
    expect(extracted.lines).toEqual([]);
  });

  it("only strips a TRAILING block, not one quoted mid-message", () => {
    const quoted = "<engine>\nUnity 6000.1 · 0 selected\n</engine>\nand then I said";
    expect(extractTrailingEngineHeadline(quoted).promptText).toBe(quoted);
  });
});

describe("the headline composes with the selection block without breaking it", () => {
  // The real risk of adding a NEW outermost trailing block: the existing
  // extraction chain is trailing-anchored, so an unstripped `<engine>` block
  // would stop `extractTrailingEditorSelection` matching at all and the user
  // would see raw `<editor_selection>` markup in their own message. This
  // drives ChatView's append order against MessagesTimeline's strip order.
  it("both blocks come off, in order, leaving the user's text", () => {
    const chips = [
      {
        id: "obj-a",
        kind: "gameObject",
        label: "PlayerA",
        path: "Assets/PlayerA.prefab",
        detail: null,
        key: "session-a:obj-a",
        editorId: "unity",
        editorName: "Unity",
        sessionId: "session-a",
        workspaceRoot: "/repo/game-a",
        pinned: false,
      },
    ];
    const editors = [
      entry({
        playState: "playing",
        selection: {
          seq: 1,
          at: "t",
          items: [{ id: "obj-a", kind: "gameObject", label: "PlayerA", path: null, detail: null }],
        },
      }),
    ];

    // Send path order: selection block first, headline appended outermost.
    const outgoing = appendEngineHeadlineToPrompt(
      appendEditorSelectionToPrompt("fix the double jump", chips),
      editors,
      projectA,
    );

    expect(outgoing).toContain("<editor_selection>");
    expect(outgoing).toContain("<engine>");

    // Timeline order: headline off first, then the selection block.
    const headline = extractTrailingEngineHeadline(outgoing);
    expect(headline.lines).toEqual(["Unity 6000.1 · playing · 1 selected"]);

    const selection = extractTrailingEditorSelection(headline.promptText);
    expect(selection.entries.map((e) => e.label)).toEqual(["PlayerA"]);

    expect(selection.promptText).toBe("fix the double jump");
  });
});
