import {
  GeneratedAssetNotFoundError,
  GenerationCapabilityUnavailableError,
  GenerationJobNotFoundError,
  GenerationProjectResolutionError,
  UnityEditorNotReadyError,
  UnityImportFailedError,
  UnityWorkspaceResolutionError,
  type Generate3dInput,
  type GeneratedAsset,
  type GenerationStatusInput,
  type ImportGeneratedAssetInput,
  type ImportGeneratedAssetResult,
  type InspectGenerationInput,
  type ListGenerationsInput,
} from "@t3tools/contracts";
import type { GeneratedAssetId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as NodeOS from "node:os";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../../config.ts";
import * as GenerationService from "../../../generation/GenerationService.ts";
import { type GlbTextureFiles, writeGlbTextures } from "../../../generation/glbTextures.ts";
import { Model3dProvider } from "../../../generation/providers/Model3dProvider.ts";
import * as TripoProvider from "../../../generation/providers/TripoProvider.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProcessRunner from "../../../processRunner.ts";
import * as UnityPipelineClient from "../../../unity/UnityPipelineClient.ts";
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

// ---------------------------------------------------------------------------
// import_generated_asset — Increment 2a
// (docs/v2/specs/increment-2a-import-generated-asset.md).
// ---------------------------------------------------------------------------

/** Every asset this tool lands in Unity goes under one fixed, predictable
 * subtree — never a path built from prompt text or any other agent/user
 * input (`assetId` is a server-minted `asset_<uuid>`, GenerationService.ts's
 * own `crypto.randomUUIDv4`-derived id). This is the same fixed-path
 * posture the material-bind write-eval's own injection guard relies on
 * (see `buildMaterialBindEval`'s doc comment) — the two are one guard,
 * applied at two boundaries (filesystem, C# string). */
const UNITY_IMPORT_ASSET_DIR_PREFIX = "Assets/DevGame";

const MANIFEST_FILE_NAME = "unity-import-manifest.json";

/** Matches `GenerationService.ts`'s own GLB cap (`DEFAULT_maxGlbBytes`) —
 * a derived FBX is the same order of magnitude as the GLB it came from, so
 * the identical ceiling is the right default, not a new number invented
 * for this file. */
const MAX_FBX_BYTES = 100 * 1_024 * 1_024;

export class FbxDownloadTooLargeError extends Schema.TaggedErrorClass<FbxDownloadTooLargeError>()(
  "FbxDownloadTooLargeError",
  { byteLength: Schema.Number, maxBytes: Schema.Number },
) {
  override get message(): string {
    return `Derived FBX was ${this.byteLength} bytes, exceeding the ${this.maxBytes}-byte cap.`;
  }
}

/** Mirrors `GenerationService.ts`'s own GLB download (cap BEFORE buffering
 * where declared, cap the actual buffer regardless — `content-length` is
 * advisory) for the SAME reason: a hostile/misbehaving response must never
 * OOM the process. Kept local rather than extracted into a shared helper —
 * this increment's "new files over hot-file edits" doctrine names
 * GenerationService.ts as off-limits, and one download helper is a small
 * enough duplication to accept over widening that file's edit surface.
 *
 * `maxBytes` defaults to `MAX_FBX_BYTES` (100MB) — overridable (fix round
 * finding #7) purely so tests can exercise BOTH the header-based and the
 * post-buffer cap paths against a small, fast real response instead of
 * needing to actually transfer 100MB in a unit test. Exported for the
 * same reason `buildMaterialBindEval`/`buildStatsEval` are: direct
 * unit-testability without standing up the full `import_generated_asset`
 * sequence.
 */
export const downloadFbx = (
  httpClient: HttpClient.HttpClient,
  fbxUrl: string,
  maxBytes: number = MAX_FBX_BYTES,
) =>
  HttpClientRequest.get(fbxUrl).pipe(
    httpClient.execute,
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => {
      const declaredLength = Number(response.headers["content-length"]);
      return Number.isFinite(declaredLength) && declaredLength > maxBytes
        ? Effect.fail(new FbxDownloadTooLargeError({ byteLength: declaredLength, maxBytes }))
        : Effect.succeed(response);
    }),
    Effect.flatMap((response) => response.arrayBuffer),
    Effect.map((buffer) => new Uint8Array(buffer)),
    Effect.flatMap((bytes) =>
      bytes.length > maxBytes
        ? Effect.fail(new FbxDownloadTooLargeError({ byteLength: bytes.length, maxBytes }))
        : Effect.succeed(bytes),
    ),
  );

