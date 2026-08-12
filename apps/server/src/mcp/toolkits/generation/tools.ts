import {
  Generate3dInput,
  Generate3dResult,
  GenerationJob,
  GenerationStatusInput,
  GenerationToolError,
  GeneratedAsset,
  ImportGeneratedAssetInput,
  ImportGeneratedAssetResult,
  InspectGenerationInput,
  ListGenerationsInput,
  ListGenerationsResult,
} from "@t3tools/contracts";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { Tool, Toolkit } from "effect/unstable/ai";
import { HttpClient } from "effect/unstable/http";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as GenerationService from "../../../generation/GenerationService.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  GenerationService.GenerationService,
  ProjectionSnapshotQuery.ProjectionSnapshotQuery,
];

/** `import_generated_asset`'s own dependency list: the shared three above
 * PLUS every OTHER bare service its handler ends up needing — `FileSystem`/
 * `Path` (used directly: reading the cached GLB off disk, writing the
 * derived FBX + extracted textures) and `HttpClient`/`ChildProcessSpawner`/
 * `ServerSecretStore` (needed to CONSTRUCT the self-contained
 * `Model3dProvider`/`UnityPipelineClient` instances `handlers.ts`'s
 * `ImportGeneratedAssetRuntimeDependenciesLive` builds — see that
 * constant's own comment for why `Model3dProvider`/`UnityPipelineClient`
 * THEMSELVES are deliberately NOT listed here, only their transitive
 * platform/secret-store needs).
 *
 * `Tool.make`'s `dependencies` is an EXACT contract, not just an upper
 * bound: `GenerationStandardToolkit.toLayer(handlers)` typechecks each
 * handler's OWN Effect requirement against this list right there in
 * handlers.ts, so anything the handler needs that isn't listed here is a
 * compile error at that call site — unlike a plain bare requirement on an
 * ordinary `const` (e.g. `GenerationService.layer()`'s own FileSystem/
 * Path/HttpClient/ServerConfig/Crypto need in `McpHttpServer.ts`'s
 * `GenerationServiceLive`, which is never locally enforced this way).
 * Every one of these five IS already proven ambient across the whole
 * `McpHttpServer.layer` graph by that exact `GenerationServiceLive`
 * precedent (FileSystem/Path/HttpClient) plus `ServerSecretStore`'s own
 * identical `Layer.provideMerge` chain and `ChildProcessSpawner`'s
 * bundling into the same Bun/Node platform layer server.ts calls
 * `PlatformServicesLive` — none of the five need discharging in
 * McpHttpServer.ts (an out-of-scope edit for this increment); leaving them
 * bare here just makes that ALREADY-TRUE fact visible to this specific
 * type-checking boundary. `ServerConfig` (fix round finding #4) is the
 * sixth: `deriveAndCacheImportFiles`'s scrub funnel reads
 * `serverConfig.stateDir` as one of the two absolute-path roots it
 * redacts from any client-facing `UnityImportFailedError.detail` — same
 * ambient proof (`GenerationServiceLive`'s own untouched `ServerConfig`
 * need). */
const importGeneratedAssetDependencies = [
  ...dependencies,
  FileSystem.FileSystem,
  Path.Path,
  HttpClient.HttpClient,
  ChildProcessSpawner.ChildProcessSpawner,
  ServerSecretStore.ServerSecretStore,
  ServerConfig.ServerConfig,
];

export const Generate3dTool = Tool.make("generate_3d", {
  description:
    "Generate a 3D game asset from a text prompt (Tripo, model3d modality). Returns a job handle immediately — the SERVER runs the generation in the background (real jobs take 30s-3min). Poll generation_status with the returned jobId to see progress and, on success, the resulting assetId.",
  parameters: Generate3dInput,
  success: Generate3dResult,
  failure: GenerationToolError,
  dependencies,
})
  .annotate(Tool.Title, "Generate a 3D asset")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const GenerationStatusTool = Tool.make("generation_status", {
  description:
    "Check a generation job's status, progress (0-100), and — once succeeded — its assetId. Fails with GenerationJobNotFoundError for an unknown jobId.",
  parameters: GenerationStatusInput,
  success: GenerationJob,
  failure: GenerationToolError,
  dependencies,
})
  .annotate(Tool.Title, "Check generation status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ListGenerationsTool = Tool.make("list_generations", {
  description: "List this project's generation jobs, newest first.",
  parameters: ListGenerationsInput,
  success: ListGenerationsResult,
  failure: GenerationToolError,
  dependencies,
})
  .annotate(Tool.Title, "List generations")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

/** Registered manually in McpHttpServer.ts (the `registerPreviewSnapshot`
 * image-content-block idiom) rather than through a declarative toolkit
 * layer, because its result carries a preview image alongside structured
 * JSON. Declared here anyway so its schema/annotations live next to its
 * siblings. */
export const InspectGenerationTool = Tool.make("inspect_generation", {
  description:
    "Inspect a generated asset by jobId or assetId: triangle/material/image counts computed server-side from the GLB, plus a preview image. Fails cleanly (GeneratedAssetNotFoundError) if the job has not succeeded yet.",
  parameters: InspectGenerationInput,
  success: GeneratedAsset,
  failure: GenerationToolError,
  dependencies,
})
  .annotate(Tool.Title, "Inspect a generated asset")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

/** Increment 2a: takes a succeeded `GeneratedAsset` and lands it in the
 * caller's Unity project as textured, ready-to-use FBX geometry — a fifth
 * generation tool, declarative like its three `GenerationStandardToolkit`
 * siblings (unlike `InspectGenerationTool`, its result carries no image
 * content block, so it needs no manual `McpHttpServer.ts` registration —
 * see `importGeneratedAssetDependencies`'s own comment for how its Unity/
 * Tripo runtime dependencies stay off this tool's declared surface). */
export const ImportGeneratedAssetTool = Tool.make("import_generated_asset", {
  description:
    "Import a succeeded generated 3D asset into the caller's Unity project: FBX geometry + a URP material wired from the GLB's baseColor/normal PBR textures. Requires a live, matched Unity Editor already open for this project (does not cold-start one). Fails with UnityEditorNotReadyError if none is open, GeneratedAssetNotFoundError for an unknown/wrong-project assetId.",
  parameters: ImportGeneratedAssetInput,
  success: ImportGeneratedAssetResult,
  failure: GenerationToolError,
  dependencies: importGeneratedAssetDependencies,
})
  .annotate(Tool.Title, "Import a generated asset into Unity")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const GenerationStandardToolkit = Toolkit.make(
  Generate3dTool,
  GenerationStatusTool,
  ListGenerationsTool,
  ImportGeneratedAssetTool,
);

export const GenerationInspectToolkit = Toolkit.make(InspectGenerationTool);

export const GenerationToolkit = Toolkit.make(
  Generate3dTool,
  GenerationStatusTool,
  ListGenerationsTool,
  ImportGeneratedAssetTool,
  InspectGenerationTool,
);
