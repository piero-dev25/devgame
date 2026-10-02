import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, type ResolvedWorkspaceEntity, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { buildWorkspacePacket } from "./contextPacket";
import {
  clearStagedWorkspacePacket,
  PROJECT_MISMATCH_REASON,
  readSendableWorkspacePacket,
  restageWorkspacePacket,
  stageWorkspacePacket,
  stagedWorkspacePacketBlockedReason,
  useWorkspacePacketStore,
  workspacePacketBlockedReason,
} from "./workspacePacketStore";

const entity: ResolvedWorkspaceEntity = {
  id: "pitch",
  title: "Pitch",
  folder: "pitch",
  steps: [
    { name: "Report", path: "report.md", relativePath: "workspace/pitch/report.md", exists: true },
  ],
};
const threadA = scopeThreadRef(EnvironmentId.make("env-1"), ThreadId.make("thread-a"));
const threadB = scopeThreadRef(EnvironmentId.make("env-1"), ThreadId.make("thread-b"));
const sameIdOtherEnvironment = scopeThreadRef(
  EnvironmentId.make("env-2"),
  ThreadId.make("thread-a"),
);

function packet(projectId = "project-a", title = "Pitch") {
  return buildWorkspacePacket({ projectId, entity: { ...entity, title }, stepIndexes: [0] });
}

beforeEach(() => {
  useWorkspacePacketStore.setState({ packetsByThreadKey: {} });
});

describe("staged workspace packets", () => {
  it("belong to one thread of one environment", () => {
    const staged = packet();
    expect(stageWorkspacePacket(threadA, "project-a", staged)).toBeNull();

    expect(readSendableWorkspacePacket(threadA, "project-a")).toBe(staged);
    expect(readSendableWorkspacePacket(threadB, "project-a")).toBeNull();
    expect(readSendableWorkspacePacket(sameIdOtherEnvironment, "project-a")).toBeNull();
  });

  it("are refused for a thread of another project, with the reason", () => {
    expect(stageWorkspacePacket(threadA, "project-b", packet("project-a"))).toBe(
      PROJECT_MISMATCH_REASON,
    );
    expect(useWorkspacePacketStore.getState().packetsByThreadKey).toEqual({});
  });

  it("never send with a thread whose project no longer matches", () => {
    stageWorkspacePacket(threadA, "project-a", packet("project-a"));

    expect(readSendableWorkspacePacket(threadA, "project-b")).toBeNull();
    expect(readSendableWorkspacePacket(threadA, undefined)).toBeNull();
  });

  it("are replaced by a newer packet", () => {
    stageWorkspacePacket(threadA, "project-a", packet("project-a", "Old"));
    const newer = packet("project-a", "New");
    stageWorkspacePacket(threadA, "project-a", newer);

    expect(readSendableWorkspacePacket(threadA, "project-a")).toBe(newer);
  });

  it("clear only the given thread", () => {
    stageWorkspacePacket(threadA, "project-a", packet());
    const b = packet();
    stageWorkspacePacket(threadB, "project-a", b);

    clearStagedWorkspacePacket(threadA);

    expect(readSendableWorkspacePacket(threadA, "project-a")).toBeNull();
    expect(readSendableWorkspacePacket(threadB, "project-a")).toBe(b);
  });

  it("keep a packet staged while an older one was being sent", () => {
    const sent = packet("project-a", "Sent");
    stageWorkspacePacket(threadA, "project-a", sent);
    const newer = packet("project-a", "Staged during send");
    stageWorkspacePacket(threadA, "project-a", newer);

    clearStagedWorkspacePacket(threadA, sent);

    expect(readSendableWorkspacePacket(threadA, "project-a")).toBe(newer);
  });

  it("come back from a taken-back queued message without overwriting a newer one", () => {
    const queued = packet("project-a", "Queued");
    restageWorkspacePacket(threadA, queued);
    expect(readSendableWorkspacePacket(threadA, "project-a")).toBe(queued);

    const newer = packet("project-a", "Newer");
    stageWorkspacePacket(threadA, "project-a", newer);
    restageWorkspacePacket(threadA, queued);
    expect(readSendableWorkspacePacket(threadA, "project-a")).toBe(newer);
  });
});

describe("workspacePacketBlockedReason", () => {
  it("disables Use in chat without a thread or while its project is unknown", () => {
    expect(
      workspacePacketBlockedReason({
        threadRef: null,
        threadProjectId: "project-a",
        workspaceProjectId: "project-a",
      }),
    ).toMatch(/Open a thread/);
    expect(
      workspacePacketBlockedReason({
        threadRef: threadA,
        threadProjectId: null,
        workspaceProjectId: "project-a",
      }),
    ).toMatch(/still loading/);
    expect(
      workspacePacketBlockedReason({
        threadRef: threadA,
        threadProjectId: "project-a",
        workspaceProjectId: "project-a",
      }),
    ).toBeNull();
  });
});

describe("stagedWorkspacePacketBlockedReason (composer chip)", () => {
  it("is null when the packet rides on this thread's next single-model send", () => {
    expect(
      stagedWorkspacePacketBlockedReason({
        packet: packet("project-a"),
        threadProjectId: "project-a",
        multiModelSend: false,
      }),
    ).toBeNull();
  });

  it("says the packet is not sent with a multi-model send", () => {
    expect(
      stagedWorkspacePacketBlockedReason({
        packet: packet("project-a"),
        threadProjectId: "project-a",
        multiModelSend: true,
      }),
    ).toMatch(/^Not sent with a multi-model send/);
  });

  it("names a project mismatch first", () => {
    expect(
      stagedWorkspacePacketBlockedReason({
        packet: packet("project-a"),
        threadProjectId: "project-b",
        multiModelSend: true,
      }),
    ).toBe(`Not sent: ${PROJECT_MISMATCH_REASON.toLowerCase()}`);
  });
});
