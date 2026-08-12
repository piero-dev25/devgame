/**
 * GenerationService — in-memory, project-keyed job registry + the provider
 * poll loop. Shaped like `SpaceEventsRegistry`/`EditorPresenceRegistry`
 * (seams note §1.3: the fork's own additions all decline persistence for
 * observed/derived/ephemeral state) — NO event-sourcing, NO new aggregate,
 * NO migration, all deferred to Increment 2 per the frozen spec
 * (docs/v2/specs/increment-1-generation-service.md).
 *
 * Owns:
 *  - the job lifecycle: created → running → succeeded | failed
 *  - the provider poll loop (the SERVER polls, never the agent — spec's
 *    "Async model" section; a job survives the MCP request/turn ending)
 *  - GeneratedAsset records for the current server session, including the
 *    GLB download + server-side glTF inspection (no Unity — spike 0)
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import {
  GeneratedAssetId as GeneratedAssetIdSchema,
  GenerationJobId as GenerationJobIdSchema,
} from "@t3tools/contracts";
import type {
  GeneratedAsset,
  GeneratedAssetId,
  GenerationJob,
  GenerationJobId,
  GenerationParameters,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import { inspectGlb } from "./glbInspect.ts";
import { Model3dProvider } from "./providers/Model3dProvider.ts";

export interface GenerationCreateJobInput {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly prompt: string;
  readonly parameters: GenerationParameters;
}

export interface GenerationServiceShape {
  readonly createJob: (input: GenerationCreateJobInput) => Effect.Effect<GenerationJob>;
  readonly getJob: (jobId: GenerationJobId) => Effect.Effect<Option.Option<GenerationJob>>;
  /** Newest first, per the frozen spec's `list_generations` contract. */
  readonly listJobs: (projectId: ProjectId) => Effect.Effect<ReadonlyArray<GenerationJob>>;
  readonly getAsset: (assetId: GeneratedAssetId) => Effect.Effect<Option.Option<GeneratedAsset>>;
  readonly getAssetByJobId: (
    jobId: GenerationJobId,
  ) => Effect.Effect<Option.Option<GeneratedAsset>>;
}

export class GenerationService extends Context.Service<GenerationService, GenerationServiceShape>()(
  "t3/generation/GenerationService",
) {}

export interface GenerationServiceOptions {
  /** Real Tripo polls run ~5s apart (spike 0). Tests override this to a
   * tiny value and run under `it.live` (real Clock — Effect.sleep inside a
   * forked poll loop does not advance under `it.effect`'s virtual TestClock,
   * per this repo's own testing doctrine). */
  readonly pollIntervalMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 5_000;

interface RegistryState {
  readonly jobs: ReadonlyMap<GenerationJobId, GenerationJob>;
  readonly assets: ReadonlyMap<GeneratedAssetId, GeneratedAsset>;
}

export const makeWithOptions = Effect.fn("GenerationService.make")(function* (
  options: GenerationServiceOptions = {},
) {
  const provider = yield* Model3dProvider;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const httpClient = yield* HttpClient.HttpClient;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const crypto = yield* Crypto.Crypto;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  const stateRef = yield* Ref.make<RegistryState>({ jobs: new Map(), assets: new Map() });

  // A long-lived scope independent of any one request's own scope — a job
  // must survive the MCP tool call effect returning (spec's async model).
  // Tied to acquireRelease so it still closes when GenerationService's OWN
  // providing layer/scope closes (server shutdown, or a test's layer
  // teardown) rather than leaking fibers forever. Mirrors
  // OpenCodeTextGeneration.ts's `idleFiberScope` / CodexSessionRuntime.ts's
  // `runtimeScope`.
  const jobScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
    Scope.close(scope, Exit.void),
  );

  const updateJob = (jobId: GenerationJobId, f: (job: GenerationJob) => GenerationJob) =>
    Ref.update(stateRef, (state) => {
      const current = state.jobs.get(jobId);
      if (!current) return state;
      const jobs = new Map(state.jobs);
      jobs.set(jobId, f(current));
      return { ...state, jobs };
    });

  const putAsset = (asset: GeneratedAsset) =>
    Ref.update(stateRef, (state) => {
      const assets = new Map(state.assets);
      assets.set(asset.id, asset);
      return { ...state, assets };
    });

  const runGeneration = (job: GenerationJob) =>
    Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis;
      yield* updateJob(job.id, (current) => ({ ...current, status: "running", startedAt }));

      const submitted = yield* provider.submitTextTo3d({
        prompt: job.prompt,
        ...(job.parameters.faceLimit === undefined ? {} : { faceLimit: job.parameters.faceLimit }),
      });
      yield* updateJob(job.id, (current) => ({
        ...current,
        providerTaskId: submitted.providerTaskId,
      }));

      const finalState = yield* Effect.gen(function* () {
        while (true) {
          const state = yield* provider.pollTask(submitted.providerTaskId);
          if (state.status === "success" || state.status === "failed") {
            return state;
          }
          yield* updateJob(job.id, (current) => ({ ...current, progress: state.progress }));
          yield* Effect.sleep(Duration.millis(pollIntervalMs));
        }
      });

      const completedAt = yield* Clock.currentTimeMillis;

      if (finalState.status === "failed") {
        yield* updateJob(job.id, (current) => ({
          ...current,
          status: "failed",
          error: finalState.detail,
          completedAt,
        }));
        return;
      }

      // succeeded: download the GLB, inspect it server-side (no Unity —
      // spike 0), write it under the project-scoped generated dir, record
      // the GeneratedAsset.
      const assetId = GeneratedAssetIdSchema.make(
        `asset_${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`,
      );
      const assetDir = path.join(serverConfig.stateDir, "generated", job.projectId, assetId);
      yield* fileSystem.makeDirectory(assetDir, { recursive: true });

      const glbBytes = yield* HttpClientRequest.get(finalState.modelUrl).pipe(
        httpClient.execute,
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.arrayBuffer),
        Effect.map((buffer) => new Uint8Array(buffer)),
      );
      const glbPath = path.join(assetDir, "model.glb");
      yield* fileSystem.writeFile(glbPath, glbBytes);

