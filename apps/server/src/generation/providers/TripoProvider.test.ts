import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { describe } from "vite-plus/test";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import { Model3dProvider, Model3dProviderError } from "./Model3dProvider.ts";
import { __testing, TRIPO_SECRET_NAME, type TripoProviderOptions } from "./TripoProvider.ts";

const encodeJsonBody = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const makeServerConfigLayer = () =>
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-tripo-provider-test-" });

const makeSecretStoreLayer = () =>
  ServerSecretStore.layer.pipe(
    Layer.provide(makeServerConfigLayer()),
    Layer.provide(NodeServices.layer),
  );

/** A throwaway path this machine will never have a real file at — the ONLY
 * safe way to exercise the "no secret yet" branch without risking a read of
 * the owner's real `~/.config/devgame/tripo-api-key` (OWNER_DOCKET.md D3
 * confirms one is configured on this machine). */
const missingDevKeyPath = "/nonexistent/t3-tripo-provider-test/tripo-api-key";

const recordedRequests: Array<{
  readonly url: string;
  readonly method: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
}> = [];

const jsonResponse = (
  request: Parameters<Parameters<typeof HttpClient.make>[0]>[0],
  body: unknown,
  status = 200,
) =>
  Effect.sync(() => {
    const rawBody = (request.body as { readonly body?: Uint8Array }).body;
    recordedRequests.push({
      url: request.url,
      method: request.method,
      authorization: request.headers.authorization,
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      body: rawBody === undefined ? undefined : JSON.parse(new TextDecoder().decode(rawBody)),
    });
    return HttpClientResponse.fromWeb(
      request,
      new Response(encodeJsonBody(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  });

const makeTripoLayerWithSeededKey = (
  handle: (
    request: Parameters<Parameters<typeof HttpClient.make>[0]>[0],
  ) => ReturnType<typeof jsonResponse>,
  // Fix round finding #1: forwarded to `__testing.make` so the timeout test
  // below can override `derivePollIntervalMs`/`deriveDeadlineMs` to tiny
  // values, exercising `deriveFbx`'s bounded poll loop in bounded real
  // time under `it.live`.
  options: Pick<TripoProviderOptions, "derivePollIntervalMs" | "deriveDeadlineMs"> = {},
) =>
  Layer.effect(
    Model3dProvider,
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;
      yield* secretStore.set(TRIPO_SECRET_NAME, new TextEncoder().encode("tripo-test-key"));
      return yield* __testing.make(options);
    }),
  ).pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, HttpClient.make(handle))),
    Layer.provide(makeSecretStoreLayer()),
    Layer.provide(NodeServices.layer),
  );