/** The on-disk cache record for one asset's derived FBX + extracted
 * textures — written once after the first successful derive/extract,
 * reused by later `import_generated_asset` calls for the SAME asset so a
 * re-import (or a second engine/project importing the same generated
 * asset) never re-spends a Tripo `convert_model` call or re-parses the
 * GLB. Lives as a sibling file next to `model.glb`, inside the SAME
 * project-scoped asset dir `GenerationService.ts` already created — no
 * edit to that file needed to give this tool "cached on the asset"
 * semantics; the asset's own directory IS the cache. */
interface ImportedDerivedFiles {
  readonly fbxPath: string;
  readonly textures: GlbTextureFiles;
}

function isImportedDerivedFiles(value: unknown): value is ImportedDerivedFiles {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.fbxPath !== "string") return false;
  if (typeof record.textures !== "object" || record.textures === null) return false;
  const textures = record.textures as Record<string, unknown>;
  return (
    typeof textures.baseColor === "string" &&
    typeof textures.metallicRoughness === "string" &&
    typeof textures.normal === "string"
  );
}

/** `Option.none` on ANYTHING short of a clean cache hit — no manifest yet,
 * unparseable JSON, an unrecognised shape (a future field rename), or ANY
 * one of the four referenced files missing from disk (state dir pruning,
 * manual cleanup) — so a stale or partial manifest degrades to a full
 * re-derive rather than handing back a path to a file that no longer
 * exists. Never fails: any read/parse problem is itself a cache miss. */
const readCachedImport = (
  fileSystem: FileSystem.FileSystem,
  manifestPath: string,
): Effect.Effect<Option.Option<ImportedDerivedFiles>> =>
  fileSystem.readFileString(manifestPath).pipe(
    Effect.map((raw): ImportedDerivedFiles | null => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return null;
      }
      return isImportedDerivedFiles(parsed) ? parsed : null;
    }),
    Effect.flatMap((manifest) =>
      manifest === null
        ? Effect.succeed(Option.none<ImportedDerivedFiles>())
        : Effect.all([
            fileSystem.exists(manifest.fbxPath),
            fileSystem.exists(manifest.textures.baseColor),
            fileSystem.exists(manifest.textures.metallicRoughness),
            fileSystem.exists(manifest.textures.normal),
          ]).pipe(
            Effect.map(([fbxExists, baseColorExists, metallicRoughnessExists, normalExists]) =>
              fbxExists && baseColorExists && metallicRoughnessExists && normalExists
                ? Option.some(manifest)
                : Option.none<ImportedDerivedFiles>(),
            ),
          ),
    ),
    Effect.orElseSucceed(() => Option.none<ImportedDerivedFiles>()),
  );

/** Best-effort: a failed manifest WRITE never fails an otherwise-successful
 * derive/extract — the asset was still derived and imported correctly;
 * the next call simply re-derives, paying the same cost a first call
 * always pays anyway. */
const writeCachedImport = (
  fileSystem: FileSystem.FileSystem,
  manifestPath: string,
  manifest: ImportedDerivedFiles,
) =>
  fileSystem
    .writeFileString(manifestPath, JSON.stringify(manifest))
    .pipe(Effect.orElseSucceed(() => undefined));

/** Fix round finding #4 (info leak — the established "#76 scrub at the
 * single funnel" pattern; same technique as `GenerationService.ts`'s own
 * private `scrubAbsolutePaths`, which is not exported, so this is a local
 * equivalent rather than an edit to that file). Replaces every occurrence
 * of a known absolute-path root with an opaque placeholder; never throws
 * on unexpected input. */
