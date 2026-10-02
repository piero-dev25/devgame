/**
 * The visible half of "Use in chat": the composer chip for the packet staged
 * on this thread (with a remove button), and the read-only chip a sent
 * message shows for the packet it carried. Decisions live in
 * `describeWorkspacePacket` and the store; these only render.
 */
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ProjectId, ScopedThreadRef } from "@t3tools/contracts";
import { AlertTriangle, LayoutGrid, X } from "lucide-react";

import { ContextChip, ContextChipAction, ContextChipLabel } from "~/components/ContextChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

import { describeWorkspacePacket, type WorkspacePacket } from "./contextPacket";
import {
  clearStagedWorkspacePacket,
  PROJECT_MISMATCH_REASON,
  useWorkspacePacketStore,
} from "./workspacePacketStore";

function PacketChip(props: {
  readonly packet: WorkspacePacket;
  readonly blockedReason?: string | null;
  readonly onRemove?: () => void;
}) {
  const view = describeWorkspacePacket(props.packet);
  const blocked = props.blockedReason ?? null;
  const warning = blocked ?? view.warning;
  return (
    <span className="inline-flex max-w-full items-center gap-1.5">
      <Tooltip>
        <TooltipTrigger
          render={
            <ContextChip
              kind="file"
              tabIndex={0}
              {...(blocked !== null ? { state: "invalid" as const } : {})}
            />
          }
        >
          <LayoutGrid />
          <ContextChipLabel>Workspace: {view.label}</ContextChipLabel>
          {warning !== null ? <AlertTriangle aria-label={warning} /> : null}
          {props.onRemove ? (
            <ContextChipAction aria-label="Remove workspace context" onClick={props.onRemove}>
              <X />
            </ContextChipAction>
          ) : null}
        </TooltipTrigger>
        <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap">
          {warning !== null ? `${warning}\n\n${view.details}` : view.details}
        </TooltipPopup>
      </Tooltip>
      {warning !== null ? (
        <span className="truncate text-2xs text-muted-foreground/80">{warning}</span>
      ) : null}
    </span>
  );
}

/** Composer: the packet staged for this thread, or nothing. */
export function WorkspacePacketChip(props: {
  readonly threadRef: ScopedThreadRef;
  readonly projectId: ProjectId | null;
}) {
  const threadKey = scopedThreadKey(props.threadRef);
  const packet = useWorkspacePacketStore((state) => state.packetsByThreadKey[threadKey] ?? null);
  if (packet === null) return null;
  return (
    <div className="mb-3 flex flex-wrap items-center gap-1.5">
      <PacketChip
        packet={packet}
        blockedReason={
          packet.projectId === props.projectId
            ? null
            : `Not sent: ${PROJECT_MISMATCH_REASON.toLowerCase()}`
        }
        onRemove={() => clearStagedWorkspacePacket(props.threadRef)}
      />
    </div>
  );
}

/** Transcript: the packet a sent message carried, or nothing. */
export function WorkspacePacketMessageChip(props: { readonly packet: WorkspacePacket | null }) {
  if (props.packet === null) return null;
  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5">
      <PacketChip packet={props.packet} />
    </div>
  );
}
