import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  GeneratedAssetId,
  GenerationJobId,
  PreviewTabId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type GeneratedAsset,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { McpProtocol, McpSchema, McpServer } from "effect/unstable/ai";
import {
  HttpBody,
  HttpClient,
  HttpClientResponse,
  HttpRouter,
  HttpServerResponse,
} from "effect/unstable/http";

import * as GenerationService from "../generation/GenerationService.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";

const environmentId = EnvironmentId.make("environment-mcp-test");
const threadId = ThreadId.make("thread-mcp-test");
const tabId = PreviewTabId.make("tab-mcp-test");
const alternateTabId = PreviewTabId.make("tab-mcp-alternate");
const invocation = {
  environmentId,
  threadId,
  providerSessionId: "provider-session-mcp-test",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});
const TestLayer = McpHttpServer.PreviewToolkitRegistrationLive.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(PreviewAutomationBroker.layer.pipe(Layer.provide(NodeServices.layer))),
);

it("normalizes empty successful notification responses to accepted", () => {
  const notificationResponse = McpHttpServer.normalizeMcpHttpResponse(
    HttpServerResponse.text("", { status: 200, contentType: "application/json" }),
  );
  expect(notificationResponse.status).toBe(202);

  const resultResponse = McpHttpServer.normalizeMcpHttpResponse(
    HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id: 1, result: {} }),
  );
  expect(resultResponse.status).toBe(200);
});

