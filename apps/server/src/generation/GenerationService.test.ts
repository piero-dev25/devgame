// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { describe } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import {
  GenerationService,
  layer as generationServiceLayer,
  type GenerationServiceShape,
} from "./GenerationService.ts";
import {
  Model3dProvider,
  type Model3dProviderShape,
  type Model3dTaskState,
} from "./providers/Model3dProvider.ts";

const fixturePath = NodeURL.fileURLToPath(
  new URL("./__fixtures__/barrel-5996tris.glb", import.meta.url),
);
const fixtureBytes = new Uint8Array(NodeFS.readFileSync(fixturePath));

const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");

/** A queue-driven fake `Model3dProvider` — each `pollTask` call pops the
 * next scripted state, holding on the last entry once exhausted. */
const makeFakeProvider = (pollSequence: ReadonlyArray<Model3dTaskState>): Model3dProviderShape => {
  let index = 0;
  return {
    submitTextTo3d: () => Effect.succeed({ providerTaskId: "provider-task-1" }),
    pollTask: () =>
      Effect.sync(() => {
        const state = pollSequence[Math.min(index, pollSequence.length - 1)]!;
        index += 1;
        return state;
      }),
    deriveFbx: () => Effect.die("deriveFbx is not exercised by this increment's tests"),
  };
};

const makeTestLayer = (provider: Model3dProviderShape) =>
  generationServiceLayer({ pollIntervalMs: 15 }).pipe(
    Layer.provide(Layer.succeed(Model3dProvider, provider)),
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() =>
            HttpClientResponse.fromWeb(
              request,
              new Response(fixtureBytes, {
                status: 200,
                headers: { "content-type": "model/gltf-binary" },
              }),
            ),
          ),
        ),
      ),
    ),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-generation-service-test-" })),
    Layer.provide(NodeServices.layer),
  );

const waitForTerminal = (
  service: GenerationServiceShape,
  jobId: Parameters<GenerationServiceShape["getJob"]>[0],
) =>
  Effect.gen(function* () {
    while (true) {
      const job = yield* service.getJob(jobId);
      if (
        Option.isSome(job) &&
        (job.value.status === "succeeded" || job.value.status === "failed")
      ) {
        return job.value;
      }
      yield* Effect.sleep(Duration.millis(3));
    }
  }).pipe(Effect.timeout(Duration.seconds(10)));

describe("GenerationService", () => {
  const succeedingProvider = makeFakeProvider([
    { status: "queued", progress: 0 },
    { status: "running", progress: 25 },
    { status: "running", progress: 60 },
    {
      status: "success",
      progress: 100,
      modelUrl: "https://tripo.example/model.glb",
      renderedImageUrl: "https://tripo.example/render.png",
    },
  ]);

  it.live(
    "drives a job created → running → succeeded with monotonic progress and asset recorded",
    () =>
      Effect.gen(function* () {
        const service = yield* GenerationService;

        const job = yield* service.createJob({
          projectId,
          threadId,
          prompt: "a stylized wooden barrel",
          parameters: { faceLimit: 6000 },
        });
        // Asserts the EFFECT, not a precondition: a job that started life
        // already "succeeded" (a stub returning canned data) would pass a
        // weaker assertion here.
        expect(job.status).toBe("created");
        expect(job.progress).toBe(0);
        expect(job.assetId).toBeNull();

        const samples: Array<number> = [];
        const sampler = yield* Effect.gen(function* () {
          while (true) {
            const current = yield* service.getJob(job.id);
            if (Option.isSome(current)) samples.push(current.value.progress);
            yield* Effect.sleep(Duration.millis(4));
          }
        }).pipe(Effect.forkChild);

        const finalJob = yield* waitForTerminal(service, job.id);
        yield* Fiber.interrupt(sampler);

        expect(finalJob.status).toBe("succeeded");
        expect(finalJob.error).toBeNull();
        expect(finalJob.assetId).not.toBeNull();
        expect(finalJob.startedAt).not.toBeNull();
        expect(finalJob.completedAt).not.toBeNull();

        for (let i = 1; i < samples.length; i++) {
          expect(samples[i]).toBeGreaterThanOrEqual(samples[i - 1]!);
        }

        const asset = yield* service.getAsset(finalJob.assetId!);
        expect(Option.isSome(asset)).toBe(true);
        if (Option.isSome(asset)) {
          expect(asset.value.metadata).toEqual({
            triangles: 5996,
            materials: 1,
            images: 3,
            fileBytes: fixtureBytes.length,
          });
          expect(asset.value.preview.imageUrl).toBe("https://tripo.example/render.png");
          expect(asset.value.files.glb).toContain(job.projectId);
        }

        const byJobId = yield* service.getAssetByJobId(job.id);
        expect(Option.isSome(byJobId)).toBe(true);

        const jobs = yield* service.listJobs(projectId);
        expect(jobs.map((j) => j.id)).toEqual([job.id]);
      }).pipe(Effect.provide(makeTestLayer(succeedingProvider))),
  );

  it.live("drives a job created → running → failed, leaving assetId null", () =>
    Effect.gen(function* () {
      const service = yield* GenerationService;

      const job = yield* service.createJob({
        projectId,
        threadId,
        prompt: "a barrel that will fail",
        parameters: {},
      });

      const finalJob = yield* waitForTerminal(service, job.id);

      expect(finalJob.status).toBe("failed");
      expect(finalJob.error).toBe("provider exploded");
      expect(finalJob.assetId).toBeNull();

      const asset = yield* service.getAssetByJobId(job.id);
      expect(Option.isNone(asset)).toBe(true);
    }).pipe(
      Effect.provide(
        makeTestLayer(makeFakeProvider([{ status: "failed", detail: "provider exploded" }])),
      ),
    ),
  );

  it.live("getJob returns None for an unknown job id", () =>
    Effect.gen(function* () {
      const service = yield* GenerationService;
      const result = yield* service.getJob("gen_does-not-exist" as never);
      expect(Option.isNone(result)).toBe(true);
    }).pipe(Effect.provide(makeTestLayer(makeFakeProvider([])))),
  );
});
