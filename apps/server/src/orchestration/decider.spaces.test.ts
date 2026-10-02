import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  SpaceId,
  ThreadId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function makeReadModel(): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    spaces: [
      {
        id: SpaceId.make("space-active"),
        projectId: ProjectId.make("project-1"),
        title: "Active",
        createdAt: NOW,
        updatedAt: NOW,
        deletedAt: null,
      },
      {
        id: SpaceId.make("space-deleted"),
        projectId: ProjectId.make("project-1"),
        title: "Deleted",
        createdAt: NOW,
        updatedAt: NOW,
        deletedAt: NOW,
      },
    ],
    threads: [
      {
        id: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        spaceId: null,
        taskRef: null,
        pullRequests: [],
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
        pinOrderKey: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ],
    updatedAt: NOW,
  };
}

const metaUpdate = (fields: Record<string, unknown>) =>
  ({
    type: "thread.meta.update",
    commandId: CommandId.make("cmd-meta"),
    threadId: ThreadId.make("thread-1"),
    ...fields,
  }) as const;

it.layer(NodeServices.layer)("thread.meta.update DevGame scope", (it) => {
  it.effect("passes space and task scope through tri-state, next to upstream fields", () =>
    Effect.gen(function* () {
      const scoped = yield* decideOrchestrationCommand({
        command: metaUpdate({
          title: "Renamed",
          spaceId: SpaceId.make("space-active"),
          taskRef: { source: "linear", id: "DEV-1" },
        }) as never,
        readModel: makeReadModel(),
      });
      const [scopedEvent] = Array.isArray(scoped) ? scoped : [scoped];
      expect(scopedEvent?.type).toBe("thread.meta-updated");
      expect(scopedEvent?.payload).toMatchObject({
        title: "Renamed",
        spaceId: "space-active",
        taskRef: { source: "linear", id: "DEV-1" },
      });

      const cleared = yield* decideOrchestrationCommand({
        command: metaUpdate({ spaceId: null, taskRef: null }) as never,
        readModel: makeReadModel(),
      });
      const [clearedEvent] = Array.isArray(cleared) ? cleared : [cleared];
      expect(clearedEvent?.payload).toMatchObject({ spaceId: null, taskRef: null });

      const untouched = yield* decideOrchestrationCommand({
        command: metaUpdate({ title: "Only title" }) as never,
        readModel: makeReadModel(),
      });
      const [untouchedEvent] = Array.isArray(untouched) ? untouched : [untouched];
      expect(untouchedEvent?.payload).not.toHaveProperty("spaceId");
      expect(untouchedEvent?.payload).not.toHaveProperty("taskRef");
    }),
  );

  it.effect("rejects a scope pointing at a deleted space", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: metaUpdate({ spaceId: SpaceId.make("space-deleted") }) as never,
        readModel: makeReadModel(),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );
});