      // A parse failure here degrades to zeroed metadata rather than
      // failing the whole job — the asset (and its GLB file) is still
      // real and worth keeping even if this increment's own inspector
      // cannot read it; a human/agent can still open the file.
      const inspected = yield* Effect.sync(() => {
        try {
          return inspectGlb(glbBytes);
        } catch {
          return { triangles: 0, materials: 0, images: 0 };
        }
      });

      const asset: GeneratedAsset = {
        id: assetId,
        projectId: job.projectId,
        generationJobId: job.id,
        modality: "model3d",
        provider: "tripo",
        files: { glb: glbPath },
        preview: { imageUrl: finalState.renderedImageUrl },
        metadata: {
          triangles: inspected.triangles,
          materials: inspected.materials,
          images: inspected.images,
          fileBytes: glbBytes.length,
        },
        createdAt: completedAt,
      };
      yield* putAsset(asset);
      yield* updateJob(job.id, (current) => ({
        ...current,
        status: "succeeded",
        assetId,
        completedAt,
      }));
    }).pipe(
      Effect.catch((error: unknown) =>
        Effect.gen(function* () {
          const completedAt = yield* Clock.currentTimeMillis;
          yield* updateJob(job.id, (current) => ({
            ...current,
            status: "failed",
            error: String(error),
            completedAt,
          }));
        }),
      ),
    );

  const createJob: GenerationServiceShape["createJob"] = (input) =>
    Effect.gen(function* () {
      const id = GenerationJobIdSchema.make(`gen_${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`);
      const createdAt = yield* Clock.currentTimeMillis;
      const job: GenerationJob = {
        id,
        projectId: input.projectId,
        threadId: input.threadId,
        modality: "model3d",
        provider: "tripo",
        providerTaskId: null,
        status: "created",
        progress: 0,
        prompt: input.prompt,
        parameters: input.parameters,
        assetId: null,
        error: null,
        createdAt,
        startedAt: null,
        completedAt: null,
      };
      yield* Ref.update(stateRef, (state) => ({
        ...state,
        jobs: new Map(state.jobs).set(id, job),
      }));
      yield* runGeneration(job).pipe(Effect.forkIn(jobScope));
      return job;
    });

  const getJob: GenerationServiceShape["getJob"] = (jobId) =>
    Ref.get(stateRef).pipe(Effect.map((state) => Option.fromNullishOr(state.jobs.get(jobId))));

  const listJobs: GenerationServiceShape["listJobs"] = (projectId) =>
    Ref.get(stateRef).pipe(
      Effect.map((state) =>
        Array.from(state.jobs.values())
          .filter((job) => job.projectId === projectId)
          .sort((a, b) => b.createdAt - a.createdAt),
      ),
    );

  const getAsset: GenerationServiceShape["getAsset"] = (assetId) =>
    Ref.get(stateRef).pipe(Effect.map((state) => Option.fromNullishOr(state.assets.get(assetId))));

  const getAssetByJobId: GenerationServiceShape["getAssetByJobId"] = (jobId) =>
    Ref.get(stateRef).pipe(
      Effect.map((state) => {
        const job = state.jobs.get(jobId);
        if (!job || job.assetId === null) return Option.none<GeneratedAsset>();
        return Option.fromNullishOr(state.assets.get(job.assetId));
      }),
    );

  return GenerationService.of({ createJob, getJob, listJobs, getAsset, getAssetByJobId });
});

/** `Layer.effect` runs its build effect in the layer's own scope (this
 * Effect version merges what other Effect versions call `Layer.scoped`
 * into `Layer.effect` itself), so the `Effect.acquireRelease(Scope.make(),
 * ...)` above ties `jobScope`'s lifetime to THIS layer, not to any one
 * request. */
export const layer = (options?: GenerationServiceOptions) =>
  Layer.effect(GenerationService, makeWithOptions(options));

/** Exposed for tests. */
export const __testing = { make: makeWithOptions };
