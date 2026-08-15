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

/** #155-B: a bare `Schema.Struct({})` (zero property signatures, zero index
 * signatures) hits Effect's "vacuous empty object" branch in its JSON Schema
 * converter (`toJsonSchemaDocument.ts`'s `Objects` case), which emits
 * `{anyOf:[{type:"object"},{type:"array"}]}` — no top-level `type` at all.
 * The `claude` CLI's MCP client validates `tools/list` results with a
 * schema requiring literal `inputSchema.type === "object"`, so that one
 * malformed schema (tools.16, this tool — the ONLY bare-empty struct among
 * the 19 devgame tools) fails the ENTIRE array and the CLI registers ZERO
 * tools (see docs/v2/specs/increment-155-B-empty-schema-fix.md).
 *
 * `StructWithRest` + a `Record(String, Never)` sibling gives the AST a
 * (vacuous) index signature, so the converter instead takes its normal
 * "Objects" branch and emits `{type:"object",additionalProperties:false}` —
 * a real MCP object schema. The `Record<string, never>` intersected member
 * accepts no keys, so decode/encode behavior (and the tool's genuinely
 * no-arg contract — no fake user-facing parameter for the model to fill) is
 * unchanged: `{}` still decodes, any stray key is still rejected. */
export const ListGenerationsInput = Schema.StructWithRest(Schema.Struct({}), [
  Schema.Record(Schema.String, Schema.Never),
]);
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
// `import_generated_asset` — Increment 2a
// (docs/v2/specs/increment-2a-import-generated-asset.md). Lands a succeeded
// GeneratedAsset in the caller's Unity project as FBX geometry + a URP
// material wired from the GLB's PBR textures. `assetPath`/`materialPath`/
// `textures[role]` are UNITY-SIDE `Assets/...`-relative paths (never
// server-state filesystem paths) — deliberately not the redaction-needing
// shape `GeneratedAsset.files.glb` is (see handlers.ts's
// `toClientSafeGeneratedAsset`); a Unity asset path is meant to be read by
// the caller, not scrubbed.
// ---------------------------------------------------------------------------

export const ImportGeneratedAssetInput = Schema.Struct({
  assetId: GeneratedAssetId,
});
export type ImportGeneratedAssetInput = typeof ImportGeneratedAssetInput.Type;

export const ImportGeneratedAssetTextures = Schema.Struct({
  baseColor: Schema.String,
  metallicRoughness: Schema.String,
  normal: Schema.String,
});
export type ImportGeneratedAssetTextures = typeof ImportGeneratedAssetTextures.Type;

/** Read post-import, from Unity's own perspective (via the D1 read-only
 * eval) — deliberately NOT copied from `GeneratedAsset.metadata`, which is
 * the server's own glTF-level count computed BEFORE the FBX conversion and
 * Unity import; the two are expected to be close but are not guaranteed
 * identical. */
export const ImportGeneratedAssetUnityStats = Schema.Struct({
  triangles: NonNegativeInt,
  materials: NonNegativeInt,
});
export type ImportGeneratedAssetUnityStats = typeof ImportGeneratedAssetUnityStats.Type;

export const ImportGeneratedAssetResult = Schema.Struct({
  assetPath: Schema.String,
  materialPath: Schema.String,
  textures: ImportGeneratedAssetTextures,
  unityStats: ImportGeneratedAssetUnityStats,
  /** Literal `true` — this increment always binds real PBR textures (never
   * a bare/untextured import); see the spec's Scope (OUT) for why a
   * texture-less import path isn't offered. */
  texturesCarried: Schema.Literal(true),
});
export type ImportGeneratedAssetResult = typeof ImportGeneratedAssetResult.Type;

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

/** `import_generated_asset`'s projectId → workspaceRoot resolution
 * failure — the `getProjectShellById` counterpart to
 * `GenerationProjectResolutionError`'s `getThreadShellById` (different
 * lookup, different key), never reused for a threadId failure and vice
 * versa so a client can always tell which id was the problem. */
export class UnityWorkspaceResolutionError extends Schema.TaggedErrorClass<UnityWorkspaceResolutionError>()(
  "UnityWorkspaceResolutionError",
  { projectId: ProjectId, detail: Schema.String },
) {
  override get message(): string {
    return `Could not resolve a Unity project workspace for ${this.projectId}: ${this.detail}`;
  }
}

/** Spec's "Require a LIVE matched Unity editor for the project... No editor
 * → clean typed error telling the user to open Unity (do NOT cold-start)."
 * Folds `notReady`/`cliUnavailable`/a pre-sequence `error` from
 * `UnityPipelineClient.status` into one client-facing shape — from the
 * caller's perspective all three mean the same thing: nothing to import
 * into yet, go make Unity ready. `reason` carries the underlying
 * classification for debugging, never surfaced as a distinct error type. */
