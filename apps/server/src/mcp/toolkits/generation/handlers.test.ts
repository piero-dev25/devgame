import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  GenerationCapabilityUnavailableError,
  GenerationJobNotFoundError,
  GenerationProjectResolutionError,
  GeneratedAssetNotFoundError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type GeneratedAsset,
  type GenerationJob,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { describe } from "vite-plus/test";

import { PersistenceSqlError } from "../../../persistence/Errors.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  generationStatus,
  inspectGeneration,
  requireGenerationScope,
  resolveProjectContext,
} from "./handlers.ts";
import * as GenerationService from "../../../generation/GenerationService.ts";

const grantedScope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["preview", "generation"]),
  issuedAt: 1,
};

const deniedScope: McpInvocationContext.McpInvocationScope = {
  ...grantedScope,
  capabilities: new Set(["preview"]), // has preview, NOT generation — the exact real-world shape
};

// task #116 fully closed the capability-type trap; this increment's own
// gate is the GRANT, so these two tests are red-first for THIS toolkit:
// before McpSessionRegistry.ts:131 widened its grant, every real session's
// scope looked exactly like `deniedScope` above.
describe("requireGenerationScope", () => {
  it.effect("refuses a scope that does not carry the generation capability", () =>
    Effect.gen(function* () {
      const error = yield* requireGenerationScope().pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, deniedScope),
        Effect.flip,
      );
      expect(error).toBeInstanceOf(GenerationCapabilityUnavailableError);
      expect(error).toMatchObject({
        environmentId: deniedScope.environmentId,
        threadId: deniedScope.threadId,
        providerSessionId: deniedScope.providerSessionId,
        providerInstanceId: deniedScope.providerInstanceId,
      });
      expect(error.message).toBe("MCP credential does not grant the generation capability.");
    }),
  );

  it.effect("passes the scope through unchanged when generation is granted", () =>
    Effect.gen(function* () {
      const scope = yield* requireGenerationScope().pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, grantedScope),
      );
      expect(scope).toBe(grantedScope);
    }),
  );
});

const unreachableProjectionSnapshotQuery = (
  overrides: Partial<ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"]>,
): ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"] => ({
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
  getThreadShellById: () => Effect.die("unexpected getThreadShellById call"),
  getThreadDetailById: () => Effect.die("unexpected getThreadDetailById call"),
  getThreadDetailSnapshot: () => Effect.die("unexpected getThreadDetailSnapshot call"),
  ...overrides,
});

describe("resolveProjectContext", () => {
  it.effect("resolves projectId from a stubbed threadId lookup", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project-42");
      const requested: Array<ThreadId> = [];
      const stub = unreachableProjectionSnapshotQuery({
        getThreadShellById: (threadId) =>
          Effect.sync(() => {
            requested.push(threadId);
            return Option.some({ id: threadId, projectId } as never);
          }),
      });
      const result = yield* resolveProjectContext(grantedScope.threadId).pipe(
        Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, stub),
      );
      expect(result).toEqual({ projectId });
      expect(requested).toEqual([grantedScope.threadId]);
    }),
  );

  it.effect("fails with GenerationProjectResolutionError when the thread is not found", () =>
    Effect.gen(function* () {
      const stub = unreachableProjectionSnapshotQuery({
        getThreadShellById: () => Effect.succeed(Option.none()),
      });
      const error = yield* resolveProjectContext(grantedScope.threadId).pipe(
        Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, stub),
        Effect.flip,
      );
      expect(error).toBeInstanceOf(GenerationProjectResolutionError);
      expect(error.threadId).toBe(grantedScope.threadId);
    }),
  );

  it.effect("fails with GenerationProjectResolutionError when the lookup itself fails", () =>
    Effect.gen(function* () {
      const stub = unreachableProjectionSnapshotQuery({
        getThreadShellById: () =>
          Effect.fail(new PersistenceSqlError({ operation: "test: lookup failure" })),
      });
      const error = yield* resolveProjectContext(grantedScope.threadId).pipe(
        Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, stub),
        Effect.flip,
      );
      expect(error).toBeInstanceOf(GenerationProjectResolutionError);
    }),
  );
});

const unreachableGenerationService: GenerationService.GenerationServiceShape = {
  createJob: () => Effect.die("unexpected createJob call"),
  getJob: () => Effect.die("unexpected getJob call"),
  listJobs: () => Effect.die("unexpected listJobs call"),
  getAsset: () => Effect.die("unexpected getAsset call"),
  getAssetByJobId: () => Effect.die("unexpected getAssetByJobId call"),
};

