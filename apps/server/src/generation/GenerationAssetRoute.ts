/**
 * `GET /api/generation-assets/*` — the browser -> server leg for a
 * generated asset's preview thumbnail or (future, 2b.2+) raw GLB
 * (docs/v2/specs/increment-2b1-generation-panel.md, step 4). Verifies a
 * SIGNED claim minted by `GenerationAssetAccess.ts`'s
 * `issueGenerationAssetUrl` — never a client-supplied path — then resolves
 * the real file server-side. No bearer-scope check on this GET itself: the
 * signed token IS the authorization, the same posture `assets/AssetAccess.ts`
 * and its `assetRouteLayer` (http.ts) already use for browser-navigable
 * media (an `<img src>` cannot attach a bearer header) — the scope check
 * happens once, up front, at `GenerationListRoute.ts`'s `POST
 * /generation/list`, which is the only place a token is ever minted.
 *
 * `dispatchGenerationAsset` is exported and kept separate from the HTTP
 * wrapper below for the same reason `dispatchUnitySetupProbe` is: directly
 * unit-testable (tamper/expiry/foreign-project rejection, the preview
 * lazy-cache) without a real HTTP request.
 */
import type { GeneratedAsset } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as GenerationService from "./GenerationService.ts";
import {
  GENERATION_ASSET_ROUTE_PREFIX,
  verifyGenerationAssetToken,
  type GenerationAssetClaims,
} from "./GenerationAssetAccess.ts";

/** Merge-gate P1 #4's own cap on the generation toolkit's preview fetch
 * (`McpHttpServer.ts`'s private `MAX_PREVIEW_IMAGE_BYTES`) restated here —
 * a NEW file, its own local constant, same reasoning `handlers.ts`'s own
 * `downloadFbx` gives for duplicating `GenerationService.ts`'s GLB cap
 * rather than reaching into a file this increment doesn't touch: "a small
 * enough duplication to accept" over widening that file's export surface. */
const MAX_PREVIEW_IMAGE_BYTES = 20 * 1_024 * 1_024;

const DEFAULT_PREVIEW_CONTENT_TYPE = "image/png";
const EXTENSION_BY_CONTENT_TYPE: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

const PREVIEW_MANIFEST_FILE_NAME = "generation-preview-manifest.json";

/** This codebase's own Effect lint rule flags an untagged global `Error` in
 * the failure channel (`effect(globalErrorInEffectFailure)`) — same
 * `unitySetupProbeAtom.ts`/`GenerationService.ts` pattern applies here.
 * Both size-cap branches below fail with this rather than a bare `Error`;
 * `downloadAndCachePreview`'s own `Effect.orElseSucceed(() => null)`
 * degrades either one to a 404 anyway, so this type is never inspected by a
 * caller — it exists only to keep the failure channel typed. */
class PreviewImageTooLargeError extends Schema.TaggedErrorClass<PreviewImageTooLargeError>()(
  "PreviewImageTooLargeError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

/**
 * Fix round (adversarial review, MEDIUM security finding 3): a remote
 * (Tripo) response's `content-type` header was previously reflected
 * VERBATIM into both the cached manifest and the served `Content-Type`
 * header — a non-allowlisted value (e.g. a misbehaving/compromised CDN
 * returning `text/html`) would be CACHED and later SERVED, from this app's
 * OWN origin, as that exact type (with `nosniff`, so the browser trusts
 * it outright) — a stored content-injection primitive. This is the SAME
 * "only ever serve an allowlisted image/* type, never trust the remote's
 * own header" posture `assets/AssetAccess.ts`'s `PREVIEW_ASSET_EXTENSIONS`
 * allowlist already enforces for workspace-file extensions, applied here to
 * the CONTENT-TYPE dimension `downloadAndCachePreview` derives from an
 * external, untrusted response. */
class PreviewImageContentTypeNotAllowedError extends Schema.TaggedErrorClass<PreviewImageContentTypeNotAllowedError>()(
  "PreviewImageContentTypeNotAllowedError",
  { contentType: Schema.String },
) {
  override get message(): string {
    return `preview image content-type "${this.contentType}" is not an allowlisted image type`;
  }
}

/** The on-disk cache record for one asset's lazily-downloaded preview
 * image — same "small JSON sidecar next to the real file, re-derive on any
 * read/parse hiccup" idiom `handlers.ts`'s `ImportedDerivedFiles`/
 * `readCachedImport` already use for the FBX+textures cache, applied here
 * to the ONE fact a plain `fileSystem.exists(fixedName)` check can't carry:
 * which extension/content-type this asset's preview was actually saved
 * as (Tripo's real content-type is not guaranteed PNG — see
 * `McpHttpServer.ts`'s own `fetchPreviewImageBlock` comment on the same
 * point). */
interface CachedPreview {
  readonly fileName: string;
  readonly contentType: string;
}

function isCachedPreview(value: unknown): value is CachedPreview {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.fileName === "string" && typeof record.contentType === "string";
}

/** `Option.none` on anything short of a clean cache hit (missing manifest,
 * unparseable JSON, unrecognised shape, or the referenced file itself
 * missing) — mirrors `handlers.ts`'s `readCachedImport`: any read/parse
 * problem degrades to a cache miss (re-download) rather than failing the
 * request. Never fails. */
const readCachedPreview = (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  assetDir: string,
  manifestPath: string,
): Effect.Effect<Option.Option<CachedPreview>> =>
  fileSystem.readFileString(manifestPath).pipe(
    Effect.map((raw): CachedPreview | null => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return null;
      }
      return isCachedPreview(parsed) ? parsed : null;
    }),
    Effect.flatMap((manifest) =>
      manifest === null
        ? Effect.succeed(Option.none<CachedPreview>())
        : fileSystem
            .exists(path.join(assetDir, manifest.fileName))
            .pipe(
              Effect.map((exists) =>
                exists ? Option.some(manifest) : Option.none<CachedPreview>(),
              ),
            ),
    ),
    Effect.orElseSucceed(() => Option.none<CachedPreview>()),
  );