const scrubAbsolutePathsForClient = (message: string, roots: ReadonlyArray<string>): string => {
  let scrubbed = message;
  for (const root of roots) {
    if (root.length === 0) continue;
    scrubbed = scrubbed.split(root).join("<redacted>");
  }
  return scrubbed;
};

/** Derives the FBX (Tripo `convert_model`, already implemented in
 * `TripoProvider.ts`) and extracts the three PBR textures from the
 * asset's own GLB, writing both under the asset's existing server-side
 * dir and recording a cache manifest for next time. Every failure here
 * translates to `UnityImportFailedError` at the step it happened —
 * `derive_fbx` covers the Tripo submit/poll + the FBX download + write;
 * `extract_textures` covers the GLB re-read + `writeGlbTextures`. Some of
 * these (`String(platformError)`, a `writeGlbTextures` `PlatformError`)
 * embed the FULL absolute path they operated on — `deriveAndCacheImportFiles`
 * below is the single funnel that scrubs every one of them before this
 * client-facing error ever leaves the process; see its own doc comment. */
const deriveAndCacheImportFilesUnscrubbed = Effect.fn(
  "GenerationToolkit.deriveAndCacheImportFilesUnscrubbed",
)(function* (input: {
  readonly assetId: GeneratedAssetId;
  readonly providerTaskId: string;
  readonly glbPath: string;
  readonly serverAssetDir: string;
  readonly manifestPath: string;
}) {
  const model3dProvider = yield* Model3dProvider;
  const httpClient = yield* HttpClient.HttpClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const fbxSubmission = yield* model3dProvider.deriveFbx(input.providerTaskId).pipe(
    Effect.mapError(
      (error) =>
        new UnityImportFailedError({
          assetId: input.assetId,
          step: "derive_fbx",
          detail: error.detail,
        }),
    ),
  );
  const fbxBytes = yield* downloadFbx(httpClient, fbxSubmission.fbxUrl).pipe(
    Effect.mapError(
      (error) =>
        new UnityImportFailedError({
          assetId: input.assetId,
          step: "derive_fbx",
          detail: error.message,
        }),
    ),
  );
  const fbxPath = path.join(input.serverAssetDir, "model.fbx");
  yield* fileSystem.writeFile(fbxPath, fbxBytes).pipe(
    Effect.mapError(
      (error) =>
        new UnityImportFailedError({
          assetId: input.assetId,
          step: "derive_fbx",
          detail: String(error),
        }),
    ),
  );

  const glbBytes = yield* fileSystem.readFile(input.glbPath).pipe(
    Effect.mapError(
      (error) =>
        new UnityImportFailedError({
          assetId: input.assetId,
          step: "extract_textures",
          detail: String(error),
        }),
    ),
  );
  const textures = yield* writeGlbTextures(
    glbBytes,
    path.join(input.serverAssetDir, "textures"),
  ).pipe(
    // `writeGlbTextures`'s error channel is `GlbTextureExtractionError |
    // PlatformError` (the parse can fail typed; the directory-create/
    // file-write calls inside it can fail with a platform error) — only
    // the former has `.detail`, so `String(error)` is the one
    // description that works for both without a type guard.
    Effect.mapError(
      (error) =>
        new UnityImportFailedError({
          assetId: input.assetId,
          step: "extract_textures",
          detail: String(error),
        }),
    ),
  );

  const manifest: ImportedDerivedFiles = { fbxPath, textures };
  yield* writeCachedImport(fileSystem, input.manifestPath, manifest);
  return manifest;
});

/** The single funnel: runs `deriveAndCacheImportFilesUnscrubbed` and, on
 * failure, rebuilds its `UnityImportFailedError` with `.detail` scrubbed
 * of this machine's state dir and home directory — the SAME two roots
 * `GenerationService.ts`'s own `scrubAbsolutePaths` redacts, in the SAME
 * "tighter root first, broader net second" order (its own doc comment).
 * Every caller of the derive/extract step goes through THIS export, never
 * the unscrubbed one directly, so a new failure site added inside it can
 * never forget the scrub. */
