// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
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

const defaultGlbHandler: Parameters<typeof HttpClient.make>[0] = (request) =>
  Effect.sync(() =>
    HttpClientResponse.fromWeb(
      request,
      new Response(fixtureBytes, {
        status: 200,
        headers: { "content-type": "model/gltf-binary" },
      }),
    ),
  );

const makeTestLayerWithOptions = (
  provider: Model3dProviderShape,
  options: {
    readonly pollIntervalMs?: number;
    readonly pollDeadlineMs?: number;
    readonly maxConcurrentGenerations?: number;
    readonly maxGlbBytes?: number;
  } = {},
  glbHandler: Parameters<typeof HttpClient.make>[0] = defaultGlbHandler,
) =>
  generationServiceLayer({ pollIntervalMs: 15, ...options }).pipe(
    Layer.provide(Layer.succeed(Model3dProvider, provider)),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, HttpClient.make(glbHandler))),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-generation-service-test-" })),
    Layer.provide(NodeServices.layer),
  );

const makeTestLayer = (provider: Model3dProviderShape) => makeTestLayerWithOptions(provider);

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

  // Merge-gate P1 #3a: a provider stuck "running" forever must not poll
  // forever — red-proof: before this fix, waitForTerminal's own 10s
  // Effect.timeout would have been the only thing to ever end this test,
  // and the job itself would still show status:"running" indefinitely.
  it.live(
    "hits the poll deadline and ends failed (not stuck) when the provider never terminates",
    () =>
      Effect.gen(function* () {
        const service = yield* GenerationService;

        const job = yield* service.createJob({
          projectId,
          threadId,
          prompt: "a barrel stuck forever",
          parameters: {},
        });
        const finalJob = yield* waitForTerminal(service, job.id);

        expect(finalJob.status).toBe("failed");
        expect(finalJob.error).toContain("timed out");
        expect(finalJob.assetId).toBeNull();
      }).pipe(
        Effect.provide(
          makeTestLayerWithOptions(makeFakeProvider([{ status: "running", progress: 1 }]), {
            pollIntervalMs: 5,
            pollDeadlineMs: 25,
          }),
        ),
      ),
  );

  // Merge-gate P1 #3c (folded finding #7): a DEFECT (not a typed E-channel
  // failure) inside the forked fiber must still record the job as failed.
  // Before Effect.catchCause replaced Effect.catch, this class of failure
  // fell straight through uncaught, leaving the job "running" with
  // error:null forever.
  it.live(
    "records the job as failed when the provider call dies (a defect, not a typed failure)",
    () =>
      Effect.gen(function* () {
        const service = yield* GenerationService;

        const job = yield* service.createJob({
          projectId,
          threadId,
          prompt: "a barrel whose provider call dies",
          parameters: {},
        });
        const finalJob = yield* waitForTerminal(service, job.id);

        expect(finalJob.status).toBe("failed");
        expect(finalJob.error).not.toBeNull();
        expect(finalJob.assetId).toBeNull();
      }).pipe(
        Effect.provide(
          makeTestLayer({
            submitTextTo3d: () =>
              Effect.die(new Error("unexpected defect from the provider client")),
            pollTask: () => Effect.die("unreachable — submitTextTo3d dies first"),
            deriveFbx: () => Effect.die("unreachable"),
          }),
        ),
      ),
  );

  // Merge-gate P2 #5: the Effect.catchCause error-recording branch itself
  // — a genuine E-channel failure (not a scripted "failed" poll state) —
  // was untested; the pre-existing failing-job test only ever drove the
  // finalState.status==="failed" branch, never this one.
  it.live(
    "records job.error from a genuine E-channel failure (submitTextTo3d fails, not a scripted failed state)",
    () =>
      Effect.gen(function* () {
        const service = yield* GenerationService;

        const job = yield* service.createJob({
          projectId,
          threadId,
          prompt: "a barrel whose submit is rejected",
          parameters: {},
        });
        const finalJob = yield* waitForTerminal(service, job.id);

        expect(finalJob.status).toBe("failed");
        expect(finalJob.error).toContain("quota exceeded");
        expect(finalJob.assetId).toBeNull();
      }).pipe(
        Effect.provide(
          makeTestLayer({
            submitTextTo3d: () =>
              Effect.fail(new Error("submit rejected: quota exceeded") as never),
            pollTask: () => Effect.die("unreachable — submitTextTo3d fails first"),
            deriveFbx: () => Effect.die("unreachable"),
          }),
        ),
      ),
  );

  // Merge-gate P1 #4: a declared content-length above the cap must reject
  // BEFORE the (real, ~700KB) fixture body is even read — proven by
  // setting the cap absurdly low (10 bytes) against the real fixture
  // response, rather than allocating a 100MB+ buffer just to trip the
  // default.
  it.live("fails the job when the GLB response declares a size over the cap", () =>
    Effect.gen(function* () {
      const service = yield* GenerationService;
      const job = yield* service.createJob({
        projectId,
        threadId,
        prompt: "a barrel too large to buffer",
        parameters: {},
      });
      const finalJob = yield* waitForTerminal(service, job.id);

      expect(finalJob.status).toBe("failed");
      expect(finalJob.error).toContain("exceeding");
      expect(finalJob.assetId).toBeNull();
    }).pipe(Effect.provide(makeTestLayerWithOptions(succeedingProvider, { maxGlbBytes: 10 }))),
  );

  // Merge-gate P2 #6+9 (the #76 "scrub at the funnel" pattern): a failed
  // FileSystem operation's error message embeds the absolute path it
  // operated on. job.error is client-facing (generation_status returns it
  // verbatim) — it must never carry that absolute path.
  it.live("scrubs the absolute stateDir path out of job.error on a filesystem failure", () =>
    Effect.gen(function* () {
      const service = yield* GenerationService;
      const job = yield* service.createJob({
        projectId,
        threadId,
        prompt: "a barrel whose directory write fails",
        parameters: {},
      });
      const finalJob = yield* waitForTerminal(service, job.id);

      expect(finalJob.status).toBe("failed");
      expect(finalJob.error).not.toBeNull();
      // The real absolute path never appears — only the redaction placeholder.
      expect(finalJob.error).not.toMatch(/\/Users\/|^\/(?!<redacted>)/);
      expect(finalJob.error).toContain("<redacted>");
    }).pipe(
      Effect.provide(
        (() => {
          const failingFileSystemLayer = Layer.effect(
            FileSystem.FileSystem,
            Effect.gen(function* () {
              const fs = yield* FileSystem.FileSystem;
              return {
                ...fs,
                // Only the job's OWN generated-asset directory fails — a
                // blanket override would also fail ServerConfig.layerTest's
                // own stateDir setup (a real makeDirectory call made during
                // LAYER CONSTRUCTION, before any job exists), which would
                // surface as a raw layer-build failure instead of routing
                // through the job's own error-scrubbing path this test
                // means to exercise.
                makeDirectory: (path, options) =>
                  path.includes("generated")
                    ? Effect.fail(
                        PlatformError.systemError({
                          _tag: "PermissionDenied",
                          module: "FileSystem",
                          method: "makeDirectory",
                          pathOrDescriptor: path,
                          description: `Permission denied creating ${path}`,
                        }),
                      )
                    : fs.makeDirectory(path, options),
              } satisfies FileSystem.FileSystem;
            }),
          ).pipe(Layer.provide(NodeServices.layer));
          return generationServiceLayer({ pollIntervalMs: 15 }).pipe(
            Layer.provide(Layer.succeed(Model3dProvider, succeedingProvider)),
            Layer.provide(Layer.succeed(HttpClient.HttpClient, HttpClient.make(defaultGlbHandler))),
            Layer.provide(
              ServerConfig.layerTest(process.cwd(), { prefix: "t3-generation-service-test-" }),
            ),
            Layer.provide(failingFileSystemLayer),
            Layer.provide(NodeServices.layer),
          );
        })(),
      ),
    ),
  );

  // Merge-gate P1 #3b: createJob forks unbounded fibers against a PAID API
  // without a cap. Proven by tracking peak concurrent submitTextTo3d calls
  // against a small cap and a provider that holds each "in flight" until
  // released — if the cap were not enforced, all jobs would submit at once.
  it.live("caps concurrent generations — extra jobs queue instead of running unbounded", () => {
    const cap = 2;
    const jobCount = 5;
    let concurrent = 0;
    let peakConcurrent = 0;
    const throttledProvider: Model3dProviderShape = {
      submitTextTo3d: () =>
        Effect.gen(function* () {
          concurrent += 1;
          peakConcurrent = Math.max(peakConcurrent, concurrent);
          yield* Effect.sleep(Duration.millis(20));
          concurrent -= 1;
          return { providerTaskId: "provider-task-1" };
        }),
      pollTask: () =>
        Effect.succeed({
          status: "success" as const,
          progress: 100,
          modelUrl: "https://tripo.example/model.glb",
          renderedImageUrl: null,
        }),
      deriveFbx: () => Effect.die("unreachable"),
    };

    return Effect.gen(function* () {
      const service = yield* GenerationService;

      const jobs = yield* Effect.all(
        Array.from({ length: jobCount }, () =>
          service.createJob({ projectId, threadId, prompt: "a barrel", parameters: {} }),
        ),
      );
      yield* Effect.forEach(jobs, (job) => waitForTerminal(service, job.id), {
        concurrency: "unbounded",
      });

      expect(peakConcurrent).toBeLessThanOrEqual(cap);
    }).pipe(
      Effect.provide(
        makeTestLayerWithOptions(throttledProvider, { maxConcurrentGenerations: cap }),
      ),
    );
  });
});
