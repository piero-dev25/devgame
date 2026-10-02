/**
 * Workspace packets staged for a thread's next message, keyed by
 * `scopedThreadKey` (environment + thread). The Workspace panel stages; the
 * composer shows the staged packet with a remove button; the send paths take
 * it and clear it once the message is on its way. In memory only: a staged
 * packet is a live intent, like a queued message.
 *
 * Project guard: a packet carries the project it was built for. It is only
 * staged into, and only sent with, a thread of that same project.
 */
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

import type { WorkspacePacket } from "./contextPacket";

interface WorkspacePacketStoreState {
  readonly packetsByThreadKey: Readonly<Record<string, WorkspacePacket>>;
}

export const useWorkspacePacketStore = create<WorkspacePacketStoreState>(() => ({
  packetsByThreadKey: {},
}));

export const PROJECT_MISMATCH_REASON =
  "This workspace belongs to a different project than the current thread.";

/**
 * Whether "Use in chat" can attach a packet built for `workspaceProjectId` to
 * the thread. Returns the reason when it cannot, for a disabled action.
 */
export function workspacePacketBlockedReason(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly threadProjectId: string | null;
  readonly workspaceProjectId: string | null;
}): string | null {
  if (input.threadRef === null) return "Open a thread to use a card in chat.";
  if (input.threadProjectId === null || input.workspaceProjectId === null) {
    return "This thread's project is still loading.";
  }
  if (input.threadProjectId !== input.workspaceProjectId) return PROJECT_MISMATCH_REASON;
  return null;
}

const MULTI_MODEL_REASON =
  "Not sent with a multi-model send. Send to one model to include this card.";

/**
 * Why the staged packet will not ride on the composer's next send, or null
 * when it will: another project's packet, or a multi-model send (which starts
 * new threads and carries no packet). Mirrors the send path's own checks.
 */
export function stagedWorkspacePacketBlockedReason(input: {
  readonly packet: WorkspacePacket;
  readonly threadProjectId: string | null;
  readonly multiModelSend: boolean;
}): string | null {
  if (input.packet.projectId !== input.threadProjectId) {
    return `Not sent: ${PROJECT_MISMATCH_REASON.toLowerCase()}`;
  }
  if (input.multiModelSend) return MULTI_MODEL_REASON;
  return null;
}

/** Stages (or replaces) the thread's packet. Refuses a packet from another project. */
export function stageWorkspacePacket(
  threadRef: ScopedThreadRef,
  threadProjectId: string | null,
  packet: WorkspacePacket,
): string | null {
  const reason = workspacePacketBlockedReason({
    threadRef,
    threadProjectId,
    workspaceProjectId: packet.projectId,
  });
  if (reason !== null) return reason;
  const key = scopedThreadKey(threadRef);
  useWorkspacePacketStore.setState((state) => ({
    packetsByThreadKey: { ...state.packetsByThreadKey, [key]: packet },
  }));
  return null;
}

/**
 * Puts back a packet that left with a queued message the user took back. A
 * packet staged since then wins, so a restore never overwrites newer intent.
 */
export function restageWorkspacePacket(threadRef: ScopedThreadRef, packet: WorkspacePacket): void {
  const key = scopedThreadKey(threadRef);
  useWorkspacePacketStore.setState((state) =>
    state.packetsByThreadKey[key] !== undefined
      ? state
      : { packetsByThreadKey: { ...state.packetsByThreadKey, [key]: packet } },
  );
}

function readStagedWorkspacePacket(threadRef: ScopedThreadRef): WorkspacePacket | null {
  return useWorkspacePacketStore.getState().packetsByThreadKey[scopedThreadKey(threadRef)] ?? null;
}

/** The staged packet when it may ride on a message of `projectId`'s thread, else null. */
export function readSendableWorkspacePacket(
  threadRef: ScopedThreadRef,
  projectId: string | null | undefined,
): WorkspacePacket | null {
  const packet = readStagedWorkspacePacket(threadRef);
  return packet !== null && packet.projectId === projectId ? packet : null;
}

/**
 * Removes the thread's packet. With `packet`, only when that exact packet is
 * still staged, so a send never clears one staged while it was in flight.
 */
export function clearStagedWorkspacePacket(
  threadRef: ScopedThreadRef,
  packet?: WorkspacePacket,
): void {
  const key = scopedThreadKey(threadRef);
  useWorkspacePacketStore.setState((state) => {
    const current = state.packetsByThreadKey[key];
    if (current === undefined || (packet !== undefined && current !== packet)) return state;
    const { [key]: _removed, ...rest } = state.packetsByThreadKey;
    return { packetsByThreadKey: rest };
  });
}
