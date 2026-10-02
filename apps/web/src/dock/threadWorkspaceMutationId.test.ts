import { EventId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { threadWorkspaceMutationId } from "./threadWorkspaceMutationId";

type Thread = Parameters<typeof threadWorkspaceMutationId>[0] & {};

function fileChange(id: string): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    kind: "tool.completed",
    tone: "tool",
    summary: "Tool activity",
    payload: { itemType: "file_change" },
    turnId: null,
    createdAt: "2026-08-30T00:00:00.000Z",
  };
}

function thread(
  activities: OrchestrationThreadActivity[],
  checkpointCompletedAt: string[] = [],
): Thread {
  return {
    activities,
    checkpoints: checkpointCompletedAt.map((completedAt) => ({ completedAt })),
  } as unknown as Thread;
}

describe("threadWorkspaceMutationId", () => {
  it("is null without a thread or any mutation", () => {
    expect(threadWorkspaceMutationId(null)).toBeNull();
    expect(threadWorkspaceMutationId(thread([]))).toBeNull();
  });

  it("matches ChatView's formula: latest mutation activity plus latest checkpoint", () => {
    expect(threadWorkspaceMutationId(thread([fileChange("a"), fileChange("b")]))).toBe(
      JSON.stringify(["b", null]),
    );
    expect(
      threadWorkspaceMutationId(
        thread([fileChange("a")], ["2026-08-30T00:00:01.000Z", "2026-08-30T00:00:02.000Z"]),
      ),
    ).toBe(JSON.stringify(["a", "2026-08-30T00:00:02.000Z"]));
    expect(threadWorkspaceMutationId(thread([], ["2026-08-30T00:00:01.000Z"]))).toBe(
      JSON.stringify([null, "2026-08-30T00:00:01.000Z"]),
    );
  });
});
