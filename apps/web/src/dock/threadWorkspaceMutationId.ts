/**
 * The `workspaceMutationId` upstream's `DiffPanel` and `FilePreviewPanel`
 * take to refresh after the agent touches the workspace. Upstream's inline
 * right panel computes it inside `ChatView` (see `ChatView.tsx`'s own
 * `workspaceMutationId` memo). DevGame's Diff and Files surfaces are dock
 * panels with no `ChatView` above them, so they derive the same value from
 * the thread they already resolve, using the same formula.
 */
import type { EnvironmentThread } from "@t3tools/client-runtime/state/models";
import { useMemo } from "react";

import { latestWorkspaceMutationId } from "~/hooks/useWorkspaceMutationRefresh";

type WorkspaceMutationThread = Pick<EnvironmentThread, "activities" | "checkpoints">;

export function threadWorkspaceMutationId(
  thread: WorkspaceMutationThread | null | undefined,
): string | null {
  if (!thread) return null;
  const activityId = latestWorkspaceMutationId(thread.activities);
  const latestCheckpointCompletedAt = thread.checkpoints.at(-1)?.completedAt ?? null;
  return activityId === null && latestCheckpointCompletedAt === null
    ? null
    : JSON.stringify([activityId, latestCheckpointCompletedAt]);
}

export function useThreadWorkspaceMutationId(
  thread: WorkspaceMutationThread | null | undefined,
): string | null {
  const activities = thread?.activities;
  const checkpoints = thread?.checkpoints;
  return useMemo(
    () =>
      activities && checkpoints ? threadWorkspaceMutationId({ activities, checkpoints }) : null,
    [activities, checkpoints],
  );
}
