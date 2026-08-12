import {
  GeneratedAssetNotFoundError,
  GenerationCapabilityUnavailableError,
  GenerationJobNotFoundError,
  GenerationProjectResolutionError,
  type Generate3dInput,
  type GeneratedAsset,
  type GenerationStatusInput,
  type InspectGenerationInput,
  type ListGenerationsInput,
} from "@t3tools/contracts";
import type { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as GenerationService from "../../../generation/GenerationService.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { GenerationStandardToolkit } from "./tools.ts";

/**
 * Task #116's fork-owned `McpCapabilityUnavailableError` already covers
 * "generation" (McpInvocationContext.ts's own comment says a future
 * generation toolkit does its own translation, never widens that error's
 * shape). Translate it into the generation toolkit's OWN fork-owned error
 * — mirrors the preview toolkit's `invoke` doing the same translation into
 * the vendor `PreviewAutomationUnavailableError`, except this toolkit's
 * failure type is fork-owned end to end, so there is nothing vendor to
 * translate back into.
 */
export const requireGenerationScope = Effect.fn("GenerationToolkit.requireScope")(function* () {
  return yield* McpInvocationContext.requireMcpCapability("generation").pipe(
    Effect.catchTag("McpCapabilityUnavailableError", (error) =>
      Effect.fail(
        new GenerationCapabilityUnavailableError({
          environmentId: error.environmentId,
          threadId: error.threadId,
          providerSessionId: error.providerSessionId,
          providerInstanceId: error.providerInstanceId,
        }),
      ),
    ),
  );
});

/**
 * `McpInvocationScope` carries `threadId`, never `projectId` (seams note
 * "MCP invocation scope gap" — the Diff-panel precedent). Resolve it the
 * same way `ws.ts`'s `assetsCreateUrl` workspace-file resolution does:
 * `getThreadShellById(threadId).projectId`. Increment 1 does not need
 * `workspaceRoot` at all — generated files live under `<stateDir>/
 * generated/<projectId>/`, never the project workspace.
 */
export const resolveProjectContext = Effect.fn("GenerationToolkit.resolveProjectContext")(
  function* (
    threadId: ThreadId,
  ): Effect.fn.Return<
    { readonly projectId: ProjectId },
    GenerationProjectResolutionError,
    ProjectionSnapshotQuery.ProjectionSnapshotQuery
  > {
    const snapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    const thread = yield* snapshotQuery.getThreadShellById(threadId).pipe(
      Effect.mapError(
        (cause) =>
          new GenerationProjectResolutionError({
            threadId,
            detail: `lookup failed: ${String(cause)}`,
          }),
      ),
    );
    if (Option.isNone(thread)) {
      return yield* new GenerationProjectResolutionError({ threadId, detail: "thread not found" });
    }
    return { projectId: thread.value.projectId };
  },
);

const generate3d = (input: Generate3dInput) =>
  Effect.gen(function* () {
    const scope = yield* requireGenerationScope();
    const { projectId } = yield* resolveProjectContext(scope.threadId);
    const service = yield* GenerationService.GenerationService;
    const job = yield* service.createJob({
      projectId,
      threadId: scope.threadId,
      prompt: input.prompt,
      parameters: input.faceLimit === undefined ? {} : { faceLimit: input.faceLimit },
    });
    return { jobId: job.id, status: "running" as const };
  });

/** Exported (unlike its generate3d/listGenerations siblings) so the
 * cross-project scoping fix (merge-gate P1 #2) is directly unit-testable
 * without standing up the declarative toolkit — same reasoning
 * `inspectGeneration` is exported for below. */
export const generationStatus = (input: GenerationStatusInput) =>
  Effect.gen(function* () {
    const scope = yield* requireGenerationScope();
    const { projectId } = yield* resolveProjectContext(scope.threadId);
    const service = yield* GenerationService.GenerationService;
    const job = yield* service.getJob(input.jobId);
    // Merge-gate P1 #2: a job id from ANOTHER project must read as
    // not-found, not as that project's job — the same cross-project leak
    // class as #71 (editor-presence chips). Collapsing "wrong project" into
    // the identical NotFoundError a genuinely unknown id gets is
    // deliberate: it tells a caller nothing about whether the id exists
    // somewhere else.
    if (Option.isNone(job) || job.value.projectId !== projectId) {
      return yield* new GenerationJobNotFoundError({ jobId: input.jobId });
    }
    return job.value;
  });

const listGenerations = (_input: ListGenerationsInput) =>
  Effect.gen(function* () {
    const scope = yield* requireGenerationScope();
    const { projectId } = yield* resolveProjectContext(scope.threadId);
    const service = yield* GenerationService.GenerationService;
    const jobs = yield* service.listJobs(projectId);
    return { jobs };
  });

const handlers = {
  generate_3d: generate3d,
  generation_status: generationStatus,
  list_generations: listGenerations,
} satisfies Parameters<typeof GenerationStandardToolkit.toLayer>[0];

export const GenerationStandardToolkitHandlersLive = GenerationStandardToolkit.toLayer(handlers);

/**
 * NOT part of the declarative toolkit layer above — registered manually in
 * McpHttpServer.ts (the `registerPreviewSnapshot` image-content-block
 * idiom) because its result carries a preview image alongside the
 * structured `GeneratedAsset`. Exported so the capability-gate/not-found
 * behavior is unit-testable without standing up the full MCP transport,
 * same reasoning `PreviewToolkit.invoke`'s own doc comment gives.
 */
/**
 * Merge-gate P2 #6+9 (the #76 "scrub at the single funnel" pattern):
 * `GeneratedAsset.files.glb` is an ABSOLUTE server path (spec: "absolute
 * path under the generated dir") — real, and needed internally for actual
 * file I/O, but never meant to cross the MCP wire to a client. This is
 * the ONE place a `GeneratedAsset` leaves the process (both the exported
 * handler below and `McpHttpServer.ts`'s manual registration return
 * exactly this value), so redacting here is the funnel, not a
 * per-call-site patch some future call site could forget. Keeps the
 * `generated/<projectId>/<assetId>/model.glb` structure (still a useful,
 * opaque reference) and drops everything above it — in particular the
 * absolute `stateDir` prefix, which is rooted under this machine's home
 * directory.
 */
const toClientSafeGeneratedAsset = (asset: GeneratedAsset): GeneratedAsset => {
  const marker = "generated/";
  const markerIndex = asset.files.glb.lastIndexOf(marker);
  const glb =
    markerIndex === -1
      ? (asset.files.glb.split(/[/\\]/).pop() ?? asset.files.glb)
      : asset.files.glb.slice(markerIndex);
  return { ...asset, files: { ...asset.files, glb } };
};

export const inspectGeneration = Effect.fn("GenerationToolkit.inspectGeneration")(function* (
  input: InspectGenerationInput,
): Effect.fn.Return<
  GeneratedAsset,
  | InstanceType<typeof GenerationCapabilityUnavailableError>
  | InstanceType<typeof GeneratedAssetNotFoundError>
  | InstanceType<typeof GenerationProjectResolutionError>,
  | McpInvocationContext.McpInvocationContext
  | GenerationService.GenerationService
  | ProjectionSnapshotQuery.ProjectionSnapshotQuery
> {
  const scope = yield* requireGenerationScope();
  const { projectId } = yield* resolveProjectContext(scope.threadId);
  const service = yield* GenerationService.GenerationService;
  const asset = yield* input.assetId !== undefined
    ? service.getAsset(input.assetId)
    : input.jobId !== undefined
      ? service.getAssetByJobId(input.jobId)
      : Effect.succeed(Option.none<GeneratedAsset>());
  // Merge-gate P1 #2: same cross-project leak class as generation_status —
  // an asset id from another project must read as not-found.
  if (Option.isNone(asset) || asset.value.projectId !== projectId) {
    return yield* new GeneratedAssetNotFoundError({
      ...(input.jobId === undefined ? {} : { jobId: input.jobId }),
      ...(input.assetId === undefined ? {} : { assetId: input.assetId }),
    });
  }
  return toClientSafeGeneratedAsset(asset.value);
});
