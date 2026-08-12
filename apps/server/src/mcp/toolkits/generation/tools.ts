import {
  Generate3dInput,
  Generate3dResult,
  GenerationJob,
  GenerationStatusInput,
  GenerationToolError,
  GeneratedAsset,
  InspectGenerationInput,
  ListGenerationsInput,
  ListGenerationsResult,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as GenerationService from "../../../generation/GenerationService.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  GenerationService.GenerationService,
  ProjectionSnapshotQuery.ProjectionSnapshotQuery,
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

export const GenerationStandardToolkit = Toolkit.make(
  Generate3dTool,
  GenerationStatusTool,
  ListGenerationsTool,
);

export const GenerationInspectToolkit = Toolkit.make(InspectGenerationTool);

export const GenerationToolkit = Toolkit.make(
  Generate3dTool,
  GenerationStatusTool,
  ListGenerationsTool,
  InspectGenerationTool,
);
