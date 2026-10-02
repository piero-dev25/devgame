import * as NodeCrypto from "node:crypto";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import type * as Types from "effect/Types";
import { McpProtocol, McpSchema, McpServer, Tool } from "effect/unstable/ai";
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { type InspectGenerationInput, PreviewAutomationError } from "@t3tools/contracts";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import * as DeviceService from "../device/DeviceService.ts";
import * as GenerationService from "../generation/GenerationService.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import {
  GenerationStandardToolkitHandlersLive,
  inspectGeneration,
} from "./toolkits/generation/handlers.ts";
import { GenerationStandardToolkit, InspectGenerationTool } from "./toolkits/generation/tools.ts";
import {
  PreviewSnapshotToolkitHandlersLive,
  PreviewStandardToolkitHandlersLive,
} from "./toolkits/preview/handlers.ts";
import {
  PreviewSnapshotTool,
  PreviewSnapshotToolkit,
  PreviewStandardToolkit,
} from "./toolkits/preview/tools.ts";
import { PullRequestsToolkitHandlersLive } from "./toolkits/pullRequests/handlers.ts";
import { PullRequestsToolkit } from "./toolkits/pullRequests/tools.ts";
import {
  DeviceScreenshotToolkitHandlersLive,
  DeviceStandardToolkitHandlersLive,
} from "./toolkits/device/handlers.ts";
import {
  DeviceScreenshotTool,
  DeviceScreenshotToolkit,
  DeviceStandardToolkit,
} from "./toolkits/device/tools.ts";

const unauthorized = HttpServerResponse.jsonUnsafe(
  {
    error: "invalid_mcp_credential",
    message: "A valid provider-scoped MCP bearer credential is required.",
  },
  {
    status: 401,
    headers: {
      "cache-control": "no-store",
      "www-authenticate": "Bearer",
    },
  },
);

type AuthenticatedHttpEffect = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  McpInvocationContext.McpInvocationContext
>;

type McpAuthMiddleware = (
  httpEffect: AuthenticatedHttpEffect,
) => Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  HttpServerRequest.HttpServerRequest
>;

export const normalizeMcpHttpResponse = (
  response: HttpServerResponse.HttpServerResponse,
): HttpServerResponse.HttpServerResponse => {
  const bodyIsEmpty =
    response.body._tag === "Empty" ||
    (response.body._tag === "Uint8Array" && response.body.contentLength === 0) ||
    (response.body._tag === "Raw" && response.body.contentLength === 0);
  return response.status === 200 && bodyIsEmpty
    ? HttpServerResponse.setStatus(response, 202)
    : response;
};

const makeMcpAuthMiddleware = McpSessionRegistry.McpSessionRegistry.pipe(
  Effect.map((registry): McpAuthMiddleware =>
    Effect.fn("McpHttpServer.authenticateRequest")(function* (httpEffect) {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const authorization = request.headers.authorization;
      const token =
        authorization?.startsWith("Bearer ") === true
          ? authorization.slice("Bearer ".length).trim()
          : "";
      const invocation = yield* registry.resolve(token);
      if (!invocation) {
        // Without this the only symptom of a dead credential is the agent
        // quietly losing the whole `devgame` toolkit for the rest of its
        // session, with nothing on the server to explain why.
        yield* Effect.logWarning("rejected MCP request with an unusable credential", {
          reason: token.length === 0 ? "missing_bearer_token" : "unknown_or_expired_token",
        });
        return unauthorized;
      }
      return yield* httpEffect.pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.map(normalizeMcpHttpResponse),
      );
    }),
  ),
  Effect.withSpan("McpHttpServer.makeAuthMiddleware"),
);

const McpAuthMiddlewareLive = HttpRouter.middleware<{
  provides: McpInvocationContext.McpInvocationContext;
}>()(makeMcpAuthMiddleware).layer;

/**
 * Claude Code moves an MCP result above its output limit to a file and hands
 * the agent a notice instead, so a snapshot that carries the full
 * accessibility tree and page text loses its locators too. Claude Code also
 * shows the model `structuredContent` in place of the text blocks when a
 * result has both, so both carry the same bounded snapshot. Keep it near
 * 20 KB and tell the agent what was cut. The short `omitted` notes may go a
 * little over; the provider limit is far above this.
 */
