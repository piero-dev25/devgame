import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asEventId = (value: string): EventId => EventId.make(value);
const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);

// Task #67 producer half: an assistant message carrying an image needs the
// `attachments` the ingestion layer already persisted (see
// AssistantImageAttachmentPersistence.ts) to survive the decider and land on
// the "thread.message-sent" domain event, the same way ThreadMessageSentPayload
// already supports `attachments` for USER messages via thread.turn.start.
it.layer(NodeServices.layer)("decider assistant image attachments", (it) => {
  it.effect(
    "carries attachments from thread.message.assistant.delta into thread.message-sent",
    () =>
      Effect.gen(function* () {
        const now = "2026-01-01T00:00:00.000Z";
        const initial = createEmptyReadModel(now);
        const withProject = yield* projectEvent(initial, {
          sequence: 1,
          eventId: asEventId("evt-project-create"),
          aggregateKind: "project",
          aggregateId: asProjectId("project-1"),
          type: "project.created",
          occurredAt: now,
          commandId: CommandId.make("cmd-project-create"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-project-create"),
          metadata: {},
          payload: {
            projectId: asProjectId("project-1"),
            title: "Project",
            workspaceRoot: "/tmp/project",
            defaultModelSelection: null,
            scripts: [],
            createdAt: now,
            updatedAt: now,
          },
        });
        const readModel = yield* projectEvent(withProject, {
          sequence: 2,
          eventId: asEventId("evt-thread-create"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-1"),
          type: "thread.created",
          occurredAt: now,
          commandId: CommandId.make("cmd-thread-create"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-thread-create"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-1"),
            projectId: asProjectId("project-1"),
            title: "Thread",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          },
        });

        const attachment = {
          type: "image" as const,
          id: "thread-1-11111111-1111-4111-8111-111111111111",
          name: "game-view.png",
          mimeType: "image/png",
          sizeBytes: 8,
        };

        const result = yield* decideOrchestrationCommand({
          command: {
            type: "thread.message.assistant.delta",
            commandId: CommandId.make("cmd-assistant-image-delta"),
            threadId: ThreadId.make("thread-1"),
            messageId: asMessageId("message-assistant-1"),
            delta: "",
            attachments: [attachment],
            createdAt: now,
          },
          readModel,
        });

        const event = Array.isArray(result) ? result[0] : result;
        expect(event?.type).toBe("thread.message-sent");
        expect(event?.payload).toMatchObject({
          role: "assistant",
          attachments: [attachment],
        });
      }),
  );
});