const deriveAndCacheImportFiles = (input: {
  readonly assetId: GeneratedAssetId;
  readonly providerTaskId: string;
  readonly glbPath: string;
  readonly serverAssetDir: string;
  readonly manifestPath: string;
}) =>
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig.ServerConfig;
    const redactedPathRoots = [serverConfig.stateDir, NodeOS.homedir()];
    return yield* deriveAndCacheImportFilesUnscrubbed(input).pipe(
      Effect.mapError(
        (error) =>
          new UnityImportFailedError({
            assetId: error.assetId,
            step: error.step,
            detail: scrubAbsolutePathsForClient(error.detail, redactedPathRoots),
          }),
      ),
    );
  });

/**
 * Builds the fixed material-bind write-eval (spec's "proven material
 * recipe", OWNER_DOCKET.md's D1 write-eval approval). INJECTION GUARD:
 * every interpolated value below is a path THIS TOOL derived —
 * `UNITY_IMPORT_ASSET_DIR_PREFIX` (a literal), `input.assetId` (a
 * server-minted `asset_<uuid>`, never agent/user free text — see
 * `UNITY_IMPORT_ASSET_DIR_PREFIX`'s own doc comment), and file
 * EXTENSIONS drawn only from `glbTextures.ts`'s two-entry
 * `EXTENSION_BY_MIME_TYPE` allowlist (`jpg`/`png`). NOTHING here is a
 * generation prompt, a tool-caller argument, or any other untrusted
 * string. The C# BODY itself never varies between calls — only these
 * five path leaves do.
 *
 * Exported (fix round finding #2) so handlers.test.ts can assert the
 * exact rendered output — the ordered-sequence test only checked WHICH
 * Unity commands ran, never WHAT the two eval payloads actually
 * contained, leaving this injection guard itself untested.
 */
export function buildMaterialBindEval(paths: {
  readonly modelAssetPath: string;
  readonly baseColorAssetPath: string;
  readonly normalAssetPath: string;
  readonly materialAssetPath: string;
}): string {
  return [
    `var baseColorTex = UnityEditor.AssetDatabase.LoadAssetAtPath<UnityEngine.Texture2D>("${paths.baseColorAssetPath}");`,
    `var normalTex = UnityEditor.AssetDatabase.LoadAssetAtPath<UnityEngine.Texture2D>("${paths.normalAssetPath}");`,
    `var shader = UnityEngine.Shader.Find("Universal Render Pipeline/Lit") ?? UnityEngine.Shader.Find("Standard");`,
    `var mat = new UnityEngine.Material(shader);`,
    `if (mat.HasProperty("_BaseMap")) mat.SetTexture("_BaseMap", baseColorTex);`,
    `if (mat.HasProperty("_MainTex")) mat.SetTexture("_MainTex", baseColorTex);`,
    `if (mat.HasProperty("_BumpMap")) { mat.SetTexture("_BumpMap", normalTex); mat.EnableKeyword("_NORMALMAP"); }`,
    `if (mat.HasProperty("_Metallic")) mat.SetFloat("_Metallic", 0f);`,
    `if (mat.HasProperty("_Smoothness")) mat.SetFloat("_Smoothness", 0.25f);`,
    `if (mat.HasProperty("_Glossiness")) mat.SetFloat("_Glossiness", 0.25f);`,
    `UnityEditor.AssetDatabase.CreateAsset(mat, "${paths.materialAssetPath}");`,
    `var modelGo = UnityEditor.AssetDatabase.LoadAssetAtPath<UnityEngine.GameObject>("${paths.modelAssetPath}");`,
    `var renderers = modelGo.GetComponentsInChildren<UnityEngine.Renderer>(true);`,
    `foreach (var renderer in renderers) {`,
    `    var shared = new UnityEngine.Material[renderer.sharedMaterials.Length == 0 ? 1 : renderer.sharedMaterials.Length];`,
    `    for (int i = 0; i < shared.Length; i++) shared[i] = mat;`,
    `    renderer.sharedMaterials = shared;`,
    `}`,
    `UnityEditor.AssetDatabase.SaveAssets();`,
    `UnityEditor.AssetDatabase.Refresh();`,
    `return new { materialPath = "${paths.materialAssetPath}", rendererCount = renderers.Length };`,
  ].join("\n");
}