export const MAX_SNAPSHOT_TEXT_BYTES = 20_000;
const MAX_SNAPSHOT_VISIBLE_TEXT_CHARS = 8_000;
const MAX_SNAPSHOT_ELEMENT_NAME_CHARS = 200;
const MAX_SNAPSHOT_LOG_ENTRIES = 40;
const MAX_SNAPSHOT_LOG_TEXT_CHARS = 500;
const MAX_SNAPSHOT_IDENTIFIER_CHARS = 2_048;

const encodeJsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const utf8Length = (text: string) => Buffer.byteLength(text, "utf8");
const cutText = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}…` : text;

/** Shortens every string field of a log entry; other fields pass through. */
const cutEntryStrings = <A>(entry: A): A =>
  typeof entry === "object" && entry !== null
    ? (Object.fromEntries(
        Object.entries(entry).map(([key, value]) => [
          key,
          typeof value === "string" ? cutText(value, MAX_SNAPSHOT_LOG_TEXT_CHARS) : value,
        ]),
      ) as A)
    : entry;

const hasLongString = (entry: unknown, max: number) =>
  typeof entry === "object" &&
  entry !== null &&
  Object.values(entry).some((value) => typeof value === "string" && value.length > max);

type SnapshotMetadata = {
  readonly url: string;
  readonly title: string;
  readonly visibleText: string;
  readonly interactiveElements: ReadonlyArray<{
    readonly name: string;
    readonly [key: string]: unknown;
  }>;
  readonly consoleEntries: ReadonlyArray<unknown>;
  readonly networkEntries: ReadonlyArray<unknown>;
  readonly actionTimeline: ReadonlyArray<unknown>;
  readonly [key: string]: unknown;
};

/**
 * Drops the accessibility tree, shortens page text, element names, identifiers,
 * and log strings, keeps only the newest log entries, and finally sheds
 * interactive elements until the JSON fits. Returns the bounded value, its
 * text, and notes on what is missing so the agent can reach for
 * preview_evaluate.
 */
const boundSnapshotMetadata = (metadata: SnapshotMetadata) => {
  const omitted: Array<string> = [];
  const { accessibilityTree, ...withoutTree } = metadata;
  if (accessibilityTree !== undefined) {
    omitted.push("accessibilityTree (use interactiveElements locators or preview_evaluate)");
  }
  const tail = <A>(entries: ReadonlyArray<A>, label: string) => {
    if (entries.length > MAX_SNAPSHOT_LOG_ENTRIES) {
      omitted.push(`${entries.length - MAX_SNAPSHOT_LOG_ENTRIES} older ${label}`);
    }
    const kept = entries.slice(-MAX_SNAPSHOT_LOG_ENTRIES);
    if (kept.some((entry) => hasLongString(entry, MAX_SNAPSHOT_LOG_TEXT_CHARS))) {
      omitted.push(`${label} text after ${MAX_SNAPSHOT_LOG_TEXT_CHARS} characters`);
    }
    return kept.map(cutEntryStrings);
  };
  if (
    metadata.url.length > MAX_SNAPSHOT_IDENTIFIER_CHARS ||
    metadata.title.length > MAX_SNAPSHOT_IDENTIFIER_CHARS
  ) {
    omitted.push(`url or title after ${MAX_SNAPSHOT_IDENTIFIER_CHARS} characters`);
  }
  if (
    metadata.interactiveElements.some(
      (element) => element.name.length > MAX_SNAPSHOT_ELEMENT_NAME_CHARS,
    )
  ) {
    omitted.push(`element names longer than ${MAX_SNAPSHOT_ELEMENT_NAME_CHARS} characters`);
  }
  const bounded = {
    ...withoutTree,
    url: cutText(metadata.url, MAX_SNAPSHOT_IDENTIFIER_CHARS),
    title: cutText(metadata.title, MAX_SNAPSHOT_IDENTIFIER_CHARS),
    interactiveElements: metadata.interactiveElements.map((element) => ({
      ...element,
      name: cutText(element.name, MAX_SNAPSHOT_ELEMENT_NAME_CHARS),
    })),
    consoleEntries: tail(metadata.consoleEntries, "console entries"),
    networkEntries: tail(metadata.networkEntries, "network entries"),
    actionTimeline: tail(metadata.actionTimeline, "action timeline entries"),
  };

  // Per-field caps do not sum below the ceiling: three log arrays of 40 capped
  // entries alone can pass 60 KB, and the caps count characters, not bytes.
  // Halve one thing per round until the JSON fits: logs first, then page
  // text, then the locators. The identifier caps bound the rest, so this
  // terminates.
  const shedOrder = [
    "actionTimeline",
    "networkEntries",
    "consoleEntries",
    "interactiveElements",
  ] as const;
  const lists: Record<(typeof shedOrder)[number], ReadonlyArray<unknown>> = {
    interactiveElements: bounded.interactiveElements,
    consoleEntries: bounded.consoleEntries,
    networkEntries: bounded.networkEntries,
    actionTimeline: bounded.actionTimeline,
  };
  const dropped: Record<(typeof shedOrder)[number], number> = {
    interactiveElements: 0,
    consoleEntries: 0,
    networkEntries: 0,
    actionTimeline: 0,
  };
  let visibleTextChars = Math.min(metadata.visibleText.length, MAX_SNAPSHOT_VISIBLE_TEXT_CHARS);
  const value = () => ({
    ...bounded,
    visibleText: cutText(metadata.visibleText, visibleTextChars),
    ...lists,
  });
  let text = encodeJsonText(value());
  while (utf8Length(text) > MAX_SNAPSHOT_TEXT_BYTES) {
    // Elements carry the locators, so they go last; logs shed newest-last.
    const key =
      shedOrder.find(
        (candidate) => candidate !== "interactiveElements" && lists[candidate].length > 0,
      ) ??
      (visibleTextChars > 0
        ? "visibleText"
        : lists.interactiveElements.length > 0
          ? "interactiveElements"
          : undefined);
    if (key === undefined) break;
    if (key === "visibleText") {
      visibleTextChars = Math.floor(visibleTextChars / 2);
    } else {
      const keep = Math.floor(lists[key].length / 2);
      dropped[key] += lists[key].length - keep;
      // slice(-0) keeps everything, so spell out the empty case.
      lists[key] =
        keep === 0
          ? []
          : key === "interactiveElements"
            ? lists[key].slice(0, keep)
            : lists[key].slice(-keep);
    }
    text = encodeJsonText(value());
  }
  if (visibleTextChars < metadata.visibleText.length) {
    omitted.push(
      `visibleText after ${visibleTextChars} characters (use preview_evaluate for more)`,
    );
  }
  for (const key of shedOrder) {
    if (dropped[key] > 0) {
      omitted.push(`${dropped[key]} of ${bounded[key].length} ${key}`);
    }
  }
  return { value: value(), text, omitted };
};

export class PreviewScreenshotSaveError extends Schema.TaggedError<PreviewScreenshotSaveError>()(
  "PreviewScreenshotSaveError",
  { screenshotPath: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not save preview screenshot to ${this.screenshotPath}.`;
  }
}

