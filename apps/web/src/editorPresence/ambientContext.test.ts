import { OrchestrationMessageContext, ThreadId } from "@t3tools/contracts";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  appendAmbientContextReferences,
  buildMessageContext,
  resolveUserMessageContext,
} from "~/lib/composerContextRecords";
import { buildWorkspacePacket } from "~/projectWorkspace/contextPacket";
import { collectAmbientContextRecords, extractAmbientMessageContext } from "./ambientContext";
import { appendEditorSelectionToPrompt } from "./editorSelectionContext";
import { appendEngineHeadlineToPrompt } from "./engineHeadline";
import type { EditorPresenceEntry } from "./protocol";
import {
  deriveLiveEditorPresenceChips,
  mergeEditorPresenceChips,
  type EditorPresenceRenderChip,
} from "./store";

function entry(overrides: Partial<EditorPresenceEntry> = {}): EditorPresenceEntry {
  return {
    editor: { id: "unity", name: "Unity", version: "6000.1" },
    session: { id: "session-a" },
    workspace: { root: "/repo/game-a" },
    connected: true,
    lastSeenAt: "2026-08-01T00:00:00.000Z",
    selection: null,
    capabilities: [],
    playState: "playing",
    ...overrides,
  };
}

const editorA = entry({
  selection: {
    seq: 1,
    at: "2026-08-01T00:00:00.000Z",
    items: [
      { id: "obj-a", kind: "gameObject", label: "PlayerA", path: "Assets/A.prefab", detail: null },
    ],
  },
});
const editorB = entry({
  editor: { id: "godot", name: "Godot", version: "4.3" },
  session: { id: "session-b" },
  workspace: { root: "/repo/game-b" },
  selection: {
    seq: 1,
    at: "2026-08-01T00:00:01.000Z",
    items: [{ id: "obj-b", kind: "node", label: "SecretBossB", path: "/root/B", detail: null }],
  },
});
const editors = [editorA, editorB];
const chips: ReadonlyArray<EditorPresenceRenderChip> = mergeEditorPresenceChips(
  deriveLiveEditorPresenceChips(editors),
  new Map(),
);
const projectA = { workspaceRoot: "/repo/game-a" };
const decodeMessageContext = Schema.decodeUnknownSync(OrchestrationMessageContext);

/** The composition every send path performs: records plus their inline references. */
function send(text: string, engineChipState = "unity") {
  const ambientRecords = collectAmbientContextRecords({
    project: projectA,
    engineChipState,
    chips,
    editors,
  });
  return {
    text: appendAmbientContextReferences(text, ambientRecords),
    context: buildMessageContext({
      terminalContexts: [],
      reviewComments: [],
      previewAnnotations: [],
      ambientRecords,
    }),
  };
}

describe("ambient editor context on the structured send path", () => {
  it("reaches the provider with this project's selection and engine state only (#71)", () => {
    const message = send("Fix the double jump");
    const providerText = projectComposerContextForProvider({
      text: message.text,
      records: message.context?.records ?? [],
    });

    expect(providerText).toContain("Fix the double jump");
    expect(providerText).toContain('<context kind="editor-selection"');
    expect(providerText).toContain("PlayerA");
    expect(providerText).toContain('<context kind="engine-state"');
    expect(providerText).toContain("Unity 6000.1 · playing · 1 selected");
    expect(providerText).not.toContain("SecretBossB");
    expect(providerText).not.toContain("Godot");
  });

  it("produces a message context the wire schema accepts", () => {
    const message = send("Fix the double jump");

    expect(decodeMessageContext(message.context).records.map((record) => record.kind)).toEqual([
      "editor-selection",
      "engine-state",
    ]);
  });

  it("attaches nothing for a project detection settled as not a game", () => {
    const message = send("Fix the double jump", "none");

    expect(message.text).toBe("Fix the double jump");
    expect(message.context).toBeUndefined();
  });

  it("attaches nothing when the thread has no project yet", () => {
    expect(
      collectAmbientContextRecords({ project: null, engineChipState: "unknown", chips, editors }),
    ).toEqual([]);
  });

  it("keeps the engine state when nothing is selected", () => {
    const idle = entry({ selection: null, playState: "stopped" });
    const records = collectAmbientContextRecords({
      project: projectA,
      engineChipState: "unity",
      chips: [],
      editors: [idle],
    });

    expect(records.map((record) => record.kind)).toEqual(["engine-state"]);
  });
});