describe("TripoProvider", () => {
  it.effect("submits a text_to_model task with the bearer token and returns its task id", () => {
    recordedRequests.length = 0;
    const layer = makeTripoLayerWithSeededKey((request) =>
      jsonResponse(request, { code: 0, data: { task_id: "task-123" } }),
    );
    return Effect.gen(function* () {
      const provider = yield* Model3dProvider;
      const result = yield* provider.submitTextTo3d({ prompt: "a stylized wooden barrel" });
      expect(result).toEqual({ providerTaskId: "task-123" });
      expect(recordedRequests[0]?.url).toBe("https://api.tripo3d.ai/v2/openapi/task");
      expect(recordedRequests[0]?.authorization).toBe("Bearer tripo-test-key");
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "maps a running poll response to progress, and a success response to modelUrl/renderedImageUrl",
    () => {
      const layer = makeTripoLayerWithSeededKey((request) =>
        jsonResponse(request, {
          code: 0,
          data: {
            status: "success",
            progress: 100,
            output: {
              pbr_model: "https://tripo.example/model.glb",
              rendered_image: "https://tripo.example/render.png",
            },
          },
        }),
      );
      return Effect.gen(function* () {
        const provider = yield* Model3dProvider;
        const state = yield* provider.pollTask("task-123");
        expect(state).toEqual({
          status: "success",
          progress: 100,
          modelUrl: "https://tripo.example/model.glb",
          renderedImageUrl: "https://tripo.example/render.png",
        });
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "maps a running (non-terminal) poll response to status running with its progress",
    () => {
      const layer = makeTripoLayerWithSeededKey((request) =>
        jsonResponse(request, { code: 0, data: { status: "running", progress: 42 } }),
      );
      return Effect.gen(function* () {
        const provider = yield* Model3dProvider;
        const state = yield* provider.pollTask("task-123");
        expect(state).toEqual({ status: "running", progress: 42 });
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("maps a failed poll response to status failed", () => {
    const layer = makeTripoLayerWithSeededKey((request) =>
      jsonResponse(request, { code: 0, data: { status: "failed", progress: 0 } }),
    );
    return Effect.gen(function* () {
      const provider = yield* Model3dProvider;
      const state = yield* provider.pollTask("task-123");
      assert.deepEqual(state, { status: "failed", detail: "Tripo task failed" });
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "submits convert_model, polls through running to success, and returns the FBX URL",
    () => {
      recordedRequests.length = 0;
      let pollCount = 0;
      const layer = makeTripoLayerWithSeededKey((request) => {
        if (request.method === "POST") {
          return jsonResponse(request, { code: 0, data: { task_id: "convert-task-456" } });
        }
        pollCount += 1;
        return pollCount === 1
          ? jsonResponse(request, {
              code: 0,
              data: { status: "running", progress: 60 },
            })
          : jsonResponse(request, {
              code: 0,
              data: {
                status: "success",
                progress: 100,
                output: { model: "https://tripo.example/barrel.fbx" },
              },
            });
      });

      return Effect.gen(function* () {
        const provider = yield* Model3dProvider;
        const result = yield* provider.deriveFbx("original-task-123");

        expect(result).toEqual({ fbxUrl: "https://tripo.example/barrel.fbx" });
        expect(recordedRequests).toEqual([
          {
            url: "https://api.tripo3d.ai/v2/openapi/task",
            method: "POST",
            authorization: "Bearer tripo-test-key",
            body: {
              type: "convert_model",
              original_model_task_id: "original-task-123",
              format: "FBX",
            },
          },
          {
            url: "https://api.tripo3d.ai/v2/openapi/task/convert-task-456",
            method: "GET",
            authorization: "Bearer tripo-test-key",
            body: undefined,
          },
          {
            url: "https://api.tripo3d.ai/v2/openapi/task/convert-task-456",
            method: "GET",
            authorization: "Bearer tripo-test-key",
            body: undefined,
          },
        ]);
      }).pipe(Effect.provide(layer));
    },
  );

  // Fix round finding #1: without a bound, a convert_model task stuck
  // "running" polls — and holds the calling fiber — forever, hanging
  // import_generated_asset's whole MCP request Effect (deriveFbx runs
  // synchronously there, unlike GenerationService.ts's backgrounded poll
  // loop). `pollTask` here ALWAYS reports "running", never a terminal
  // status, so the ONLY way this test can pass is via the timeout path.
  it.live(
    "deriveFbx fails (does not hang) when convert_model never reaches a terminal status",
    () => {
      recordedRequests.length = 0;
      const layer = makeTripoLayerWithSeededKey(
        (request) => {
          if (request.method === "POST") {
            return jsonResponse(request, { code: 0, data: { task_id: "convert-task-stuck" } });
          }
          return jsonResponse(request, { code: 0, data: { status: "running", progress: 10 } });
        },
        { derivePollIntervalMs: 5, deriveDeadlineMs: 30 },
      );

      return Effect.gen(function* () {
        const provider = yield* Model3dProvider;
        const error = yield* provider.deriveFbx("original-task-stuck").pipe(Effect.flip);
        expect(error).toBeInstanceOf(Model3dProviderError);
        expect(error.detail).toContain("timed out after 30ms");
      }).pipe(Effect.provide(layer));
    },
  );

  // Merge-gate P0: the key used to be resolved EAGERLY in the layer's own
  // build effect, so a missing/misconfigured Tripo key failed the WHOLE
  // MCP server layer at boot — taking preview_* down too, for a user who
  // never touched generation. The fix (`Effect.cached`, this file's own
  // comment) defers the read to the first actual provider call. This test
  // asserts BOTH halves of that fix, not just the failure: the layer must
  // build cleanly with no secret and no dev key file present, and only a
  // subsequent submitTextTo3d call may fail.
  describe("credential resolution is lazy (merge-gate P0)", () => {
    const makeUnconfiguredLayer = () =>
      Layer.effect(Model3dProvider, __testing.make({ devKeyPath: missingDevKeyPath })).pipe(
        Layer.provide(
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("unreachable — no HTTP call should happen")),
          ),
        ),
        Layer.provide(makeSecretStoreLayer()),
        Layer.provide(NodeServices.layer),
      );

    it.effect("builds the provider layer successfully with no secret and no dev key file", () =>
      Effect.gen(function* () {
        // Merely acquiring the service is layer construction — if the key
        // were still resolved eagerly, THIS would throw, not the call
        // below.
        const provider = yield* Model3dProvider;
        expect(provider).toBeDefined();
      }).pipe(Effect.provide(makeUnconfiguredLayer())),
    );

    it.effect(
      "fails a submitTextTo3d call (not layer construction) with Model3dProviderError when unconfigured",
      () =>
        Effect.gen(function* () {
          const provider = yield* Model3dProvider;
          const error = yield* Effect.flip(provider.submitTextTo3d({ prompt: "a barrel" }));
          expect(error).toBeInstanceOf(Model3dProviderError);
        }).pipe(Effect.provide(makeUnconfiguredLayer())),
    );

    it.effect(
      "caches the failure across calls — a second call does not re-read the filesystem",
      () =>
        Effect.gen(function* () {
          const provider = yield* Model3dProvider;
          const first = yield* Effect.flip(provider.pollTask("task-1"));
          const second = yield* Effect.flip(provider.pollTask("task-1"));
          expect(first).toBeInstanceOf(Model3dProviderError);
          expect(second).toBeInstanceOf(Model3dProviderError);
        }).pipe(Effect.provide(makeUnconfiguredLayer())),
    );
  });
});
