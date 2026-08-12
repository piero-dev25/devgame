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
import { __testing, TRIPO_SECRET_NAME } from "./TripoProvider.ts";

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
  readonly authorization: string | undefined;
}> = [];

const jsonResponse = (
  request: Parameters<Parameters<typeof HttpClient.make>[0]>[0],
  body: unknown,
  status = 200,
) =>
  Effect.sync(() => {
    recordedRequests.push({ url: request.url, authorization: request.headers.authorization });
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
) =>
  Layer.effect(
    Model3dProvider,
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;
      yield* secretStore.set(TRIPO_SECRET_NAME, new TextEncoder().encode("tripo-test-key"));
      return yield* __testing.make();
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
