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

  it.effect(
    "fails with Model3dProviderError when no secret exists and the dev key file is absent",
    () => {
      const layer = Layer.effect(
        Model3dProvider,
        __testing.make({ devKeyPath: missingDevKeyPath }),
      ).pipe(
        Layer.provide(
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("unreachable")),
          ),
        ),
        Layer.provide(makeSecretStoreLayer()),
        Layer.provide(NodeServices.layer),
      );
      return Effect.gen(function* () {
        const error = yield* Effect.flip(Effect.provide(Model3dProvider, layer));
        expect(error).toBeInstanceOf(Model3dProviderError);
      });
    },
  );
});