/** Best-effort: a failed manifest write never fails an otherwise-successful
 * download — the image is still on disk and servable this request; the
 * next request simply re-downloads, paying the same cost a first request
 * always pays. Mirrors `handlers.ts`'s `writeCachedImport`. */
const writeCachedPreview = (
  fileSystem: FileSystem.FileSystem,
  manifestPath: string,
  manifest: CachedPreview,
) =>
  fileSystem
    .writeFileString(manifestPath, JSON.stringify(manifest))
    .pipe(Effect.orElseSucceed(() => undefined));

/**
 * Downloads Tripo's `imageUrl` (a remote, TTL-limited CDN URL —
 * `GeneratedAsset.preview.imageUrl`'s own doc comment) into the asset's
 * server-side dir and records the cache manifest. Size-capped BEFORE
 * buffering where declared, and against the actual buffer regardless —
 * same two-step cap `GenerationService.ts`'s own GLB download and
 * `McpHttpServer.ts`'s own preview-image fetch both use, for the identical
 * reason (a hostile/misbehaving response must never OOM the process).
 * `Effect.orElseSucceed(() => null)` at the end: a failed download degrades
 * this ONE request to a 404, never a 500 — the asset and its GLB are still
 * real either way.
 */
const downloadAndCachePreview = (
  httpClient: HttpClient.HttpClient,
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  assetDir: string,
  manifestPath: string,
  imageUrl: string,
): Effect.Effect<{ readonly path: string; readonly contentType: string } | null> =>
  HttpClientRequest.get(imageUrl).pipe(
    httpClient.execute,
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => {
      const declaredLength = Number(response.headers["content-length"]);
      return Number.isFinite(declaredLength) && declaredLength > MAX_PREVIEW_IMAGE_BYTES
        ? Effect.fail(
            new PreviewImageTooLargeError({
              detail: `preview image declared ${declaredLength} bytes, exceeding the cap`,
            }),
          )
        : Effect.succeed(response);
    }),
    Effect.map((response) => ({
      response,
      contentType:
        (response.headers["content-type"] ?? DEFAULT_PREVIEW_CONTENT_TYPE).split(";")[0]?.trim() ||
        DEFAULT_PREVIEW_CONTENT_TYPE,
    })),
    // Clamp to the allowlist BEFORE buffering the body at all — a
    // non-image remote content-type is rejected outright, never cached or
    // served under any content-type (verbatim OR substituted): this is a
    // full download failure (degrading to 404 via the `orElseSucceed`
    // below), not merely a re-labeled success.
    Effect.flatMap(({ response, contentType }) =>
      contentType in EXTENSION_BY_CONTENT_TYPE
        ? Effect.succeed({ response, contentType })
        : Effect.fail(new PreviewImageContentTypeNotAllowedError({ contentType })),
    ),
    Effect.flatMap(({ response, contentType }) =>
      Effect.map(response.arrayBuffer, (buffer) => ({
        bytes: new Uint8Array(buffer),
        contentType,
      })),
    ),
    Effect.flatMap(({ bytes, contentType }) =>
      bytes.length > MAX_PREVIEW_IMAGE_BYTES
        ? Effect.fail(
            new PreviewImageTooLargeError({
              detail: `preview image was ${bytes.length} bytes, exceeding the cap`,
            }),
          )
        : Effect.succeed({ bytes, contentType }),
    ),
    Effect.flatMap(({ bytes, contentType }) => {
      // Safe: the allowlist check above guarantees `contentType` is a key
      // of this map by the time we reach here — no "bin" fallback needed
      // (an unreachable fallback would silently mask the guard failing to
      // do its job on some future edit).
      const extension = EXTENSION_BY_CONTENT_TYPE[contentType]!;
      const fileName = `preview.${extension}`;
      const filePath = path.join(assetDir, fileName);
      return fileSystem.writeFile(filePath, bytes).pipe(
        Effect.flatMap(() =>
          writeCachedPreview(fileSystem, manifestPath, { fileName, contentType }),
        ),
        Effect.as({ path: filePath, contentType }),
      );
    }),
    Effect.orElseSucceed(() => null),
  );