const MAX_SCREENSHOT_SITE_SLUG_LENGTH = 40;

/** Hostname reduced to a filename-safe slug, matching the desktop's own screenshot names. */
const screenshotSiteSlug = (rawUrl: string): string => {
  try {
    const slug = new URL(rawUrl).hostname
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, MAX_SCREENSHOT_SITE_SLUG_LENGTH)
      .replace(/-+$/g, "");
    return slug || "site";
  } catch {
    return "site";
  }
};

/** Writes the snapshot PNG under the browser artifacts directory and returns its path. */
const saveScreenshot = Effect.fn("McpHttpServer.saveScreenshot")(function* (
  pageUrl: string,
  data: Uint8Array,
) {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const millis = yield* Clock.currentTimeMillis;
  // Two saves in the same millisecond must not overwrite each other.
  const fileName = `browser-screenshot-${screenshotSiteSlug(pageUrl)}-${millis.toString(36)}-${NodeCrypto.randomUUID().slice(0, 8)}.png`;
  const screenshotPath = path.join(config.browserArtifactsDir, fileName);
  yield* fileSystem.makeDirectory(config.browserArtifactsDir, { recursive: true }).pipe(
    Effect.andThen(fileSystem.writeFile(screenshotPath, data)),
    Effect.mapError((cause) => new PreviewScreenshotSaveError({ screenshotPath, cause })),
  );
  return screenshotPath;
});

const isPreviewAutomationError = Schema.is(PreviewAutomationError);

