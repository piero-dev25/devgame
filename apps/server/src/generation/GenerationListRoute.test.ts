/**
 * In-process coverage for `dispatchGenerationList` — the scope-gate +
 * project-scoping + redaction logic `POST /generation/list` relies on.
 * Mirrors `unity/UnitySetupProbeRoute.test.ts`'s own pattern (fake
 * `ProjectionSnapshotQuery`, fake `GenerationService`, a session-builder
 * helper) for the identical "route authenticates WHO, this function decides
 * WHAT" split.
 */
import { describe, expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthPresenceCommandScope,
  AuthPresenceReadScope,
  AuthSessionId,
  GeneratedAssetId,
  GenerationJobId,
  OrchestrationProjectShell,
  ProjectId,
  ThreadId,
  type GeneratedAsset,
  type GenerationJob,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";

import { dispatchGenerationList } from "./GenerationListRoute.ts";
import * as GenerationService from "./GenerationService.ts";

const PROJECT_ID = ProjectId.make("project-gen-list");
const OTHER_PROJECT_ID = ProjectId.make("project-gen-list-other");
const THREAD_ID = ThreadId.make("thread-gen-list");

const PROJECT = Schema.decodeUnknownSync(OrchestrationProjectShell)({
  id: PROJECT_ID,
  title: "Generation Project",
  workspaceRoot: "/Users/piero/Projects/GenGame",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-08-12T00:00:00.000Z",
  updatedAt: "2026-08-12T00:00:00.000Z",
});

function makeSession(
  scopes: EnvironmentAuth.AuthenticatedSession["scopes"],
): EnvironmentAuth.AuthenticatedSession {
  return {
    sessionId: AuthSessionId.make("test-session"),
    subject: "test-subject",
    method: "bearer-access-token",
    scopes,
  };
}

function makeProjectionSnapshotQuerySpy(project: typeof PROJECT | null | "fail"): {
  readonly layer: Layer.Layer<ProjectionSnapshotQuery.ProjectionSnapshotQuery>;
} {
  const service: ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"] = {
    getCommandReadModel: () => Effect.die("unexpected getCommandReadModel call"),
    getSnapshot: () => Effect.die("unexpected getSnapshot call"),
    getShellSnapshot: () => Effect.die("unexpected getShellSnapshot call"),
    getArchivedShellSnapshot: () => Effect.die("unexpected getArchivedShellSnapshot call"),
    searchThreads: () => Effect.die("unexpected searchThreads call"),
    getSnapshotSequence: () => Effect.die("unexpected getSnapshotSequence call"),
    getCounts: () => Effect.die("unexpected getCounts call"),
    getActiveProjectByWorkspaceRoot: () =>
      Effect.die("unexpected getActiveProjectByWorkspaceRoot call"),
    getProjectShellById: () =>
      Effect.suspend(() => {
        if (project === "fail") {
          return Effect.fail(
            new PersistenceSqlError({ operation: "test: projection lookup failure" }),
          );
        }
        return Effect.succeed(project === null ? Option.none() : Option.some(project));
      }),
    getFirstActiveThreadIdByProjectId: () =>
      Effect.die("unexpected getFirstActiveThreadIdByProjectId call"),
    getActiveSpacesForProject: () => Effect.die("unexpected getActiveSpacesForProject call"),
    getSpaceProjectId: () => Effect.die("unexpected getSpaceProjectId call"),
    getThreadCheckpointContext: () => Effect.die("unexpected getThreadCheckpointContext call"),
    getFullThreadDiffContext: () => Effect.die("unexpected getFullThreadDiffContext call"),
    getThreadShellById: () => Effect.die("unexpected getThreadShellById call"),
    getThreadDetailById: () => Effect.die("unexpected getThreadDetailById call"),
    getThreadDetailSnapshot: () => Effect.die("unexpected getThreadDetailSnapshot call"),
  };
  return { layer: Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, service) };
}

/** A minimal in-memory `GenerationService` fake, seeded directly with jobs
 * and assets — this is the "write" side of the shared-singleton story for
 * THIS file's own tests (unlike `GenerationServiceRegistrySharing.test.ts`,
 * this file is testing `dispatchGenerationList`'s OWN dispatch logic in
 * isolation, not the sharing mechanism itself, so a fake is the right tool
 * here — the real shared-instance proof lives in that sibling file). */
function makeGenerationServiceFake(input: {
  readonly jobs: ReadonlyArray<GenerationJob>;
  readonly assets: ReadonlyArray<GeneratedAsset>;
}): Layer.Layer<GenerationService.GenerationService> {
  const jobs = new Map(input.jobs.map((job) => [job.id, job]));
  const assets = new Map(input.assets.map((asset) => [asset.id, asset]));
  const service: GenerationService.GenerationServiceShape = {
    createJob: () => Effect.die("unexpected createJob call"),
    getJob: (jobId) => Effect.succeed(Option.fromNullishOr(jobs.get(jobId))),
    listJobs: (projectId) =>
      Effect.succeed(Array.from(jobs.values()).filter((job) => job.projectId === projectId)),
    getAsset: (assetId) => Effect.succeed(Option.fromNullishOr(assets.get(assetId))),
    getAssetByJobId: () => Effect.die("unexpected getAssetByJobId call"),
  };
  return Layer.succeed(GenerationService.GenerationService, service);
}

