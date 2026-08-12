/**
 * V2 Increment 1 — generation half contracts (fork-owned, entirely new).
 * docs/v2/specs/increment-1-generation-service.md is the frozen build
 * contract this file implements; docs/v2/GENERATION_ARCHITECTURE.md §5-§6
 * is the rationale for the minimum-viable shape (no cost/credits field, no
 * per-modality status enum, no giant GameAssetSpec — see that doc's
 * "Deliberately excluded" list).
 *
 * Deliberately NOT a vendor-union edit: nothing here widens
 * `packages/contracts/src/orchestration.ts`, `assets.ts`, or
 * `previewAutomation.ts`. `GenerationJob`/`GeneratedAsset` are new fork-owned
 * types, not variants bolted onto an existing closed union.
 */
import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "../baseSchemas.ts";
import { ProviderInstanceId } from "../providerInstance.ts";

// ---------------------------------------------------------------------------
// Ids — same `makeEntityId`-shaped brand baseSchemas.ts uses for
// ThreadId/ProjectId/SpaceId, restated here rather than imported: that
// helper is not exported, and duplicating a two-line brand is cheaper than
// widening baseSchemas.ts's own export surface for one fork-owned module.
// ---------------------------------------------------------------------------

export const GenerationJobId = TrimmedNonEmptyString.pipe(Schema.brand("GenerationJobId"));
export type GenerationJobId = typeof GenerationJobId.Type;

export const GeneratedAssetId = TrimmedNonEmptyString.pipe(Schema.brand("GeneratedAssetId"));
export type GeneratedAssetId = typeof GeneratedAssetId.Type;

// ---------------------------------------------------------------------------
// GenerationJob / GeneratedAsset — the spec's "minimum viable, no giant
// schemas" contract, verbatim from increment-1-generation-service.md.
// ---------------------------------------------------------------------------

/** One core status vocabulary (GENERATION_ARCHITECTURE.md §5's UNSLOTH §7
 * cautionary tale: never let per-modality detail invent a rival enum). */
export const GenerationStatus = Schema.Literals([
  "created",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
export type GenerationStatus = typeof GenerationStatus.Type;

/** Merge-gate P3 #12: bounded to a sane positive range (same
 * `Schema.Int.check(Schema.isBetween(...))` idiom `PortSchema` uses in
 * baseSchemas.ts) — 0/negative is nonsensical, and spike 0's own unbounded
 * default (501,146 triangles) is the concrete evidence for why an
 * unvalidated number here is worth guarding, not just theoretical. The
 * upper bound is a sanity ceiling, not a Tripo business rule — real jobs
 * use figures in the thousands (spike 1 used 6,000). */
export const FaceLimit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000_000 }));
export type FaceLimit = typeof FaceLimit.Type;

/** Provider-specific knobs, kept intentionally small — spec: `{ faceLimit?:
 * number; ... }`. Promote to a real type only when a second field is
 * needed (GENERATION_ARCHITECTURE.md §5's GameAssetSpec reasoning). */
export const GenerationParameters = Schema.Struct({
  faceLimit: Schema.optional(FaceLimit),
});
export type GenerationParameters = typeof GenerationParameters.Type;

export const GenerationJob = Schema.Struct({
  id: GenerationJobId,
  projectId: ProjectId,
  /** Who requested — REFERENCE, never ownership. Generation belongs to the
   * project (seams note §2.3, GENERATION_ARCHITECTURE.md §6.1). */
  threadId: ThreadId,
  modality: Schema.Literal("model3d"),
  provider: Schema.Literal("tripo"),
  providerTaskId: Schema.NullOr(Schema.String),
  status: GenerationStatus,
  progress: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  prompt: Schema.String,
  parameters: GenerationParameters,
  assetId: Schema.NullOr(GeneratedAssetId),
  error: Schema.NullOr(Schema.String),
  createdAt: Schema.Number,
  startedAt: Schema.NullOr(Schema.Number),
  completedAt: Schema.NullOr(Schema.Number),
});
export type GenerationJob = typeof GenerationJob.Type;

export const GeneratedAssetMetadata = Schema.Struct({
  triangles: NonNegativeInt,
  materials: NonNegativeInt,
  images: NonNegativeInt,
  boundsMeters: Schema.optional(Schema.Tuple([Schema.Number, Schema.Number, Schema.Number])),
  fileBytes: NonNegativeInt,
});
export type GeneratedAssetMetadata = typeof GeneratedAssetMetadata.Type;