const previewSnapshotFailure = <E>(cause: Cause.Cause<E>) => {
  if (Cause.hasInterrupts(cause) || cause.reasons.some(Cause.isDieReason)) {
    return Effect.failCause(cause).pipe(Effect.orDie);
  }
  const failures = cause.reasons.filter(Cause.isFailReason);
  const firstFailure = failures[0]?.error;
  const errorTag =
    typeof firstFailure === "object" &&
    firstFailure !== null &&
    "_tag" in firstFailure &&
    typeof firstFailure._tag === "string"
      ? firstFailure._tag
      : "PreviewSnapshotError";
  // Preview errors build their message on the server, never from page output,
  // and it tells the agent what to do next, such as falling back to a shell browser.
  const message = isPreviewAutomationError(firstFailure) ? firstFailure.message : undefined;
  const result = new McpSchema.CallToolResult({
    isError: true,
    structuredContent: {
      error: {
        _tag: errorTag,
        operation: "snapshot",
        failureCount: failures.length,
        ...(message === undefined ? {} : { message }),
      },
    },
    // Some clients show only the text content and others only structuredContent, so both carry it.
    content: [{ type: "text", text: `Preview snapshot failed: ${message ?? `${errorTag}.`}` }],
  });
  return Effect.logWarning("preview snapshot failed", {
    operation: "snapshot",
    errorTag,
    failureCount: failures.length,
  }).pipe(Effect.as(result));
};

const registerPreviewSnapshot = Effect.fn("McpHttpServer.registerPreviewSnapshot")(function* () {
  const server = yield* McpServer.McpServer;
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  // The MCP tool runner only supplies the client, so hand the save path its services here.
  const saveServices = yield* Effect.context<
    ServerConfig.ServerConfig | FileSystem.FileSystem | Path.Path
  >();
  const built = yield* PreviewSnapshotToolkit;
  const tool = PreviewSnapshotTool;
  yield* server.addTool({
    tool: new McpSchema.Tool({
      name: tool.name,
      description: Tool.getDescription(tool),
      inputSchema: Tool.getJsonSchema(tool),
      annotations: {
        ...Context.getOption(tool.annotations, Tool.Title).pipe(
          Option.map((title) => ({ title })),
          Option.getOrUndefined,
        ),
        readOnlyHint: Context.get(tool.annotations, Tool.Readonly),
        destructiveHint: Context.get(tool.annotations, Tool.Destructive),
        idempotentHint: Context.get(tool.annotations, Tool.Idempotent),
        openWorldHint: Context.get(tool.annotations, Tool.OpenWorld),
      },
    }),
    annotations: tool.annotations,
    handle: (payload) =>
      Effect.withFiber((fiber) => {
        const invocation = Context.getUnsafe(
          fiber.context,
          McpInvocationContext.McpInvocationContext,
        );
        return built.handle("preview_snapshot", payload).pipe(
          Stream.unwrap,
          Stream.run(Sink.last()),
          Effect.flatMap(Effect.fromOption),
          Effect.provideService(PreviewAutomationBroker.PreviewAutomationBroker, broker),
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.flatMap(({ encodedResult }) =>
            Effect.gen(function* () {
              const snapshot = encodedResult as SnapshotMetadata & {
                readonly url: string;
                readonly screenshot: {
                  readonly mimeType: "image/png";
                  readonly data: string;
                  readonly width: number;
                  readonly height: number;
                };
              };
              const { screenshot, ...page } = snapshot;
              const png = new Uint8Array(Buffer.from(screenshot.data, "base64"));
              const screenshotPath =
                payload?.save === true ? yield* saveScreenshot(snapshot.url, png) : undefined;
              if (screenshotPath !== undefined && payload?.includeImage === false) {
                // The agent only wants a file to show the user. The url keeps the site icon on the tool row.
                const saved = {
                  url: cutText(snapshot.url, MAX_SNAPSHOT_IDENTIFIER_CHARS),
                  screenshotPath,
                };
                return new McpSchema.CallToolResult({
                  isError: false,
                  structuredContent: saved,
                  content: [{ type: "text", text: encodeJsonText(saved) }],
                });
              }
              const metadata = {
                ...page,
                screenshot: {
                  mimeType: screenshot.mimeType,
                  width: screenshot.width,
                  height: screenshot.height,
                },
                ...(screenshotPath === undefined ? {} : { screenshotPath }),
              };
              const bounded = boundSnapshotMetadata(metadata);
              return new McpSchema.CallToolResult({
                isError: false,
                structuredContent:
                  bounded.omitted.length === 0
                    ? bounded.value
                    : { ...bounded.value, omitted: bounded.omitted },
                content: [
                  // Keep the page identity readable even if a provider truncates the snapshot.
                  {
                    type: "text",
                    text: encodeJsonText({
                      url: cutText(snapshot.url, MAX_SNAPSHOT_IDENTIFIER_CHARS),
                    }),
                  },
                  { type: "text", text: bounded.text },
                  ...(bounded.omitted.length === 0
                    ? []
                    : [
                        {
                          type: "text" as const,
                          text: `Snapshot text was bounded. Omitted: ${bounded.omitted.join("; ")}.`,
                        },
                      ]),
                  ...(payload?.includeImage === false
                    ? []
                    : [{ type: "image" as const, data: png, mimeType: screenshot.mimeType }]),
                ],
              });
            }),
          ),
          Effect.provide(saveServices),
          Effect.matchCauseEffect({
            onFailure: previewSnapshotFailure,
            onSuccess: Effect.succeed,
          }),
        );
      }),
  });
});