/** The stats read-eval (D1's original read-only allowance) — reports
 * Unity's OWN post-import/post-bind facts, deliberately not a copy of
 * `GeneratedAsset.metadata`'s server-side glTF-level count (see
 * `ImportGeneratedAssetUnityStats`'s doc comment in contracts). Same
 * injection posture as `buildMaterialBindEval`: the only interpolated
 * value is a tool-derived path. Exported for the same test reason. */
export function buildStatsEval(modelAssetPath: string): string {
  return [
    `var modelGo = UnityEditor.AssetDatabase.LoadAssetAtPath<UnityEngine.GameObject>("${modelAssetPath}");`,
    `var meshFilters = modelGo.GetComponentsInChildren<UnityEngine.MeshFilter>(true);`,
    `int triangles = 0;`,
    `foreach (var meshFilter in meshFilters) { if (meshFilter.sharedMesh != null) triangles += meshFilter.sharedMesh.triangles.Length / 3; }`,
    `var renderers = modelGo.GetComponentsInChildren<UnityEngine.Renderer>(true);`,
    `var materials = new System.Collections.Generic.HashSet<UnityEngine.Material>();`,
    `foreach (var renderer in renderers) { foreach (var material in renderer.sharedMaterials) { if (material != null) materials.Add(material); } }`,
    `return new { triangles = triangles, materials = materials.Count };`,
  ].join("\n");
}

/** Folds `UnityPipelineClient`'s non-`ok` outcomes into one short, honest
 * reason string — the module doc comment's own "notReady covers BOTH no
 * Editor open AND mid domain-reload" framing applies here too: from
 * `import_generated_asset`'s caller's perspective, all three non-`ok`
 * tags mean the same actionable thing ("go make Unity ready"), so they
 * fold into ONE client-facing error (`UnityEditorNotReadyError`), with
 * this string kept only for the `reason` field's debugging value. */
function describeUnityNotReady(result: {
  readonly _tag: "notReady" | "cliUnavailable" | "error" | "ok";
  readonly message?: string;
}): string {
  switch (result._tag) {
    case "notReady":
      return "no live Pipeline connection for this project";
    case "cliUnavailable":
      return "the Unity CLI is not available on this machine";
    case "error":
      return result.message ?? "unknown Pipeline error";
    case "ok":
      return "editor is ready";
  }
}

/** Runs one `UnityPipelineClient` authoring command and folds a non-`ok`
 * result into `UnityImportFailedError` at the given `step` — the single
 * place every one of the five drive-sequence commands (import×4,
 * set-import-settings, the two evals) gets this translation, so the
 * sequence body itself reads as a plain list of steps. */
const runUnityStep = <A>(
  step: string,
  assetId: GeneratedAssetId,
  effect: Effect.Effect<UnityPipelineClient.UnityPipelineResult<A>>,
): Effect.Effect<A, InstanceType<typeof UnityImportFailedError>> =>
  effect.pipe(
    Effect.flatMap((result) =>
      result._tag === "ok"
        ? Effect.succeed(result.value)
        : Effect.fail(
            new UnityImportFailedError({ assetId, step, detail: describeUnityNotReady(result) }),
          ),
    ),
  );

function parseUnityStats(
  value: unknown,
): { readonly triangles: number; readonly materials: number } | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const { triangles, materials } = record;
  if (typeof triangles !== "number" || !Number.isInteger(triangles) || triangles < 0) return null;
  if (typeof materials !== "number" || !Number.isInteger(materials) || materials < 0) return null;
  return { triangles, materials };
}

/**
 * The core `import_generated_asset` handler — exported (same reasoning as
 * `generationStatus`/`inspectGeneration` above) so it is directly
 * unit-testable with a fake `Model3dProvider`/`UnityPipelineClient`,
 * without standing up real Tripo credentials or a real Unity Editor. The
 * `handlers` object below wraps this with a SELF-CONTAINED live
 * `Model3dProvider`/`UnityPipelineClient` layer
 * (`ImportGeneratedAssetRuntimeDependenciesLive`) before it joins the
 * declarative toolkit — see that constant's own comment for why.
 */