it.effect("returns bounded structural preview snapshot failures", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const events = yield* broker.connect({
        clientId: "mcp-failure-client",
        environmentId,
      });
      yield* Stream.runForEach(events, (event) =>
        event.type === "connected"
          ? Effect.void
          : broker.respond({
              clientId: "mcp-failure-client",
              connectionId: event.connectionId,
              requestId: event.request.requestId,
              ok: false,
              error: {
                _tag: "PreviewAutomationExecutionError",
                message: "sensitive renderer failure",
                detail: { consoleOutput: "sensitive browser output" },
              },
            }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const snapshot = yield* server
        .callTool({ name: "preview_snapshot", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

      expect(snapshot.isError).toBe(true);
      expect(snapshot.content).toEqual([{ type: "text", text: "Preview snapshot failed." }]);
      expect(snapshot.structuredContent).toEqual({
        error: {
          _tag: "PreviewAutomationExecutionError",
          operation: "snapshot",
          failureCount: 1,
        },
      });
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("terminates HTTP MCP sessions with DELETE", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const serverLayer = McpServer.layerHttp({
        name: "MCP termination test",
        version: "1.0.0",
        path: "/mcp",
        protocols: [McpProtocol.v2025_06_18],
      });
      yield* HttpRouter.serve(serverLayer, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);
      const httpClient = yield* HttpClient.HttpClient;

      const initializeResponse = yield* httpClient.post("/mcp", {
        headers: { accept: "application/json, text/event-stream" },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mcp-test","version":"1.0.0"}}}`,
          "application/json",
        ),
      });
      const sessionId = initializeResponse.headers["mcp-session-id"];
      expect(initializeResponse.status).toBe(200);
      expect(sessionId).not.toBeNull();

      const missingSessionResponse = yield* httpClient.del("/mcp");
      expect(missingSessionResponse.status).toBe(400);

      const unknownSessionResponse = yield* httpClient.del("/mcp", {
        headers: { "mcp-session-id": "unknown-session" },
      });
      expect(unknownSessionResponse.status).toBe(404);

      const terminateResponse = yield* httpClient.del("/mcp", {
        headers: { "mcp-session-id": sessionId! },
      });
      expect(terminateResponse.status).toBe(204);

      const reusedSessionResponse = yield* httpClient.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          "mcp-session-id": sessionId!,
        },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":2,"method":"ping","params":{}}`,
          "application/json",
        ),
      });
      expect(reusedSessionResponse.status).toBe(404);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("registers annotated tools and preserves authenticated request context", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const routedRequests: Array<{
        readonly operation: string;
        readonly tabId?: string | undefined;
      }> = [];
      const events = yield* broker.connect({
        clientId: "mcp-test-client",
        environmentId,
      });
      yield* Stream.runForEach(events, (event) => {
        if (event.type === "connected") return Effect.void;
        routedRequests.push(event.request);
        return broker.respond({
          clientId: "mcp-test-client",
          connectionId: event.connectionId,
          requestId: event.request.requestId,
          ok: true,
          result:
            event.request.operation === "snapshot"
              ? {
                  url: "http://example.test/",
                  title: "Example",
                  loading: false,
                  visibleText: "Example",
                  interactiveElements: [],
                  accessibilityTree: {},
                  consoleEntries: [],
                  networkEntries: [],
                  actionTimeline: [],
                  screenshot: {
                    mimeType: "image/png",
                    data: Buffer.from("png").toString("base64"),
                    width: 10,
                    height: 5,
                  },
                }
              : event.request.operation === "press"
                ? undefined
                : {
                    available: true,
                    visible: true,
                    tabId,
                    url: "http://example.test/",
                    title: "Example",
                    loading: false,
                  },
        });
      }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const statusTool = server.tools.find(({ tool }) => tool.name === "preview_status");
      expect(statusTool?.tool.annotations?.readOnlyHint).toBe(true);
      expect(statusTool?.tool.annotations?.idempotentHint).toBe(true);
      expect(statusTool?.tool.annotations?.destructiveHint).toBe(false);

      const snapshotTool = server.tools.find(({ tool }) => tool.name === "preview_snapshot");
      expect(snapshotTool?.tool.annotations?.readOnlyHint).toBe(true);
      expect(snapshotTool?.tool.annotations?.idempotentHint).toBe(true);
      expect(snapshotTool?.tool.annotations?.openWorldHint).toBe(true);

      const clickTool = server.tools.find(({ tool }) => tool.name === "preview_click");
      expect(clickTool?.tool.annotations?.readOnlyHint).toBe(false);
      expect(clickTool?.tool.annotations?.destructiveHint).toBe(true);
      expect(clickTool?.tool.annotations?.openWorldHint).toBe(true);

      const navigateTool = server.tools.find(({ tool }) => tool.name === "preview_navigate");
      expect(navigateTool?.tool.annotations?.destructiveHint).toBe(false);
      expect(navigateTool?.tool.annotations?.openWorldHint).toBe(true);

      const status = yield* server
        .callTool({ name: "preview_status", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(status.isError).toBe(false);
      expect(status.structuredContent).toMatchObject({
        available: true,
        tabId,
      });

      const malformed = yield* server
        .callTool({ name: "preview_click", arguments: { selector: "" } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
          Effect.flip,
        );
      expect(malformed._tag).toBe("InvalidParams");

      const snapshot = yield* server
        .callTool({ name: "preview_snapshot", arguments: { tabId: alternateTabId } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(snapshot.isError).toBe(false);
      expect(snapshot.content.some((content) => content.type === "image")).toBe(true);
      expect(snapshot.structuredContent).toMatchObject({
        screenshot: { mimeType: "image/png", width: 10, height: 5 },
      });
      expect(routedRequests.find(({ operation }) => operation === "snapshot")?.tabId).toBe(
        alternateTabId,
      );

      const press = yield* server
        .callTool({ name: "preview_press", arguments: { key: "Enter" } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(press.isError).toBe(false);
      expect(press.structuredContent).toBeNull();
      expect(press.content).toEqual([{ type: "text", text: "null" }]);
    }),
  ).pipe(Effect.provide(TestLayer)),
);

// Merge-gate P3 #8: `registerInspectGeneration`'s own transport-layer
// logic (image-block assembly, degrade-on-failure) has no direct coverage
// — `inspectGeneration` (the exported handler) is unit-tested in
// handlers.test.ts, but that never exercises the manual `server.addTool`
// registration this file owns, which is what actually runs in the LIVE
// acceptance. Wired against a FAKE GenerationService (not a real Tripo job
// lifecycle — that's GenerationService.test.ts's job) so this stays a
// focused test of the registration's own assembly logic.
const generationProjectId = ProjectId.make("project-mcp-inspect-test");
const generationThreadId = ThreadId.make("thread-mcp-inspect-test");
const generationInvocation = {
  ...invocation,
  threadId: generationThreadId,
  capabilities: new Set(["preview", "generation"] as const),
};
const succeededAssetId = GeneratedAssetId.make("asset-mcp-inspect-test");
const succeededAsset: GeneratedAsset = {
  id: succeededAssetId,
  projectId: generationProjectId,
  generationJobId: GenerationJobId.make("gen-mcp-inspect-test"),
  modality: "model3d",
  provider: "tripo",
  files: { glb: "/state/generated/project-mcp-inspect-test/asset-mcp-inspect-test/model.glb" },
  preview: { imageUrl: "https://tripo.example/render.png" },
  metadata: { triangles: 100, materials: 1, images: 1, fileBytes: 1234 },
  createdAt: 1,
};

const fakeGenerationService: GenerationService.GenerationServiceShape = {
  createJob: () => Effect.die("unexpected createJob call"),
  getJob: () => Effect.die("unexpected getJob call"),
  listJobs: () => Effect.die("unexpected listJobs call"),
  getAsset: (id) =>
    Effect.succeed(id === succeededAssetId ? Option.some(succeededAsset) : Option.none()),
  getAssetByJobId: () => Effect.die("unexpected getAssetByJobId call"),
};

const fakeProjectionSnapshotQuery: ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"] = {
  getCommandReadModel: () => Effect.die("unexpected getCommandReadModel call"),
  getSnapshot: () => Effect.die("unexpected getSnapshot call"),
  getShellSnapshot: () => Effect.die("unexpected getShellSnapshot call"),
  getArchivedShellSnapshot: () => Effect.die("unexpected getArchivedShellSnapshot call"),
  searchThreads: () => Effect.die("unexpected searchThreads call"),
  getSnapshotSequence: () => Effect.die("unexpected getSnapshotSequence call"),
  getCounts: () => Effect.die("unexpected getCounts call"),
  getActiveProjectByWorkspaceRoot: () =>
    Effect.die("unexpected getActiveProjectByWorkspaceRoot call"),
  getProjectShellById: () => Effect.die("unexpected getProjectShellById call"),
  getFirstActiveThreadIdByProjectId: () =>
    Effect.die("unexpected getFirstActiveThreadIdByProjectId call"),
  getActiveSpacesForProject: () => Effect.die("unexpected getActiveSpacesForProject call"),
  getSpaceProjectId: () => Effect.die("unexpected getSpaceProjectId call"),
  getThreadCheckpointContext: () => Effect.die("unexpected getThreadCheckpointContext call"),
  getFullThreadDiffContext: () => Effect.die("unexpected getFullThreadDiffContext call"),
  getThreadShellById: (threadId) =>
    Effect.succeed(
      threadId === generationThreadId
        ? Option.some({ id: threadId, projectId: generationProjectId } as never)
        : Option.none(),
    ),
  getThreadDetailById: () => Effect.die("unexpected getThreadDetailById call"),
  getThreadDetailSnapshot: () => Effect.die("unexpected getThreadDetailSnapshot call"),
};

const makeGenerationInspectTestLayer = (imageHandler: Parameters<typeof HttpClient.make>[0]) =>
  McpHttpServer.GenerationInspectRegistrationLive.pipe(
    Layer.provide(Layer.succeed(GenerationService.GenerationService, fakeGenerationService)),
    Layer.provide(
      Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, fakeProjectionSnapshotQuery),
    ),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, HttpClient.make(imageHandler))),
    Layer.provideMerge(McpServer.McpServer.layer),
  );

it.effect(
  "assembles an image content block alongside structured content when the preview image fetches cleanly",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        const result = yield* server
          .callTool({ name: "inspect_generation", arguments: { assetId: succeededAssetId } })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, generationInvocation),
            Effect.provideService(McpSchema.McpServerClient, client),
          );

        expect(result.isError).toBe(false);
        expect(result.structuredContent).toMatchObject({
          id: succeededAssetId,
          // absolute stateDir path never crosses the wire — merge-gate P2 #6+9
          files: { glb: "generated/project-mcp-inspect-test/asset-mcp-inspect-test/model.glb" },
        });
        const imageBlock = result.content.find((c) => c.type === "image");
        expect(imageBlock).toMatchObject({ type: "image", mimeType: "image/webp" });
      }),
    ).pipe(
      Effect.provide(
        makeGenerationInspectTestLayer((request) =>
          Effect.sync(() =>
            HttpClientResponse.fromWeb(
              request,
              new Response(new Uint8Array([1, 2, 3, 4]), {
                status: 200,
                headers: { "content-type": "image/webp" },
              }),
            ),
          ),
        ),
      ),
    ),
);

it.effect(
  "degrades to structured-content-only (no image block, isError:false) when the preview image fetch fails",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        const result = yield* server
          .callTool({ name: "inspect_generation", arguments: { assetId: succeededAssetId } })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, generationInvocation),
            Effect.provideService(McpSchema.McpServerClient, client),
          );

        expect(result.isError).toBe(false);
        expect(result.content.some((c) => c.type === "image")).toBe(false);
        expect(result.structuredContent).toMatchObject({ id: succeededAssetId });
      }),
    ).pipe(
      Effect.provide(
        makeGenerationInspectTestLayer((request) =>
          Effect.sync(() =>
            HttpClientResponse.fromWeb(request, new Response("gone", { status: 500 })),
          ),
        ),
      ),
    ),
);