interface ImageToolResult {
  readonly screenshot: {
    readonly mimeType: "image/png";
    readonly data: string;
    readonly width: number;
    readonly height: number;
  };
  readonly [key: string]: unknown;
}

/**
 * Failures surface only their tag: the remote message may carry renderer or
 * device output the agent should not see, and the tag is what it can act on.
 */
const imageToolFailure =
  (toolName: string, operation: string, failureText: string) =>
  <E>(cause: Cause.Cause<E>) => {
    if (Cause.hasInterrupts(cause) || cause.reasons.some(Cause.isDieReason)) {
      return Effect.failCause(cause).pipe(Effect.orDie);
    }
    const failures = cause.reasons.filter(Cause.isFailReason);
    const firstFailure = failures[0]?.error;
    const errorTag =
      typeof firstFailure === "object" &&
      firstFailure !== null &&
      "_tag" in firstFailure &&
      typeof firstFailure._tag === "string"
        ? firstFailure._tag
        : `${toolName}Error`;
    const result = new McpSchema.CallToolResult({
      isError: true,
      structuredContent: {
        error: {
          _tag: errorTag,
          operation,
          failureCount: failures.length,
        },
      },
      content: [{ type: "text", text: failureText }],
    });
    return Effect.logWarning(`${toolName} failed`, {
      operation,
      errorTag,
      failureCount: failures.length,
    }).pipe(Effect.as(result));
  };

/**
 * `McpServer.toolkit` serializes every result as JSON text, which is the
 * wrong shape for a screenshot: the model needs image content. Tools whose
 * result carries a `screenshot` field are registered by hand so the PNG goes
 * out as an image block and the rest of the payload as JSON metadata.
 */
const registerImageTool = <T extends Tool.Any, E, R>(
  tool: T,
  handle: (payload: Tool.Parameters<T>) => Effect.Effect<{ readonly encodedResult: unknown }, E, R>,
  provide: (
    effect: Effect.Effect<{ readonly encodedResult: unknown }, E, R>,
  ) => Effect.Effect<
    { readonly encodedResult: unknown },
    E,
    McpInvocationContext.McpInvocationContext
  >,
  operation: string,
  failureText: string,
) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    yield* server.addTool({
      tool: new McpSchema.Tool({
        name: tool.name,
        description: Tool.getDescription(tool),
        inputSchema: Tool.getJsonSchema(tool),
        annotations: {
          ...Context.getOption(tool.annotations, Tool.Title).pipe(
            Option.map((title) => ({ title })),
            Option.getOrUndefined,
          ),
          readOnlyHint: Context.get(tool.annotations, Tool.Readonly),
          destructiveHint: Context.get(tool.annotations, Tool.Destructive),
          idempotentHint: Context.get(tool.annotations, Tool.Idempotent),
          openWorldHint: Context.get(tool.annotations, Tool.OpenWorld),
        },
      }),
      annotations: tool.annotations,
      handle: (payload) =>
        Effect.withFiber((fiber) => {
          const invocation = Context.getUnsafe(
            fiber.context,
            McpInvocationContext.McpInvocationContext,
          );
          return provide(handle(payload as Tool.Parameters<T>)).pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
            Effect.matchCauseEffect({
              onFailure: imageToolFailure(tool.name, operation, failureText),
              onSuccess: ({ encodedResult }) => {
                const { screenshot, ...rest } = encodedResult as ImageToolResult;
                const includeImage =
                  (payload as { readonly includeImage?: boolean } | undefined)?.includeImage !==
                  false;
                const metadata = {
                  ...rest,
                  screenshot: {
                    mimeType: screenshot.mimeType,
                    width: screenshot.width,
                    height: screenshot.height,
                  },
                };
                return Effect.succeed(
                  new McpSchema.CallToolResult({
                    isError: false,
                    structuredContent: metadata,
                    content: [
                      { type: "text", text: JSON.stringify(metadata) },
                      ...(includeImage
                        ? [
                            {
                              type: "image" as const,
                              data: new Uint8Array(Buffer.from(screenshot.data, "base64")),
                              mimeType: screenshot.mimeType,
                            },
                          ]
                        : []),
                    ],
                  }),
                );
              },
            }),
          );
        }),
    });
  });