/** A deterministic fake `ServerSecretStore` — the route only ever calls
 * `getOrCreateRandom` (to sign a media URL); a fixed 32-byte key is enough
 * for these tests, which assert dispatch behaviour, not signature
 * correctness (that's `GenerationAssetAccess.test.ts`'s job). */
const fakeServerSecretStoreLayer = Layer.succeed(
  ServerSecretStore.ServerSecretStore,
  ServerSecretStore.ServerSecretStore.of({
    get: () => Effect.succeed(Option.none()),
    set: () => Effect.void,
    create: () => Effect.void,
    getOrCreateRandom: () => Effect.succeed(new Uint8Array(32).fill(7)),
    remove: () => Effect.void,
  }),
);

function makeJob(
  overrides: Partial<GenerationJob> & { readonly id: GenerationJob["id"] },
): GenerationJob {
  return {
    projectId: PROJECT_ID,
    threadId: THREAD_ID,
    modality: "model3d",
    provider: "tripo",
    providerTaskId: "provider-task-1",
    status: "created",
    progress: 0,
    prompt: "a stylized wooden barrel",
    parameters: {},
    assetId: null,
    error: null,
    createdAt: 1_000,
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

describe("dispatchGenerationList", () => {
  it.effect(
    "refuses a session without the dedicated presence:read scope, without ever listing jobs",
    () =>
      Effect.gen(function* () {
        const generation = makeGenerationServiceFake({ jobs: [], assets: [] });
        const projection = makeProjectionSnapshotQuerySpy(PROJECT);
        const session = makeSession([AuthOrchestrationOperateScope]);
        const outcome = yield* dispatchGenerationList(session, PROJECT_ID).pipe(
          Effect.provide(Layer.mergeAll(generation, projection.layer, fakeServerSecretStoreLayer)),
        );
        expect(outcome).toEqual({ _tag: "insufficientScope" });
      }),
  );

  it.effect(
    "presence:command alone does NOT satisfy presence:read — the scopes are deliberately distinct",
    () =>
      Effect.gen(function* () {
        const generation = makeGenerationServiceFake({ jobs: [], assets: [] });
        const projection = makeProjectionSnapshotQuerySpy(PROJECT);
        const session = makeSession([AuthPresenceCommandScope]);
        const outcome = yield* dispatchGenerationList(session, PROJECT_ID).pipe(
          Effect.provide(Layer.mergeAll(generation, projection.layer, fakeServerSecretStoreLayer)),
        );
        expect(outcome).toEqual({ _tag: "insufficientScope" });
      }),
  );

  it.effect("unknown projectId returns a typed error without listing any jobs", () =>
    Effect.gen(function* () {
      const generation = makeGenerationServiceFake({ jobs: [], assets: [] });
      const projection = makeProjectionSnapshotQuerySpy(null);
      const session = makeSession([AuthPresenceReadScope]);
      const outcome = yield* dispatchGenerationList(session, PROJECT_ID).pipe(
        Effect.provide(Layer.mergeAll(generation, projection.layer, fakeServerSecretStoreLayer)),
      );
      expect(outcome).toEqual({
        _tag: "ok",
        value: { _tag: "error", message: "Project not found." },
      });
    }),
  );

  it.effect(
    "a FAILED projection lookup collapses to its own typed error, distinct from Project not found",
    () =>
      Effect.gen(function* () {
        const generation = makeGenerationServiceFake({ jobs: [], assets: [] });
        const projection = makeProjectionSnapshotQuerySpy("fail");
        const session = makeSession([AuthPresenceReadScope]);
        const outcome = yield* dispatchGenerationList(session, PROJECT_ID).pipe(
          Effect.provide(Layer.mergeAll(generation, projection.layer, fakeServerSecretStoreLayer)),
        );
        expect(outcome).toEqual({
          _tag: "ok",
          value: { _tag: "error", message: "Could not resolve project." },
        });
      }),
  );

  it.effect(
    "returns project-scoped jobs with client-safe asset paths — no absolute path crosses the wire",
    () =>
      Effect.gen(function* () {
        const assetId = GeneratedAssetId.make("asset-gen-list-1");
        const jobId = GenerationJobId.make("gen-list-1");
        const job = makeJob({
          id: jobId,
          status: "succeeded",
          progress: 100,
          assetId,
          completedAt: 2_000,
        });
        const asset: GeneratedAsset = {
          id: assetId,
          projectId: PROJECT_ID,
          generationJobId: jobId,
          modality: "model3d",
          provider: "tripo",
          // The REAL server shape — an absolute path rooted under this
          // machine's home directory, exactly like GenerationService.ts
          // actually writes.
          files: {
            glb: "/Users/piero/.config/devgame/state/generated/project-gen-list/asset-gen-list-1/model.glb",
          },
          preview: { imageUrl: "https://tripo.example/render.png" },
          metadata: { triangles: 4200, materials: 1, images: 3, fileBytes: 654_321 },
          createdAt: 2_000,
        };
        const generation = makeGenerationServiceFake({ jobs: [job], assets: [asset] });
        const projection = makeProjectionSnapshotQuerySpy(PROJECT);
        const session = makeSession([AuthPresenceReadScope]);

        const outcome = yield* dispatchGenerationList(session, PROJECT_ID).pipe(
          Effect.provide(Layer.mergeAll(generation, projection.layer, fakeServerSecretStoreLayer)),
        );

        expect(outcome._tag).toBe("ok");
        if (outcome._tag !== "ok" || "_tag" in outcome.value) {
          throw new Error("Expected a successful GenerationListSuccess.");
        }
        expect(outcome.value.entries).toHaveLength(1);
        const entry = outcome.value.entries[0]!;
        expect(entry.job.id).toBe(jobId);
        expect(entry.asset).not.toBeNull();
        // The load-bearing assertion: the absolute stateDir/home-rooted
        // prefix is GONE — only the redacted `generated/...` form survives,
        // via the SAME `toClientSafeGeneratedAsset` the MCP tools reuse.
        expect(entry.asset!.files.glb).toBe(
          "generated/project-gen-list/asset-gen-list-1/model.glb",
        );
        expect(entry.asset!.files.glb).not.toContain("/Users/");
        expect(entry.previewMediaUrl).not.toBeNull();
        expect(entry.previewMediaUrl!.startsWith("/api/generation-assets/")).toBe(true);
      }),
  );

  it.effect("a foreign-project asset reads as absent — never leaked across projects", () =>
    Effect.gen(function* () {
      const assetId = GeneratedAssetId.make("asset-foreign-1");
      const jobId = GenerationJobId.make("gen-foreign-1");
      // The job itself belongs to PROJECT_ID (as `listJobs` already scopes
      // by), but its recorded asset belongs to a DIFFERENT project — the
      // exact "GenerationService.getAsset is NOT project-scoped" gap the
      // spec's own cross-project invariant calls out; `dispatchGenerationList`
      // must re-check it by hand, same as every MCP handler does.
      const job = makeJob({
        id: jobId,
        status: "succeeded",
        progress: 100,
        assetId,
        completedAt: 2_000,
      });
      const foreignAsset: GeneratedAsset = {
        id: assetId,
        projectId: OTHER_PROJECT_ID,
        generationJobId: jobId,
        modality: "model3d",
        provider: "tripo",
        files: { glb: "/state/generated/project-gen-list-other/asset-foreign-1/model.glb" },
        preview: { imageUrl: "https://tripo.example/render.png" },
        metadata: { triangles: 100, materials: 1, images: 1, fileBytes: 1_000 },
        createdAt: 2_000,
      };
      const generation = makeGenerationServiceFake({ jobs: [job], assets: [foreignAsset] });
      const projection = makeProjectionSnapshotQuerySpy(PROJECT);
      const session = makeSession([AuthPresenceReadScope]);

      const outcome = yield* dispatchGenerationList(session, PROJECT_ID).pipe(
        Effect.provide(Layer.mergeAll(generation, projection.layer, fakeServerSecretStoreLayer)),
      );

      expect(outcome._tag).toBe("ok");
      if (outcome._tag !== "ok" || "_tag" in outcome.value) {
        throw new Error("Expected a successful GenerationListSuccess.");
      }
      expect(outcome.value.entries).toHaveLength(1);
      const entry = outcome.value.entries[0]!;
      expect(entry.job.id).toBe(jobId);
      // The asset is NOT surfaced — it belongs to a different project.
      expect(entry.asset).toBeNull();
      expect(entry.previewMediaUrl).toBeNull();
    }),
  );

  it.effect("a job with no asset yet reports asset:null, previewMediaUrl:null — not an error", () =>
    Effect.gen(function* () {
      const job = makeJob({
        id: GenerationJobId.make("gen-running-1"),
        status: "running",
        progress: 40,
      });
      const generation = makeGenerationServiceFake({ jobs: [job], assets: [] });
      const projection = makeProjectionSnapshotQuerySpy(PROJECT);
      const session = makeSession([AuthPresenceReadScope]);

      const outcome = yield* dispatchGenerationList(session, PROJECT_ID).pipe(
        Effect.provide(Layer.mergeAll(generation, projection.layer, fakeServerSecretStoreLayer)),
      );

      expect(outcome._tag).toBe("ok");
      if (outcome._tag !== "ok" || "_tag" in outcome.value) {
        throw new Error("Expected a successful GenerationListSuccess.");
      }
      expect(outcome.value.entries).toEqual([{ job, asset: null, previewMediaUrl: null }]);
    }),
  );
});
