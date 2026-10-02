import { ThreadId } from "@t3tools/contracts";
import * as SchemaIssue from "effect/SchemaIssue";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../persistence/Errors.ts";

export class OrchestrationCommandInvariantError extends Schema.TaggedError<OrchestrationCommandInvariantError>()(
  "OrchestrationCommandInvariantError",
  {
    commandType: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Orchestration command invariant failed (${this.commandType}): ${this.detail}`;
  }
}

export class OrchestrationThreadSettleBlockedError extends Schema.TaggedError<OrchestrationThreadSettleBlockedError>()(
  "OrchestrationThreadSettleBlockedError",
  {
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return "This thread still needs attention. Resolve or interrupt it first, then try again.";
  }
}

export const OrchestrationCommandRejection = Schema.Union([
  OrchestrationCommandInvariantError,
  OrchestrationThreadSettleBlockedError,
]);
export type OrchestrationCommandRejection = typeof OrchestrationCommandRejection.Type;
export const isOrchestrationCommandRejection = Schema.is(OrchestrationCommandRejection);

export class OrchestrationCommandPreviouslyRejectedError extends Schema.TaggedError<OrchestrationCommandPreviouslyRejectedError>()(
  "OrchestrationCommandPreviouslyRejectedError",
  {
    commandId: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Command previously rejected (${this.commandId}): ${this.detail}`;
  }
}

export class OrchestrationCommandIdConflictError extends Schema.TaggedError<OrchestrationCommandIdConflictError>()(
  "OrchestrationCommandIdConflictError",
  {
    commandId: Schema.String,
    receiptAggregateKind: Schema.String,
    receiptAggregateId: Schema.String,
    commandAggregateKind: Schema.String,
    commandAggregateId: Schema.String,
  },
) {
  override get message(): string {
    return `Command id '${this.commandId}' already used for ${this.receiptAggregateKind} '${this.receiptAggregateId}'; refusing to replay its receipt for ${this.commandAggregateKind} '${this.commandAggregateId}'.`;
  }
}

export class OrchestrationProjectorDecodeError extends Schema.TaggedError<OrchestrationProjectorDecodeError>()(
  "OrchestrationProjectorDecodeError",
  {
    eventType: Schema.String,
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Projector decode failed for ${this.eventType}: ${this.issue}`;
  }
}

/**
 * Task #67: a provider stream (ACP `content.delta` / "assistant_image") sent
 * an image ingestion could not persist. Deliberately NOT reused from
 * Normalizer.ts's user-upload validation path — that one rejects the whole
 * client command; this one is fed by a provider we don't control, so the
 * caller (ProviderRuntimeIngestion.ts) catches it, logs, and drops the image
 * rather than failing the assistant's turn over it.
 */
export class AssistantImageAttachmentPersistError extends Schema.TaggedError<AssistantImageAttachmentPersistError>()(
  "AssistantImageAttachmentPersistError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to persist assistant image attachment: ${this.detail}`;
  }
}

export type OrchestrationDispatchError =
  | ProjectionRepositoryError
  | OrchestrationCommandRejection
  | OrchestrationCommandIdConflictError
  | OrchestrationCommandPreviouslyRejectedError
  | OrchestrationProjectorDecodeError;

export function toProjectorDecodeError(eventType: string) {
  return (error: Schema.SchemaError): OrchestrationProjectorDecodeError =>
    new OrchestrationProjectorDecodeError({
      eventType,
      issue: SchemaIssue.makeFormatterDefault()(error.issue),
      cause: error,
    });
}