const registerDeviceScreenshot = Effect.fn("McpHttpServer.registerDeviceScreenshot")(function* () {
  const devices = yield* DeviceService.DeviceService;
  const built = yield* DeviceScreenshotToolkit;
  yield* registerImageTool(
    DeviceScreenshotTool,
    (payload) =>
      built
        .handle("device_screenshot", payload)
        .pipe(Stream.unwrap, Stream.run(Sink.last()), Effect.flatMap(Effect.fromOption)),
    (effect) => effect.pipe(Effect.provideService(DeviceService.DeviceService, devices)),
    "screenshot",
    "Device screenshot failed.",
  );
});

const PreviewStandardToolkitRegistrationLive = McpServer.toolkit(PreviewStandardToolkit).pipe(
  Layer.provide(PreviewStandardToolkitHandlersLive),
);

const PreviewSnapshotRegistrationLive = Layer.effectDiscard(registerPreviewSnapshot()).pipe(
  Layer.provide(PreviewSnapshotToolkitHandlersLive),
);

export const PreviewToolkitRegistrationLive = Layer.mergeAll(
  PreviewStandardToolkitRegistrationLive,
  PreviewSnapshotRegistrationLive,
);

export const PullRequestsToolkitRegistrationLive = McpServer.toolkit(PullRequestsToolkit).pipe(
  Layer.provide(PullRequestsToolkitHandlersLive),
);

const DeviceStandardToolkitRegistrationLive = McpServer.toolkit(DeviceStandardToolkit).pipe(
  Layer.provide(DeviceStandardToolkitHandlersLive),
);

const DeviceScreenshotRegistrationLive = Layer.effectDiscard(registerDeviceScreenshot()).pipe(
  Layer.provide(DeviceScreenshotToolkitHandlersLive),
);

export const DeviceToolkitRegistrationLive = Layer.mergeAll(
  DeviceStandardToolkitRegistrationLive,
  DeviceScreenshotRegistrationLive,
);

// V2 Increment 1 — generation half (docs/v2/specs/increment-1-generation-service.md).
// `inspect_generation` is registered manually (the `registerImageTool` idiom)
// because it hands back a preview image content block alongside structured
// JSON. Unlike `registerImageTool` the image is fetched from the generation
// provider's preview URL, not carried in the result, so it keeps its own
// registration but shares `imageToolFailure` for failures. The other
// generation tools are declarative, like the rest of the toolkits.

/** Merge-gate P1 #4: same cap as the GLB download (GenerationService.ts),
 * sized for a render, not a model — Tripo preview renders are small PNGs
 * in practice; 20MB is generous headroom, not a target. */
const MAX_PREVIEW_IMAGE_BYTES = 20 * 1_024 * 1_024;

class PreviewImageTooLargeError extends Schema.TaggedError<PreviewImageTooLargeError>()(
  "PreviewImageTooLargeError",
  { byteLength: Schema.Number },
) {
  override get message(): string {
    return `Preview image is ${this.byteLength} bytes, exceeding the ${MAX_PREVIEW_IMAGE_BYTES}-byte cap.`;
  }
}

/** Best-effort: a missing/unfetchable/oversized preview image degrades the
 * result to text + structured content only, it never fails the whole tool
 * call — the technical facts (`inspect_generation`'s actual point, per
 * spike 0) are still useful without a picture. */
