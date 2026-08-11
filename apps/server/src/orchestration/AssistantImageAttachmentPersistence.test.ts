import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { resolveAttachmentPathById } from "../attachmentStore.ts";
import { persistAssistantImageAttachment } from "./AssistantImageAttachmentPersistence.ts";

// Task #67 producer half: the ingestion layer needs a way to turn a
// base64-encoded image arriving from an ACP `content.delta` / "assistant_image"
// event into a `ChatAttachment` written to disk — the same on-disk shape
// Normalizer.ts already produces for user-uploaded attachments, but this is a
// fresh helper (Normalizer.ts's write path is untouched) since this input
// comes from a provider stream, not a validated client command.
const makeTempAttachmentsDir = Effect.fn("makeTempAttachmentsDir")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3code-assistant-image-attachments-",
  });
});

it.effect("persists a base64 image payload to disk as a ChatAttachment", () =>
  Effect.gen(function* () {
    const attachmentsDir = yield* makeTempAttachmentsDir();
    const fileSystem = yield* FileSystem.FileSystem;

    const attachment = yield* persistAssistantImageAttachment({
      threadId: "thread-1",
      attachmentsDir,
      name: "game-view.png",
      mimeType: "image/png",
      base64Data: "iVBORw0KGgo=",
    });

    expect(attachment).toMatchObject({
      type: "image",
      name: "game-view.png",
      mimeType: "image/png",
      sizeBytes: 8,
    });

    const writtenPath = resolveAttachmentPathById({
      attachmentsDir,
      attachmentId: attachment.id,
    });
    expect(writtenPath).not.toBeNull();
    const written = yield* fileSystem.readFile(writtenPath!);
    expect(Buffer.from(written).toString("base64")).toBe("iVBORw0KGgo=");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("fails without writing anything when the mime type is not an image", () =>
  Effect.gen(function* () {
    const attachmentsDir = yield* makeTempAttachmentsDir();

    const error = yield* persistAssistantImageAttachment({
      threadId: "thread-1",
      attachmentsDir,
      name: "not-an-image.txt",
      mimeType: "text/plain",
      base64Data: "aGVsbG8=",
    }).pipe(Effect.flip);

    expect(error._tag).toBe("AssistantImageAttachmentPersistError");
    expect(error.message).toContain("text/plain");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("fails on an empty decoded payload rather than writing a zero-byte file", () =>
  Effect.gen(function* () {
    const attachmentsDir = yield* makeTempAttachmentsDir();

    const error = yield* persistAssistantImageAttachment({
      threadId: "thread-1",
      attachmentsDir,
      name: "empty.png",
      mimeType: "image/png",
      base64Data: "",
    }).pipe(Effect.flip);

    expect(error._tag).toBe("AssistantImageAttachmentPersistError");
  }).pipe(Effect.provide(NodeServices.layer)),
);
