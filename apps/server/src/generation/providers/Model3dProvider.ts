/**
 * Provider boundary for 3D generation — one interface, provider-agnostic.
 * `TripoProvider.ts` is the only implementation this increment ships (spike
 * 0/1, docs/v2/SPIKE_RESULTS.md). `GenerationService` is the only consumer;
 * nothing above it ever imports a specific provider.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class Model3dProviderError extends Schema.TaggedErrorClass<Model3dProviderError>()(
  "Model3dProviderError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export interface Model3dSubmitInput {
  readonly prompt: string;
  readonly faceLimit?: number;
}

/**
 * Uniform poll result. `progress` is 0-100 per spike 0's measured Tripo
 * behavior (real, monotonic 6→9→…→100 — usable for a progress bar as-is,
 * no normalization needed).
 */
export type Model3dTaskState =
  | { readonly status: "queued" | "running"; readonly progress: number }
  | {
      readonly status: "success";
      readonly progress: 100;
      readonly modelUrl: string;
      readonly renderedImageUrl: string | null;
    }
  | { readonly status: "failed"; readonly detail: string };

export interface Model3dProviderShape {
  readonly submitTextTo3d: (
    input: Model3dSubmitInput,
  ) => Effect.Effect<{ readonly providerTaskId: string }, Model3dProviderError>;
  readonly pollTask: (
    providerTaskId: string,
  ) => Effect.Effect<Model3dTaskState, Model3dProviderError>;
  /**
   * Increment 2a consumes this (Unity needs FBX, not raw GLB — spike 1
   * finding: raw `.glb` imports as `DefaultAsset`, 0 meshes). Submits a
   * `convert_model` task AND polls it through to completion, returning the
   * finished FBX's URL — see `TripoProvider.ts`'s `deriveFbx`. Corrected
   * from this increment's original stub shape (`{ providerTaskId }`,
   * copy-pasted from `submitTextTo3d` before increment 2a's real
   * implementation existed to check it against) — the spec's "Complete
   * `deriveFbx`" step is explicit that this returns "the FBX url", not a
   * providerTaskId a caller would then have to poll separately.
   */
  readonly deriveFbx: (
    originalProviderTaskId: string,
  ) => Effect.Effect<{ readonly fbxUrl: string }, Model3dProviderError>;
}

export class Model3dProvider extends Context.Service<Model3dProvider, Model3dProviderShape>()(
  "t3/generation/providers/Model3dProvider",
) {}