const fetchPreviewImageBlock = (httpClient: HttpClient.HttpClient, imageUrl: string | null) =>
  imageUrl === null
    ? Effect.succeed(null)
    : HttpClientRequest.get(imageUrl).pipe(
        httpClient.execute,
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        // Cap BEFORE buffering where declared — merge-gate P1 #4. Kept as
        // its own step (not folded into the mimeType-derivation step
        // below) so each step returns a single uniform Effect shape —
        // mixing an `Effect.fail` branch into the same callback that also
        // returns `response.arrayBuffer` defeated TypeScript's inference
        // across the whole chain (the same issue GenerationService.ts's
        // GLB download hit).
        Effect.flatMap((response) => {
          const declaredLength = Number(response.headers["content-length"]);
          return Number.isFinite(declaredLength) && declaredLength > MAX_PREVIEW_IMAGE_BYTES
            ? Effect.fail(new PreviewImageTooLargeError({ byteLength: declaredLength }))
            : Effect.succeed(response);
        }),
        Effect.map((response) => ({
          response,
          // Merge-gate P3 #11: derive from the response instead of
          // hardcoding — Tripo's docs do not guarantee PNG.
          mimeType:
            (response.headers["content-type"] ?? "image/png").split(";")[0]?.trim() || "image/png",
        })),
        Effect.flatMap(({ response, mimeType }) =>
          Effect.map(response.arrayBuffer, (buffer) => ({ buffer, mimeType })),
        ),
        Effect.flatMap(({ buffer, mimeType }) => {
          const data = new Uint8Array(buffer);
          return data.length > MAX_PREVIEW_IMAGE_BYTES
            ? Effect.fail(new PreviewImageTooLargeError({ byteLength: data.length }))
            : Effect.succeed({ type: "image" as const, data, mimeType });
        }),
        Effect.orElseSucceed(() => null),
      );

const registerInspectGeneration = Effect.fn("McpHttpServer.registerInspectGeneration")(
  function* () {
    const server = yield* McpServer.McpServer;
    const generationService = yield* GenerationService.GenerationService;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    const httpClient = yield* HttpClient.HttpClient;
    const tool = InspectGenerationTool;
    yield* server.addTool({
      tool: new McpSchema.Tool({
        name: tool.name,
        description: Tool.getDescription(tool),
        inputSchema: Tool.getJsonSchema(tool),
        annotations: {
          ...Context.getOption(tool.annotations, Tool.Title).pipe(
            Option.map((title) => ({ title })),
            Option.getOrUndefined,
          ),
          readOnlyHint: Context.get(tool.annotations, Tool.Readonly),
          destructiveHint: Context.get(tool.annotations, Tool.Destructive),
          idempotentHint: Context.get(tool.annotations, Tool.Idempotent),
          openWorldHint: Context.get(tool.annotations, Tool.OpenWorld),
        },
      }),
      annotations: tool.annotations,
      handle: (payload) =>
        Effect.withFiber((fiber) => {
          const invocation = Context.getUnsafe(
            fiber.context,
            McpInvocationContext.McpInvocationContext,
          );
          return inspectGeneration(payload as InspectGenerationInput).pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
            Effect.provideService(GenerationService.GenerationService, generationService),
            Effect.provideService(
              ProjectionSnapshotQuery.ProjectionSnapshotQuery,
              projectionSnapshotQuery,
            ),
            Effect.matchCauseEffect({
              onFailure: imageToolFailure(
                "inspect_generation",
                "inspect_generation",
                "inspect_generation failed.",
              ),
              onSuccess: (asset) =>
                fetchPreviewImageBlock(httpClient, asset.preview.imageUrl).pipe(
                  Effect.map(
                    (imageBlock) =>
                      new McpSchema.CallToolResult({
                        isError: false,
                        structuredContent: asset,
                        content: [
                          { type: "text", text: JSON.stringify(asset) },
                          ...(imageBlock === null ? [] : [imageBlock]),
                        ],
                      }),
                  ),
                ),
            }),
          );
        }),
    });
  },
);

const GenerationStandardToolkitRegistrationLive = McpServer.toolkit(GenerationStandardToolkit).pipe(
  Layer.provide(GenerationStandardToolkitHandlersLive),
);

/** Exported (not just used by `GenerationToolkitRegistrationLive` below) so
 * `registerInspectGeneration`'s own image-block-assembly/degrade-on-failure
 * behavior is directly testable against a fake `GenerationService`, without
 * needing a real Tripo job lifecycle — merge-gate P3 #8. */
export const GenerationInspectRegistrationLive = Layer.effectDiscard(registerInspectGeneration());