const resolveOrCachePreview = (
  asset: GeneratedAsset,
): Effect.Effect<
  { readonly path: string; readonly contentType: string } | null,
  never,
  FileSystem.FileSystem | Path.Path | HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    if (asset.preview.imageUrl === null) return null;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const httpClient = yield* HttpClient.HttpClient;
    // Server-known dir, never client input — same dir GenerationService.ts
    // already wrote `model.glb` into.
    const assetDir = path.dirname(asset.files.glb);
    const manifestPath = path.join(assetDir, PREVIEW_MANIFEST_FILE_NAME);
    const cached = yield* readCachedPreview(fileSystem, path, assetDir, manifestPath);
    if (Option.isSome(cached)) {
      return {
        path: path.join(assetDir, cached.value.fileName),
        contentType: cached.value.contentType,
      };
    }
    return yield* downloadAndCachePreview(
      httpClient,
      fileSystem,
      path,
      assetDir,
      manifestPath,
      asset.preview.imageUrl,
    );
  });

export type GenerationAssetDispatchOutcome =
  | { readonly _tag: "ok"; readonly path: string; readonly contentType: string }
  | { readonly _tag: "notFound" };

/**
 * The security-load-bearing core: verifies the signed token, then
 * RE-APPLIES the cross-project check against the asset's own real
 * `projectId` (`GenerationService.getAsset` is NOT project-scoped — same
 * merge-gate P1 #2 re-check every MCP handler in handlers.ts already does
 * by hand). A tampered signature, an unsigned token, an expired token, or a
 * claim whose `projectId` does not match the asset's real project all
 * collapse to the SAME `"notFound"` outcome — deliberately: telling a
 * caller WHICH check failed would leak whether an assetId exists at all.
 */
export const dispatchGenerationAsset = (
  token: string,
): Effect.Effect<
  GenerationAssetDispatchOutcome,
  never,
  | GenerationService.GenerationService
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
  | ServerSecretStore.ServerSecretStore
> =>
  Effect.gen(function* () {
    const claims = yield* verifyGenerationAssetToken(token);
    if (Option.isNone(claims)) return { _tag: "notFound" } as const;

    const generationService = yield* GenerationService.GenerationService;
    const assetOption = yield* generationService.getAsset(claims.value.assetId);
    if (Option.isNone(assetOption) || assetOption.value.projectId !== claims.value.projectId) {
      return { _tag: "notFound" } as const;
    }
    const asset = assetOption.value;

    if (claims.value.kind === "glb") {
      return { _tag: "ok", path: asset.files.glb, contentType: "model/gltf-binary" } as const;
    }

    const resolved = yield* resolveOrCachePreview(asset);
    return resolved === null
      ? ({ _tag: "notFound" } as const)
      : ({ _tag: "ok", path: resolved.path, contentType: resolved.contentType } as const);
  });

export const generationAssetRouteLayer = HttpRouter.add(
  "GET",
  `${GENERATION_ASSET_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }
    const token = url.value.pathname.slice(`${GENERATION_ASSET_ROUTE_PREFIX}/`.length);
    if (token.length === 0) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    const outcome = yield* dispatchGenerationAsset(token);
    if (outcome._tag === "notFound") {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    return yield* HttpServerResponse.file(outcome.path, {
      status: 200,
      headers: {
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
        "Content-Type": outcome.contentType,
      },
    }).pipe(
      Effect.orElseSucceed(() => HttpServerResponse.text("Internal Server Error", { status: 500 })),
    );
  }),
);

/** Re-exported for `GenerationListRoute.ts`'s convenience so it only ever
 * imports the claims type from ONE place. */
export type { GenerationAssetClaims };