export const importGeneratedAsset = Effect.fn("GenerationToolkit.importGeneratedAsset")(function* (
  input: ImportGeneratedAssetInput,
): Effect.fn.Return<
  ImportGeneratedAssetResult,
  InstanceType<
    | typeof GenerationCapabilityUnavailableError
    | typeof GeneratedAssetNotFoundError
    | typeof GenerationProjectResolutionError
    | typeof UnityWorkspaceResolutionError
    | typeof UnityEditorNotReadyError
    | typeof UnityImportFailedError
  >,
  | McpInvocationContext.McpInvocationContext
  | GenerationService.GenerationService
  | ProjectionSnapshotQuery.ProjectionSnapshotQuery
  | FileSystem.FileSystem
  | Path.Path
  | Model3dProvider
  | UnityPipelineClient.UnityPipelineClient
  | HttpClient.HttpClient
  | ServerConfig.ServerConfig
> {
  const scope = yield* requireGenerationScope();
  const { projectId } = yield* resolveProjectContext(scope.threadId);
  const generationService = yield* GenerationService.GenerationService;

  const assetOption = yield* generationService.getAsset(input.assetId);
  if (Option.isNone(assetOption) || assetOption.value.projectId !== projectId) {
    // Merge-gate P1 #2's cross-project leak class, same as
    // generationStatus/inspectGeneration above: an assetId from another
    // project must read as not-found.
    return yield* new GeneratedAssetNotFoundError({ assetId: input.assetId });
  }
  const asset = assetOption.value;

  const snapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const projectShellOption = yield* snapshotQuery.getProjectShellById(projectId).pipe(
    Effect.mapError(
      (cause) =>
        new UnityWorkspaceResolutionError({
          projectId,
          detail: `lookup failed: ${String(cause)}`,
        }),
    ),
  );
  if (Option.isNone(projectShellOption)) {
    return yield* new UnityWorkspaceResolutionError({ projectId, detail: "project not found" });
  }
  const workspaceRoot = projectShellOption.value.workspaceRoot;

  // Spec: "Require a LIVE matched Unity editor for the project ... No
  // editor → clean typed error telling the user to open Unity (do NOT
  // cold-start)." `status` already scopes to this exact project via
  // `--project-path`, so an `ok` here IS "a live, matched Editor".
  const unityClient = yield* UnityPipelineClient.UnityPipelineClient;
  const statusResult = yield* unityClient.status(workspaceRoot);
  if (statusResult._tag !== "ok") {
    return yield* new UnityEditorNotReadyError({
      projectId,
      reason: describeUnityNotReady(statusResult),
    });
  }

  const jobOption = yield* generationService.getJob(asset.generationJobId);
  const providerTaskId = Option.isSome(jobOption) ? jobOption.value.providerTaskId : null;
  if (providerTaskId === null) {
    return yield* new UnityImportFailedError({
      assetId: input.assetId,
      step: "derive_fbx",
      detail: "the generation job has no provider task id to derive an FBX from",
    });
  }

  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverAssetDir = path.dirname(asset.files.glb);
  const manifestPath = path.join(serverAssetDir, MANIFEST_FILE_NAME);

  const cached = yield* readCachedImport(fileSystem, manifestPath);
  let derived: ImportedDerivedFiles;
  if (Option.isSome(cached)) {
    derived = cached.value;
  } else {
    derived = yield* deriveAndCacheImportFiles({
      assetId: input.assetId,
      providerTaskId,
      glbPath: asset.files.glb,
      serverAssetDir,
      manifestPath,
    });
  }

  const unityAssetDir = `${UNITY_IMPORT_ASSET_DIR_PREFIX}/${input.assetId}`;
  const modelAssetPath = `${unityAssetDir}/model.fbx`;
  const materialAssetPath = `${unityAssetDir}/material.mat`;
  const baseColorAssetPath = `${unityAssetDir}/baseColor${path.extname(derived.textures.baseColor)}`;
  const metallicRoughnessAssetPath = `${unityAssetDir}/metallicRoughness${path.extname(derived.textures.metallicRoughness)}`;
  const normalAssetPath = `${unityAssetDir}/normal${path.extname(derived.textures.normal)}`;

  // Import order matters (spec): textures before the material bind, the
  // normal texture retyped to NormalMap before it's read by the bind.
  yield* runUnityStep(
    "import_model",
    input.assetId,
    unityClient.importAsset(workspaceRoot, { source: derived.fbxPath, path: modelAssetPath }),
  );
  yield* runUnityStep(
    "import_base_color",
    input.assetId,
    unityClient.importAsset(workspaceRoot, {
      source: derived.textures.baseColor,
      path: baseColorAssetPath,
    }),
  );
  yield* runUnityStep(
    "import_metallic_roughness",
    input.assetId,
    unityClient.importAsset(workspaceRoot, {
      source: derived.textures.metallicRoughness,
      path: metallicRoughnessAssetPath,
    }),
  );
  yield* runUnityStep(
    "import_normal",
    input.assetId,
    unityClient.importAsset(workspaceRoot, {
      source: derived.textures.normal,
      path: normalAssetPath,
    }),
  );
  yield* runUnityStep(
    "set_normal_import_type",
    input.assetId,
    unityClient.setImportSettings(workspaceRoot, {
      asset: normalAssetPath,
      settings: { textureType: "NormalMap" },
    }),
  );
  yield* runUnityStep(
    "bind_material",
    input.assetId,
    unityClient.eval(
      workspaceRoot,
      buildMaterialBindEval({
        modelAssetPath,
        baseColorAssetPath,
        normalAssetPath,
        materialAssetPath,
      }),
    ),
  );
  const statsValue = yield* runUnityStep(
    "read_stats",
    input.assetId,
    unityClient.eval(workspaceRoot, buildStatsEval(modelAssetPath)),
  );
  const unityStats = parseUnityStats(statsValue);
  if (unityStats === null) {
    return yield* new UnityImportFailedError({
      assetId: input.assetId,
      step: "read_stats",
      detail: "eval returned an unrecognised result shape",
    });
  }

  return {
    assetPath: modelAssetPath,
    materialPath: materialAssetPath,
    textures: {
      baseColor: baseColorAssetPath,
      metallicRoughness: metallicRoughnessAssetPath,
      normal: normalAssetPath,
    },
    unityStats,
    texturesCarried: true as const,
  };
});