describe("inspectGeneration", () => {
  it.effect("refuses without the generation capability", () =>
    Effect.gen(function* () {
      // requireGenerationScope() fails BEFORE resolveProjectContext ever
      // runs, so ProjectionSnapshotQuery stays fully unreachable here —
      // same reasoning as unreachableGenerationService below.
      const error = yield* inspectGeneration({ jobId: undefined, assetId: undefined }).pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, deniedScope),
        Effect.provideService(GenerationService.GenerationService, unreachableGenerationService),
        Effect.provideService(
          ProjectionSnapshotQuery.ProjectionSnapshotQuery,
          unreachableProjectionSnapshotQuery({}),
        ),
        Effect.flip,
      );
      expect(error).toBeInstanceOf(GenerationCapabilityUnavailableError);
    }),
  );

  it.effect(
    "fails cleanly with GeneratedAssetNotFoundError when the job has not succeeded yet",
    () =>
      Effect.gen(function* () {
        const projectId = ProjectId.make("project-inspect-not-done");
        const service: GenerationService.GenerationServiceShape = {
          createJob: () => Effect.die("unexpected createJob call"),
          getJob: () => Effect.die("unexpected getJob call"),
          listJobs: () => Effect.die("unexpected listJobs call"),
          getAsset: () => Effect.die("unexpected getAsset call"),
          getAssetByJobId: () => Effect.succeed(Option.none()),
        };
        const snapshotQuery = unreachableProjectionSnapshotQuery({
          getThreadShellById: (threadId) =>
            Effect.succeed(Option.some({ id: threadId, projectId } as never)),
        });
        const error = yield* inspectGeneration({
          jobId: "gen_not-done-yet" as never,
          assetId: undefined,
        }).pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, grantedScope),
          Effect.provideService(GenerationService.GenerationService, service),
          Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, snapshotQuery),
          Effect.flip,
        );
        expect(error).toBeInstanceOf(GeneratedAssetNotFoundError);
      }),
  );
});

// Merge-gate P1 #2: the cross-project leak class (same shape as #71's
// editor-presence chips). Red-proof: before this fix, generationStatus and
// inspectGeneration returned whatever getJob/getAsset gave back with NO
// projectId comparison at all — a session scoped to project B could read
// project A's job/asset just by knowing its id. These tests build a job/
// asset that genuinely belongs to project A and a caller scoped (via the
// stubbed threadId lookup) to project B, and assert the SAME NotFoundError
// a truly-unknown id gets, not the real record.
describe("cross-project scoping (merge-gate P1 #2)", () => {
  const projectA = ProjectId.make("project-a");
  const projectB = ProjectId.make("project-b");
  const scopeForProjectB: McpInvocationContext.McpInvocationScope = grantedScope;
  const snapshotQueryResolvingProjectB = unreachableProjectionSnapshotQuery({
    getThreadShellById: (threadId) =>
      Effect.succeed(Option.some({ id: threadId, projectId: projectB } as never)),
  });

  it.effect("generation_status: a job belonging to another project reads as not-found", () =>
    Effect.gen(function* () {
      const jobFromProjectA: GenerationJob = {
        id: "gen_owned-by-a" as never,
        projectId: projectA,
        threadId: "thread-a" as never,
        modality: "model3d",
        provider: "tripo",
        providerTaskId: null,
        status: "succeeded",
        progress: 100,
        prompt: "a barrel",
        parameters: {},
        assetId: null,
        error: null,
        createdAt: 1,
        startedAt: 1,
        completedAt: 2,
      };
      const service: GenerationService.GenerationServiceShape = {
        createJob: () => Effect.die("unexpected createJob call"),
        getJob: () => Effect.succeed(Option.some(jobFromProjectA)),
        listJobs: () => Effect.die("unexpected listJobs call"),
        getAsset: () => Effect.die("unexpected getAsset call"),
        getAssetByJobId: () => Effect.die("unexpected getAssetByJobId call"),
      };
      const error = yield* generationStatus({ jobId: jobFromProjectA.id }).pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scopeForProjectB),
        Effect.provideService(GenerationService.GenerationService, service),
        Effect.provideService(
          ProjectionSnapshotQuery.ProjectionSnapshotQuery,
          snapshotQueryResolvingProjectB,
        ),
        Effect.flip,
      );
      expect(error).toBeInstanceOf(GenerationJobNotFoundError);
    }),
  );

  it.effect("inspect_generation: an asset belonging to another project reads as not-found", () =>
    Effect.gen(function* () {
      const assetFromProjectA: GeneratedAsset = {
        id: "asset_owned-by-a" as never,
        projectId: projectA,
        generationJobId: "gen_owned-by-a" as never,
        modality: "model3d",
        provider: "tripo",
        files: { glb: "/state/generated/project-a/asset_owned-by-a/model.glb" },
        preview: { imageUrl: null },
        metadata: { triangles: 1, materials: 1, images: 0, fileBytes: 1 },
        createdAt: 1,
      };
      const service: GenerationService.GenerationServiceShape = {
        createJob: () => Effect.die("unexpected createJob call"),
        getJob: () => Effect.die("unexpected getJob call"),
        listJobs: () => Effect.die("unexpected listJobs call"),
        getAsset: () => Effect.succeed(Option.some(assetFromProjectA)),
        getAssetByJobId: () => Effect.die("unexpected getAssetByJobId call"),
      };
      const error = yield* inspectGeneration({
        assetId: assetFromProjectA.id,
        jobId: undefined,
      }).pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scopeForProjectB),
        Effect.provideService(GenerationService.GenerationService, service),
        Effect.provideService(
          ProjectionSnapshotQuery.ProjectionSnapshotQuery,
          snapshotQueryResolvingProjectB,
        ),
        Effect.flip,
      );
      expect(error).toBeInstanceOf(GeneratedAssetNotFoundError);
    }),
  );
});