export class UnityEditorNotReadyError extends Schema.TaggedErrorClass<UnityEditorNotReadyError>()(
  "UnityEditorNotReadyError",
  { projectId: ProjectId, reason: Schema.String },
) {
  override get message(): string {
    return `No live Unity Editor is open for this project. Open Unity with this project, then try again. (${this.reason})`;
  }
}

/** Anything that goes wrong AFTER the editor-liveness precondition already
 * passed: an FBX derive/texture-extraction failure, or any one of the
 * `import_asset`/`set_import_settings`/`eval` commands in the drive
 * sequence failing or returning an unrecognised shape. `step` names which
 * stage failed (`derive_fbx`, `extract_textures`, `import_model`,
 * `import_base_color`, `import_metallic_roughness`, `import_normal`,
 * `set_normal_import_type`, `bind_material`, `read_stats`) — one error
 * shape for the whole sequence rather than one class per step, since a
 * caller's useful response ("something in the Unity import failed, here's
 * where and why") is the same regardless of which step it was. */
export class UnityImportFailedError extends Schema.TaggedErrorClass<UnityImportFailedError>()(
  "UnityImportFailedError",
  { assetId: GeneratedAssetId, step: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `Unity import failed at step "${this.step}": ${this.detail}`;
  }
}

export const GenerationToolError = Schema.Union([
  GenerationCapabilityUnavailableError,
  GenerationJobNotFoundError,
  GeneratedAssetNotFoundError,
  GenerationProjectResolutionError,
  UnityWorkspaceResolutionError,
  UnityEditorNotReadyError,
  UnityImportFailedError,
]);
export type GenerationToolError = typeof GenerationToolError.Type;

// ---------------------------------------------------------------------------
// `GET /generation/list` — Increment 2b.1
// (docs/v2/specs/increment-2b1-generation-panel.md). The HUMAN half of the
// generation loop: a browser-facing, read-only, project-scoped list of jobs
// + their finished assets, mirroring `unitySetup.ts`'s own
// `UnitySetupProbeInput`/`Result`/`_PATH` trio shape (opaque `projectId` in,
// a success-or-typed-error union out, the path constant kept alongside the
// schemas it belongs to).
// ---------------------------------------------------------------------------

/** The client supplies only the opaque, server-issued project id it already
 * holds — same posture as `UnitySetupProbeInput`. */
export const GenerationListInput = Schema.Struct({ projectId: ProjectId });
export type GenerationListInput = typeof GenerationListInput.Type;

/** One row the panel renders: a job, plus its asset once one exists.
 * `asset`/`previewMediaUrl` are both `null` together until the job succeeds
 * — never independently, since a `previewMediaUrl` with no `asset` would be
 * meaningless and an `asset` with no `previewMediaUrl` just means Tripo
 * returned no preview image (`GeneratedAsset.preview.imageUrl` was already
 * `null` before this route ever ran). `asset` is `GeneratedAsset` as
 * returned by `toClientSafeGeneratedAsset` (handlers.ts) — `files.glb` is
 * already the redacted relative form, never the absolute server path — the
 * SAME redaction the `inspect_generation` MCP tool applies, reused rather
 * than reimplemented. `previewMediaUrl` is a signed, time-limited URL onto
 * `GET /api/generation-assets/*` (`GenerationAssetRoute.ts`) — this
 * increment's panel renders only the thumbnail; a `glbMediaUrl` sibling is
 * deliberately NOT included here (nothing in scope renders a GLB — the
 * viewer is a 2b.2+ slice per the spec's Scope (OUT)), even though the
 * underlying signed-URL route itself supports a `"glb"` kind generically for
 * that later slice. */
export const GenerationListEntry = Schema.Struct({
  job: GenerationJob,
  asset: Schema.NullOr(GeneratedAsset),
  previewMediaUrl: Schema.NullOr(Schema.String),
});
export type GenerationListEntry = typeof GenerationListEntry.Type;

export const GenerationListSuccess = Schema.Struct({
  entries: Schema.Array(GenerationListEntry),
});
export type GenerationListSuccess = typeof GenerationListSuccess.Type;

/** A successful list, or an honest typed failure to resolve the opaque
 * project id — same union shape as `UnitySetupProbeResult`. */
export const GenerationListResult = Schema.Union([
  GenerationListSuccess,
  Schema.TaggedStruct("error", { message: Schema.String }),
]);
export type GenerationListResult = typeof GenerationListResult.Type;

/** Kept alongside the schema so the one client call site and the one server
 * route definition both import a single literal — same convention as
 * `UNITY_SETUP_PROBE_PATH`. */
export const GENERATION_LIST_PATH = "/generation/list";