/** `import_generated_asset`'s SELF-CONTAINED runtime dependencies —
 * `Model3dProvider` (via `TripoProvider.layer`, the same provider
 * `GenerationServiceLive` builds in McpHttpServer.ts, but a SEPARATE
 * instance) and `UnityPipelineClient` (via its own `.layer`, the same
 * shell-out client `server.ts` builds for the HTTP routes, again a
 * separate instance). Built and discharged HERE, inside the toolkit's own
 * handler, rather than threaded through as declared `Tool.make`
 * dependencies (contrast `importGeneratedAssetDependencies` in tools.ts,
 * which lists only `FileSystem`/`Path`): a `dependencies` entry surfaces
 * as a residual requirement on `McpServer.toolkit(GenerationStandardToolkit)`
 * in McpHttpServer.ts (`Tool.HandlerServices`), and that file is NOT one
 * of this increment's sanctioned edits. Discharging both HERE means
 * `import_generated_asset`'s exported handler needs nothing beyond what
 * its three siblings already require, so it joins the existing toolkit
 * registration completely untouched. `FileSystem`/`Path`/`HttpClient`
 * (needed by BOTH of these layers' own construction, and by
 * `importGeneratedAsset` directly) are left bare/ambient — proven safe by
 * `GenerationServiceLive`'s own identical, already-working posture (see
 * tools.ts's `importGeneratedAssetDependencies` comment). */
const ImportGeneratedAssetRuntimeDependenciesLive = Layer.mergeAll(
  TripoProvider.layer,
  UnityPipelineClient.layer.pipe(Layer.provide(ProcessRunner.layer)),
);

const handlers = {
  generate_3d: generate3d,
  generation_status: generationStatus,
  list_generations: listGenerations,
  import_generated_asset: (input: ImportGeneratedAssetInput) =>
    importGeneratedAsset(input).pipe(Effect.provide(ImportGeneratedAssetRuntimeDependenciesLive)),
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