export const GeneratedAsset = Schema.Struct({
  id: GeneratedAssetId,
  projectId: ProjectId,
  generationJobId: GenerationJobId,
  modality: Schema.Literal("model3d"),
  provider: Schema.Literal("tripo"),
  /** Absolute path under the generated dir — not a URL. */
  files: Schema.Struct({ glb: Schema.String }),
  /** Tripo's own signed `rendered_image` URL, passed through as-is. Serving
   * `files.glb` itself to a browser via a fork-owned signed route is
   * Increment 2's dock-panel concern (see this increment's report for why
   * it is deliberately not built here). */
  preview: Schema.Struct({ imageUrl: Schema.NullOr(Schema.String) }),
  metadata: GeneratedAssetMetadata,
  createdAt: Schema.Number,
});
export type GeneratedAsset = typeof GeneratedAsset.Type;

// ---------------------------------------------------------------------------
// MCP tool I/O — the four tools this increment ships.
// ---------------------------------------------------------------------------

export const Generate3dInput = Schema.Struct({
  prompt: TrimmedNonEmptyString,
  faceLimit: Schema.optional(FaceLimit),
});
export type Generate3dInput = typeof Generate3dInput.Type;

/** Literal, not `GenerationStatus` — the tool's async-model contract
 * (spec's "Async model (non-negotiable)") is always "I started this, come
 * check on it", independent of the job's true internal state the instant
 * this returns. */
export const Generate3dResult = Schema.Struct({
  jobId: GenerationJobId,
  status: Schema.Literal("running"),
});
export type Generate3dResult = typeof Generate3dResult.Type;

export const GenerationStatusInput = Schema.Struct({
  jobId: GenerationJobId,
});
export type GenerationStatusInput = typeof GenerationStatusInput.Type;

export const ListGenerationsInput = Schema.Struct({});
export type ListGenerationsInput = typeof ListGenerationsInput.Type;

export const ListGenerationsResult = Schema.Struct({
  jobs: Schema.Array(GenerationJob),
});
export type ListGenerationsResult = typeof ListGenerationsResult.Type;

export const InspectGenerationInput = Schema.Struct({
  jobId: Schema.optional(GenerationJobId),
  assetId: Schema.optional(GeneratedAssetId),
});
export type InspectGenerationInput = typeof InspectGenerationInput.Type;

// ---------------------------------------------------------------------------
// Errors — fork-owned, entirely new (never widens the vendor
// `PreviewAutomationError` union; see McpInvocationContext.ts's own comment
// on why a future generation toolkit does its own translation).
// ---------------------------------------------------------------------------

const generationErrorContext = {
  environmentId: EnvironmentId,
  threadId: ThreadId,
  providerSessionId: TrimmedNonEmptyString,
  providerInstanceId: ProviderInstanceId,
};

export class GenerationCapabilityUnavailableError extends Schema.TaggedErrorClass<GenerationCapabilityUnavailableError>()(
  "GenerationCapabilityUnavailableError",
  { ...generationErrorContext },
) {
  override get message(): string {
    return "MCP credential does not grant the generation capability.";
  }
}

export class GenerationJobNotFoundError extends Schema.TaggedErrorClass<GenerationJobNotFoundError>()(
  "GenerationJobNotFoundError",
  { jobId: GenerationJobId },
) {
  override get message(): string {
    return `No generation job found for id ${this.jobId}.`;
  }
}

export class GeneratedAssetNotFoundError extends Schema.TaggedErrorClass<GeneratedAssetNotFoundError>()(
  "GeneratedAssetNotFoundError",
  {
    jobId: Schema.optional(GenerationJobId),
    assetId: Schema.optional(GeneratedAssetId),
  },
) {
  override get message(): string {
    return "No generated asset found — the job may not have succeeded yet.";
  }
}

export class GenerationProjectResolutionError extends Schema.TaggedErrorClass<GenerationProjectResolutionError>()(
  "GenerationProjectResolutionError",
  { threadId: ThreadId, detail: Schema.String },
) {
  override get message(): string {
    return `Could not resolve a project for thread ${this.threadId}: ${this.detail}`;
  }
}

export const GenerationToolError = Schema.Union([
  GenerationCapabilityUnavailableError,
  GenerationJobNotFoundError,
  GeneratedAssetNotFoundError,
  GenerationProjectResolutionError,
]);
export type GenerationToolError = typeof GenerationToolError.Type;