/**
 * `generationServiceLive` is a PARAMETER (Increment 2b.1,
 * docs/v2/specs/increment-2b1-generation-panel.md) — this used to build its
 * OWN private `GenerationServiceLive = GenerationService.layer().pipe(
 * Layer.provide(TripoProvider.layer))` right here. That was fine while the
 * MCP tools were the only consumer of `GenerationService`; once a web route
 * (`GenerationListRoute.ts`) needs to read the SAME in-memory job/asset
 * registry, TWO independent `GenerationService.layer()` calls would each
 * memoize their OWN separate instance (Effect memoizes per LAYER
 * REFERENCE, not per underlying service) — the panel would show nothing
 * forever, no error. `server.ts` now hoists ONE `GenerationServiceLive`
 * const (mirroring how `EditorPresenceRegistry.layer` is hoisted there
 * already) and passes that SAME reference in here AND into the new routes'
 * own `HttpRouter.provideRequest` — this function threading it through
 * (rather than importing `TripoProvider`/building its own instance) is
 * what makes that sharing real instead of just plausible-looking.
 */
const GenerationToolkitRegistrationLive = <R>(
  generationServiceLive: Layer.Layer<GenerationService.GenerationService, never, R>,
) =>
  Layer.mergeAll(GenerationStandardToolkitRegistrationLive, GenerationInspectRegistrationLive).pipe(
    Layer.provide(generationServiceLive),
  );

const McpTransportLive = McpServer.layerHttp({
  name: "DevGame",
  version: packageJson.version,
  path: "/mcp",
  protocols: [McpProtocol.v2025_06_18],
}).pipe(Layer.provide(McpAuthMiddlewareLive));

// Startup check over the SERVED McpServer: logs the served tool names once and
// fails loudly on any malformed inputSchema. Requires the bare
// `McpServer.McpServer` tag, discharged by the same
// `Layer.provideMerge(McpTransportLive)` as the toolkits, so it reads the
// instance the HTTP transport serves.
const McpDiagStartupLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    yield* Effect.logInfo("[mcp-diag] served McpServer tools", {
      count: server.tools.length,
      names: server.tools.map(({ tool }) => tool.name),
    });
    // #155-B DEFENSIVE GUARD (docs/v2/specs/increment-155-B-empty-schema-fix.md):
    // the `claude` CLI's tools/list validator rejects the ENTIRE array if even
    // ONE served tool's inputSchema lacks a top-level `type:"object"` — the
    // ROOT CAUSE of #155 (a bare `Schema.Struct({})` for `list_generations`
    // silently took every tool dark). Checked here, after every declarative
    // toolkit and every manual registration has completed. Fail LOUD at
    // server startup, naming every offender, instead of silently repairing a
    // malformed schema: a repair could paper over a genuinely different
    // future schema bug, where a crash with an actionable message cannot.
    const invalidToolSchemas = server.tools
      .filter(({ tool }) => (tool.inputSchema as { readonly type?: unknown })?.type !== "object")
      .map(({ tool }) => tool.name);
    if (invalidToolSchemas.length > 0) {
      return yield* Effect.die(
        new Error(
          `MCP tool(s) [${invalidToolSchemas.join(", ")}] have an inputSchema without a ` +
            `top-level "type":"object" — the claude CLI's tools/list validator rejects the ` +
            `ENTIRE tool array when even one is malformed (see #155-B). A bare ` +
            `Schema.Struct({}) is the known trap (see ListGenerationsInput's own comment ` +
            `for the Effect-idiomatic fix: Schema.StructWithRest(Struct({}), ` +
            `[Record(String, Never)])).`,
        ),
      );
    }
  }),
);

/** See `GenerationToolkitRegistrationLive` for why `generationServiceLive` is a parameter. */
export const layer = <R>(
  generationServiceLive: Layer.Layer<GenerationService.GenerationService, never, R>,
) => {
  const toolkitRegistrationsLive = Layer.mergeAll(
    PreviewToolkitRegistrationLive,
    PullRequestsToolkitRegistrationLive,
    DeviceToolkitRegistrationLive,
    GenerationToolkitRegistrationLive(generationServiceLive),
  );
  // `McpDiagStartupLive` is sequenced via `Layer.provide(toolkitRegistrationsLive)`
  // rather than merged in as a sibling: `Layer.mergeAll` builds its members
  // concurrently, so a sibling could race ahead of tool registration and check
  // a truncated list. `toolkitRegistrationsLive` is the same layer reference in
  // both places, so by-reference memoization builds it once.
  return Layer.mergeAll(
    toolkitRegistrationsLive,
    McpDiagStartupLive.pipe(Layer.provide(toolkitRegistrationsLive)),
  ).pipe(Layer.provideMerge(McpTransportLive));
};
