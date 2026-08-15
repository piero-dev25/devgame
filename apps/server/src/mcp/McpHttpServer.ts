import type { InspectGenerationInput } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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

import packageJson from "../../package.json" with { type: "json" };
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
  Effect.map(
    (registry): McpAuthMiddleware =>
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
  const result = new McpSchema.CallToolResult({
    isError: true,
    structuredContent: {
      error: {
        _tag: errorTag,
        operation: "snapshot",
        failureCount: failures.length,
      },
    },
    content: [{ type: "text", text: "Preview snapshot failed." }],
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
          Effect.matchCauseEffect({
            onFailure: previewSnapshotFailure,
            onSuccess: ({ encodedResult }) => {
              const snapshot = encodedResult as {
                readonly screenshot: {
                  readonly mimeType: "image/png";
                  readonly data: string;
                  readonly width: number;
                  readonly height: number;
                };
                readonly [key: string]: unknown;
              };
              const { screenshot, ...page } = snapshot;
              const metadata = {
                ...page,
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
                    {
                      type: "image",
                      data: new Uint8Array(Buffer.from(screenshot.data, "base64")),
                      mimeType: screenshot.mimeType,
                    },
                  ],
                }),
              );
            },
          }),
        );
      }),
  });
});

// Use `McpServer.registerToolkit` (leaves `McpServer` an OUTER requirement,
// discharged from the transport's served instance via `Layer.provideMerge(
// McpTransportLive)` below) — NOT `McpServer.toolkit`, which self-provides its
// OWN `McpServer.layer` (effect McpServer.ts:951: `toolkit = t =>
// effectDiscard(registerToolkit(t)).pipe(provide(McpServer.layer))`). With
// `toolkit`, the tools register into a throwaway McpServer instance that the
// HTTP transport never serves, so `/mcp` returns an EMPTY tools/list and NO
// harness tool (preview or generation) reaches any agent. Matches the manual
// `registerPreviewSnapshot`/`registerInspectGeneration` registrations, which
// already correctly require the outer McpServer.
const PreviewStandardToolkitRegistrationLive = Layer.effectDiscard(
  McpServer.registerToolkit(PreviewStandardToolkit),
).pipe(Layer.provide(PreviewStandardToolkitHandlersLive));

const PreviewSnapshotRegistrationLive = Layer.effectDiscard(registerPreviewSnapshot()).pipe(
  Layer.provide(PreviewSnapshotToolkitHandlersLive),
);

export const PreviewToolkitRegistrationLive = Layer.mergeAll(
  PreviewStandardToolkitRegistrationLive,
  PreviewSnapshotRegistrationLive,
);

// V2 Increment 1 — generation half (docs/v2/specs/increment-1-generation-service.md).
// `inspect_generation` is registered manually (this file's `registerPreviewSnapshot`
// idiom) because it hands back a preview image content block alongside
// structured JSON, same reason `preview_snapshot` is. The other three
// generation tools are declarative, same as the rest of the preview
// toolkit.
const inspectGenerationFailure = <E>(cause: Cause.Cause<E>) => {
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
      : "GenerationToolError";
  const result = new McpSchema.CallToolResult({
    isError: true,
    structuredContent: {
      error: {
        _tag: errorTag,
        operation: "inspect_generation",
        failureCount: failures.length,
      },
    },
    content: [{ type: "text", text: "inspect_generation failed." }],
  });
  return Effect.logWarning("inspect_generation failed", {
    operation: "inspect_generation",
    errorTag,
    failureCount: failures.length,
  }).pipe(Effect.as(result));
};

/** Merge-gate P1 #4: same cap as the GLB download (GenerationService.ts),
 * sized for a render, not a model — Tripo preview renders are small PNGs
 * in practice; 20MB is generous headroom, not a target. */
const MAX_PREVIEW_IMAGE_BYTES = 20 * 1_024 * 1_024;

class PreviewImageTooLargeError extends Schema.TaggedErrorClass<PreviewImageTooLargeError>()(
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
              onFailure: inspectGenerationFailure,
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

// registerToolkit (outer McpServer), NOT McpServer.toolkit (self-provides a
// throwaway instance) — see PreviewStandardToolkitRegistrationLive's comment.
const GenerationStandardToolkitRegistrationLive = Layer.effectDiscard(
  McpServer.registerToolkit(GenerationStandardToolkit),
).pipe(Layer.provide(GenerationStandardToolkitHandlersLive));

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

export const layer = <R>(
  generationServiceLive: Layer.Layer<GenerationService.GenerationService, never, R>,
) =>
  Layer.mergeAll(
    PreviewToolkitRegistrationLive,
    GenerationToolkitRegistrationLive(generationServiceLive),
  ).pipe(Layer.provideMerge(McpTransportLive));
