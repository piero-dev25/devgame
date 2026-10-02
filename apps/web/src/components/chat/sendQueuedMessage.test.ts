import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  type ComposerContextId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { buildWorkspacePacket, type WorkspacePacket } from "../../projectWorkspace/contextPacket";
import { stageWorkspacePacket } from "../../projectWorkspace/workspacePacketStore";
import { useQueuedMessageStore } from "../../queuedMessageStore";
import { sendQueuedMessage } from "./sendQueuedMessage";

function workspacePacket(title: string): WorkspacePacket {
  return buildWorkspacePacket({
    projectId: "project-a",
    entity: { id: title, title, folder: "cards", steps: [] },
    stepIndexes: [],
  });
}

// DevGame (orchestrator decision 1): a queued send carries the same ambient
// editor context as a direct ChatView send.
const io = vi.hoisted(() => ({
  run: vi.fn(),
  toast: vi.fn(),
  collect: vi.fn(),
  project: null as unknown,
}));
const config = {
  environment: { capabilities: { attachmentUploads: true, inlineMessageContext: true } },
};
vi.mock("@t3tools/client-runtime/state/runtime", async (load) => ({
  ...(await load<typeof import("@t3tools/client-runtime/state/runtime")>()),
  runAtomCommand: (...args: unknown[]) => io.run(...args),
}));
vi.mock("../../rpc/atomRegistry", () => ({
  appAtomRegistry: { get: () => new Map([["env-a", config]]) },
}));
vi.mock("../../state/server", () => ({ environmentServerConfigsAtom: {} }));
vi.mock("../../state/threads", () => ({
  threadEnvironment: { startTurn: "start" },
}));
vi.mock("../../state/entities", () => ({
  readThreadShell: () => ({
    projectId: "project-a",
    modelSelection,
    branch: null,
    runtimeMode: "full-access",
    interactionMode: "default",
  }),
  readThread: () => null,
  readProject: () => io.project,
}));
vi.mock("../../editorPresence/ambientContext", () => ({
  collectAmbientContextRecords: (...args: unknown[]) => io.collect(...args),
}));
vi.mock("../ui/toast", () => ({
  toastManager: { add: (...args: unknown[]) => io.toast(...args) },
}));

const threadRef = scopeThreadRef(EnvironmentId.make("env-a"), ThreadId.make("thread-a"));
const threadKey = scopedThreadKey(threadRef);
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };
const engineState = {
  version: 1 as const,
  kind: "engine-state",
  contextId: "engine-state_current" as ComposerContextId,
  label: "Godot 4.3 · playing · 0 selected",
  payload: { version: 1, editors: ["Godot 4.3 · playing · 0 selected"] },
};

function enqueue(workspacePacket: WorkspacePacket | null = null) {
  return useQueuedMessageStore.getState().enqueue(threadKey, {
    prompt: "run it",
    images: [],
    files: [],
    terminalContexts: [],
    previewAnnotations: [],
    reviewComments: [],
    workspacePacket,
    sendSettings: {
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      promptEffort: null,
    },
    queuedAfterToolActivityId: null,
    createdAt: "2026-10-03T00:00:00Z",
  });
}

beforeEach(() => {
  useQueuedMessageStore.setState({ queuesByThreadKey: {}, lastDispatchByThreadKey: {} });
  io.run.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  io.toast.mockReset();
  io.collect.mockReset().mockReturnValue([engineState]);
  io.project = {
    id: ProjectId.make("project-a"),
    workspaceRoot: "/work/game",
    engineType: "godot",
  };
});

describe("sendQueuedMessage — ambient editor context", () => {
  it("snapshots the thread project's editor context into the turn's records and text", async () => {
    const message = enqueue();

    await sendQueuedMessage(threadRef, message.id);

    expect(io.toast).not.toHaveBeenCalled();
    expect(io.collect).toHaveBeenCalledWith({
      project: io.project,
      engineChipState: "godot",
      workspacePacket: null,
    });
    expect(io.run.mock.calls.map((call) => call[1])).toEqual(["start"]);
    expect(io.run.mock.calls[0]?.[2]).toMatchObject({
      input: {
        message: {
          text: "run it [Godot 4.3 · playing · 0 selected](t3-context://v1/engine-state/engine-state_current)",
          context: { version: 1, records: [engineState] },
        },
      },
    });
  });

  it("sends the prompt unchanged when the project has no engine", async () => {
    io.project = { ...(io.project as object), engineType: null };
    io.collect.mockReturnValue([]);
    const message = enqueue();

    await sendQueuedMessage(threadRef, message.id);

    expect(io.collect).toHaveBeenCalledWith({
      project: io.project,
      engineChipState: "none",
      workspacePacket: null,
    });
    const input = io.run.mock.calls[0]?.[2] as { input: { message: Record<string, unknown> } };
    expect(input.input.message.text).toBe("run it");
    expect(input.input.message).not.toHaveProperty("context");
  });

  it("sends the workspace packet staged when it was queued, not one staged later", async () => {
    const queuedPacket = workspacePacket("Queued card");
    const message = enqueue(queuedPacket);
    stageWorkspacePacket(threadRef, "project-a", workspacePacket("Staged later"));

    await sendQueuedMessage(threadRef, message.id);

    expect(io.collect).toHaveBeenCalledWith({
      project: io.project,
      engineChipState: "godot",
      workspacePacket: queuedPacket,
    });
  });
});