describe("extractAmbientMessageContext", () => {
  it("lifts the ambient records out of a sent message for the transcript", () => {
    const sent = send("Fix the double jump");
    const extracted = extractAmbientMessageContext({
      text: sent.text,
      context: decodeMessageContext(sent.context),
    });

    expect(extracted.message.text).toBe("Fix the double jump");
    expect(extracted.message.context).toBeUndefined();
    expect(extracted.editorSelection.entries.map((item) => item.label)).toEqual(["PlayerA"]);
    expect(extracted.engineLines).toEqual(["Unity 6000.1 · playing · 1 selected"]);
    expect(resolveUserMessageContext(extracted.message).text).toBe("Fix the double jump");
  });

  it("leaves the user's own context records for the generic rendering", () => {
    const ambientRecords = collectAmbientContextRecords({
      project: projectA,
      engineChipState: "unity",
      chips,
      editors,
    });
    const context = buildMessageContext({
      terminalContexts: [
        {
          id: "t1",
          threadId: ThreadId.make("thread-1"),
          createdAt: "2026-08-01T00:00:00.000Z",
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 1,
          lineEnd: 1,
          text: "error: boom",
        },
      ],
      reviewComments: [],
      previewAnnotations: [],
      ambientRecords,
    });

    const extracted = extractAmbientMessageContext({ text: "look", context });

    expect(extracted.message.context?.records.map((record) => record.kind)).toEqual(["terminal"]);
  });

  it("still reads messages sent with the trailing text blocks before the records transport", () => {
    const legacy = appendEngineHeadlineToPrompt(
      appendEditorSelectionToPrompt(
        "Fix the double jump",
        chips.filter((chip) => chip.workspaceRoot === "/repo/game-a"),
      ),
      editors,
      projectA,
    );

    const extracted = extractAmbientMessageContext({ text: legacy });

    expect(extracted.message.text).toBe("Fix the double jump");
    expect(extracted.editorSelection.entries.map((item) => item.label)).toEqual(["PlayerA"]);
    expect(extracted.engineLines).toEqual(["Unity 6000.1 · playing · 1 selected"]);
  });

  it("returns an ordinary message untouched", () => {
    const message = { text: "just text" };

    expect(extractAmbientMessageContext(message).message).toBe(message);
  });
});

describe("workspace packet ('Use in chat') on the structured send path", () => {
  const packet = buildWorkspacePacket({
    projectId: "project-a",
    entity: {
      id: "pitch",
      title: "Pitch",
      folder: "pitch",
      description: "Write the boss rush pitch.",
      steps: [
        {
          name: "Report",
          path: "report.md",
          relativePath: "workspace/pitch/report.md",
          exists: true,
        },
        {
          name: "Deck",
          path: "deck.html",
          relativePath: "workspace/pitch/deck.html",
          exists: false,
          issue: "missing",
        },
      ],
    },
    stepIndexes: [0, 1],
  });
  const appProjectA = { id: "project-a", workspaceRoot: "/repo/app-a" };

  function sendWithPacket(project: { id: string; workspaceRoot: string }, engineChipState: string) {
    const ambientRecords = collectAmbientContextRecords({
      project,
      engineChipState,
      workspacePacket: packet,
      chips,
      editors,
    });
    return {
      text: appendAmbientContextReferences("Draft the pitch", ambientRecords),
      context: buildMessageContext({
        terminalContexts: [],
        reviewComments: [],
        previewAnnotations: [],
        ambientRecords,
      }),
    };
  }

  it("reaches the provider for a project that is not a game, as paths without file contents", () => {
    const message = sendWithPacket(appProjectA, "none");
    const providerText = projectComposerContextForProvider({
      text: message.text,
      records: decodeMessageContext(message.context).records,
    });

    expect(providerText).toContain("Draft the pitch");
    expect(providerText).toContain('<context kind="workspace-packet"');
    expect(providerText).toContain("workspace/pitch/report.md");
    expect(providerText).toContain('"missingRefs":["workspace/pitch/deck.html"]');
    expect(providerText).toContain("Write the boss rush pitch.");
    expect(providerText).not.toContain('kind="editor-selection"');
  });

  it("goes first, ahead of the editor context, on a game project", () => {
    const message = sendWithPacket({ ...appProjectA, workspaceRoot: "/repo/game-a" }, "unity");

    expect(decodeMessageContext(message.context).records.map((record) => record.kind)).toEqual([
      "workspace-packet",
      "editor-selection",
      "engine-state",
    ]);
  });

  it("is never sent with a thread of another project", () => {
    const message = sendWithPacket({ id: "project-b", workspaceRoot: "/repo/app-b" }, "none");

    expect(message.text).toBe("Draft the pitch");
    expect(message.context).toBeUndefined();
  });

  it("comes back out of a sent message as its own chip, not as text", () => {
    const sent = sendWithPacket(appProjectA, "none");
    const extracted = extractAmbientMessageContext({
      text: sent.text,
      context: decodeMessageContext(sent.context),
    });

    expect(extracted.message.text).toBe("Draft the pitch");
    expect(extracted.message.context).toBeUndefined();
    expect(extracted.workspacePacket).toEqual(packet);
  });
});
