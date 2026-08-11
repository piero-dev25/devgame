import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { type ChatAttachment, PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "@t3tools/contracts";

import { createAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import { AssistantImageAttachmentPersistError } from "./Errors.ts";

/**
 * Task #67 producer half: writes an image arriving inline in an assistant's
 * own ACP content stream (`ContentBlock` type "image" on `agent_message_chunk`,
 * carried through as `content.delta` / streamKind "assistant_image") to disk
 * as a `ChatAttachment`.
 *
 * This mirrors Normalizer.ts's `thread.turn.start` attachment-write branch
 * (decode → size-check → createAttachmentId → resolveAttachmentPath →
 * makeDirectory → writeFile) but is a fresh, purpose-built helper rather than
 * an extraction of that code: Normalizer.ts validates a CLIENT command and
 * rejecting the whole command on a bad attachment is correct there; this
 * persists what a PROVIDER emitted mid-turn, where the caller decides
 * separately whether a bad image should drop the image or fail the turn.
 * ACP already hands us `data`/`mimeType` as separate fields (unlike the
 * client's combined data-URL upload), so there is no data-URL parsing step.
 */
export const persistAssistantImageAttachment = (input: {
  readonly threadId: string;
  readonly attachmentsDir: string;
  readonly name: string;
  readonly mimeType: string;
  readonly base64Data: string;
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const mimeType = input.mimeType.toLowerCase();
    if (!mimeType.startsWith("image/")) {
      return yield* new AssistantImageAttachmentPersistError({
        detail: `mime type '${input.mimeType}' is not an image type.`,
      });
    }

    const bytes = Buffer.from(input.base64Data, "base64");
    if (bytes.byteLength === 0 || bytes.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
      return yield* new AssistantImageAttachmentPersistError({
        detail: `payload is empty or exceeds the ${PROVIDER_SEND_TURN_MAX_IMAGE_BYTES}-byte limit (got ${bytes.byteLength} bytes).`,
      });
    }

    const attachmentId = createAttachmentId(input.threadId);
    if (!attachmentId) {
      return yield* new AssistantImageAttachmentPersistError({
        detail: "failed to create a safe attachment id for this thread.",
      });
    }

    const persistedAttachment: ChatAttachment = {
      type: "image",
      id: attachmentId,
      name: input.name,
      mimeType,
      sizeBytes: bytes.byteLength,
    };

    const attachmentPath = resolveAttachmentPath({
      attachmentsDir: input.attachmentsDir,
      attachment: persistedAttachment,
    });
    if (!attachmentPath) {
      return yield* new AssistantImageAttachmentPersistError({
        detail: `failed to resolve a persisted path for '${input.name}'.`,
      });
    }

    yield* fileSystem.makeDirectory(path.dirname(attachmentPath), { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new AssistantImageAttachmentPersistError({
            detail: "failed to create the attachment directory.",
            cause,
          }),
      ),
    );
    yield* fileSystem.writeFile(attachmentPath, bytes).pipe(
      Effect.mapError(
        (cause) =>
          new AssistantImageAttachmentPersistError({
            detail: `failed to write attachment '${input.name}' to disk.`,
            cause,
          }),
      ),
    );

    return persistedAttachment;
  });
