/**
 * Server-side GLB PBR texture extraction — Increment 2a
 * (docs/v2/specs/increment-2a-import-generated-asset.md), sibling to
 * glbInspect.ts. Spike 2 (docs/v2/SPIKE_RESULTS.md) proved a generated
 * barrel's single material carries three PBR texture roles this module
 * pulls out and persists as real files, in the order the Unity import step
 * needs them: baseColor, metallicRoughness (extracted but unused by this
 * increment's material bind — see the spec's fidelity follow-up), normal.
 *
 * The low-level glTF binary container parse (magic header + JSON chunk)
 * duplicates ~20 lines of glbInspect.ts's own parser rather than importing
 * a shared extraction from it: this increment's hard constraint list
 * (frozen spec + implementer handoff) enumerates the ONLY sanctioned
 * existing-file edits, and glbInspect.ts is not one of them. This module
 * also reads chunk1 (the binary buffer chunk), which glbInspect.ts
 * deliberately never touches (see its own module doc comment) — a second,
 * concrete reason this is a new file rather than a widened one.
 *
 * glTF 2.0 binary layout (little-endian throughout, see glbInspect.ts for
 * the fuller writeup):
 *   header:  magic "glTF" | version | length
 *   chunk0:  chunkLength | chunkType ("JSON") | chunkData
 *   chunk1:  chunkLength | chunkType ("BIN\0") | chunkData  ← read HERE
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const GLB_MAGIC = 0x46546c67; // "glTF" read as a little-endian uint32
const CHUNK_TYPE_JSON = 0x4e4f534a; // "JSON" read as a little-endian uint32
const CHUNK_TYPE_BIN = 0x004e4942; // "BIN\0" read as a little-endian uint32

export class GlbTextureExtractionError extends Schema.TaggedErrorClass<GlbTextureExtractionError>()(
  "GlbTextureExtractionError",
  { detail: Schema.String },
) {
  override get message(): string {
    return `Failed to extract GLB textures: ${this.detail}`;
  }
}

export type GlbTextureRole = "baseColor" | "metallicRoughness" | "normal";

/** `import_generated_asset`'s own required shape — exactly these three
 * roles, always present, never a partial map (see `extractGlbTextures`'s
 * doc comment for why a missing role fails the whole extraction). */
export interface GlbTextureFiles {
  readonly baseColor: string;
  readonly metallicRoughness: string;
  readonly normal: string;
}

const readUint32LE = (bytes: Uint8Array, offset: number): number =>
  bytes[offset]! |
  (bytes[offset + 1]! << 8) |
  (bytes[offset + 2]! << 16) |
  (bytes[offset + 3]! << 24);

// Only the fields this module actually reads — same "no giant schema"
// posture glbInspect.ts's own GltfDocument interface documents.
interface GltfTextureRef {
  readonly index: number;
}
interface GltfMaterial {
  readonly pbrMetallicRoughness?: {
    readonly baseColorTexture?: GltfTextureRef;
    readonly metallicRoughnessTexture?: GltfTextureRef;
  };
  readonly normalTexture?: GltfTextureRef;
}
interface GltfTexture {
  readonly source?: number;
}
interface GltfImage {
  readonly mimeType?: string;
  readonly bufferView?: number;
}
interface GltfBufferView {
  readonly byteOffset?: number;
  readonly byteLength: number;
}
interface GltfDocument {
  readonly materials?: ReadonlyArray<GltfMaterial>;
  readonly textures?: ReadonlyArray<GltfTexture>;
  readonly images?: ReadonlyArray<GltfImage>;
  readonly bufferViews?: ReadonlyArray<GltfBufferView>;
}

interface ParsedGlb {
  readonly document: GltfDocument;
  readonly binaryChunk: Uint8Array;
}

/** Parses the GLB container down to its JSON document AND its binary
 * buffer chunk (chunk1) — the one piece glbInspect.ts's own parser never
 * reads. Everything through the JSON chunk mirrors glbInspect.ts's
 * `inspectGlb` header validation exactly (same error conditions, same
 * messages), duplicated rather than imported per this file's module doc
 * comment. */
function parseGlbContainer(bytes: Uint8Array): ParsedGlb {
  if (bytes.length < 20) {
    throw new GlbTextureExtractionError({ detail: `file too small (${bytes.length} bytes)` });
  }
  if (readUint32LE(bytes, 0) !== GLB_MAGIC) {
    throw new GlbTextureExtractionError({ detail: "missing glTF magic header" });
  }
  const jsonChunkLength = readUint32LE(bytes, 12);
  if (readUint32LE(bytes, 16) !== CHUNK_TYPE_JSON) {
    throw new GlbTextureExtractionError({ detail: "first chunk is not JSON" });
  }
  const jsonStart = 20;
  const jsonEnd = jsonStart + jsonChunkLength;
  if (jsonEnd > bytes.length) {
    throw new GlbTextureExtractionError({ detail: "JSON chunk length exceeds file size" });
  }
  let document: GltfDocument;
  try {
    document = JSON.parse(
      new TextDecoder().decode(bytes.subarray(jsonStart, jsonEnd)),
    ) as GltfDocument;
  } catch (cause) {
    throw new GlbTextureExtractionError({ detail: `invalid JSON chunk: ${String(cause)}` });
  }

  const binHeaderStart = jsonEnd;
  if (binHeaderStart + 8 > bytes.length) {
    throw new GlbTextureExtractionError({
      detail: "GLB has no binary buffer chunk (textures cannot be extracted)",
    });
  }
  const binChunkLength = readUint32LE(bytes, binHeaderStart);
  const binChunkType = readUint32LE(bytes, binHeaderStart + 4);
  if (binChunkType !== CHUNK_TYPE_BIN) {
    throw new GlbTextureExtractionError({ detail: "second chunk is not the binary buffer" });
  }
  const binStart = binHeaderStart + 8;
  const binEnd = binStart + binChunkLength;
  if (binEnd > bytes.length) {
    throw new GlbTextureExtractionError({ detail: "binary chunk length exceeds file size" });
  }
  return { document, binaryChunk: bytes.subarray(binStart, binEnd) };
}

/** Real image formats Tripo's own exports use (spike 2: JPEG). PNG
 * accepted too — both are legal glTF embedded image mimeTypes — anything
 * else (a data-URI image, a KTX2 texture) fails cleanly rather than
 * guessing an extension. */
const EXTENSION_BY_MIME_TYPE: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
};

export interface ExtractedGlbTexture {
  readonly bytes: Uint8Array;
  readonly extension: string;
}

/** Resolves one PBR texture role through glTF's own indirection —
 * material.<field>.index (a TEXTURE index) → textures[].source (an IMAGE
 * index) → images[].bufferView → bufferViews[] → the real bytes inside the
 * binary chunk — the exact chain spike 2 walked by hand for one barrel,
 * generalized here for all three roles. Throws (not `Option.none`) on any
 * missing link: a generated asset missing baseColor or normal cannot be
 * bound to the URP material this tool builds, so a partial extraction is
 * never a useful result to hand back. */
function resolveTextureRole(
  role: GlbTextureRole,
  textureRef: GltfTextureRef | undefined,
  document: GltfDocument,
  binaryChunk: Uint8Array,
): ExtractedGlbTexture {
  if (textureRef === undefined) {
    throw new GlbTextureExtractionError({ detail: `material has no ${role} texture` });
  }
  const texture = document.textures?.[textureRef.index];
  if (texture === undefined || texture.source === undefined) {
    throw new GlbTextureExtractionError({
      detail: `${role} texture index ${textureRef.index} has no source image`,
    });
  }
  const image = document.images?.[texture.source];
  if (image === undefined || image.bufferView === undefined) {
    throw new GlbTextureExtractionError({
      detail: `${role} image index ${texture.source} has no bufferView (external URI images are not supported)`,
    });
  }
  const bufferView = document.bufferViews?.[image.bufferView];
  if (bufferView === undefined) {
    throw new GlbTextureExtractionError({
      detail: `${role} references missing bufferView ${image.bufferView}`,
    });
  }
  const extension =
    image.mimeType !== undefined ? EXTENSION_BY_MIME_TYPE[image.mimeType] : undefined;
  if (extension === undefined) {
    throw new GlbTextureExtractionError({
      detail: `${role} image has unsupported mimeType ${image.mimeType ?? "(none)"}`,
    });
  }
  const start = bufferView.byteOffset ?? 0;
  const end = start + bufferView.byteLength;
  if (end > binaryChunk.length) {
    throw new GlbTextureExtractionError({
      detail: `${role} bufferView range exceeds binary chunk size`,
    });
  }
  return { bytes: binaryChunk.subarray(start, end), extension };
}

/**
 * Parses a GLB's first material for its three PBR texture roles and
 * returns each role's raw image bytes + a file extension derived from its
 * mimeType. Pure and synchronous — same shape as glbInspect.ts's own
 * `inspectGlb` (throws `GlbTextureExtractionError`, no FileSystem access).
 * `writeGlbTextures` below is the thin Effect wrapper that persists the
 * bytes to disk.
 */
export function extractGlbTextures(bytes: Uint8Array): Record<GlbTextureRole, ExtractedGlbTexture> {
  const { document, binaryChunk } = parseGlbContainer(bytes);
  const material = document.materials?.[0];
  if (material === undefined) {
    throw new GlbTextureExtractionError({ detail: "GLB has no materials" });
  }
  return {
    baseColor: resolveTextureRole(
      "baseColor",
      material.pbrMetallicRoughness?.baseColorTexture,
      document,
      binaryChunk,
    ),
    metallicRoughness: resolveTextureRole(
      "metallicRoughness",
      material.pbrMetallicRoughness?.metallicRoughnessTexture,
      document,
      binaryChunk,
    ),
    normal: resolveTextureRole("normal", material.normalTexture, document, binaryChunk),
  };
}

/**
 * Extracts the three PBR texture roles from `glbBytes` and writes each to
 * `<destDir>/<role>.<ext>`, returning `{ role → absolute path }` — the
 * shape `import_generated_asset` hands to `UnityPipelineClient.importAsset`
 * for each texture, one at a time, in the order the material recipe needs
 * (normal imported+retyped before the material bind reads it).
 *
 * `destDir` is always the fixed, tool-controlled asset dir — never built
 * from agent/user input. This mirrors this increment's separate,
 * load-bearing injection guard for the C# material-bind snippet: nothing
 * here or there interpolates untrusted text into a filesystem or shell
 * boundary.
 */
export const writeGlbTextures = Effect.fn("glbTextures.writeGlbTextures")(function* (
  glbBytes: Uint8Array,
  destDir: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const extracted = yield* Effect.try({
    try: () => extractGlbTextures(glbBytes),
    catch: (cause) =>
      Schema.is(GlbTextureExtractionError)(cause)
        ? cause
        : new GlbTextureExtractionError({ detail: String(cause) }),
  });
  yield* fileSystem.makeDirectory(destDir, { recursive: true });

  const baseColorPath = path.join(destDir, `baseColor.${extracted.baseColor.extension}`);
  yield* fileSystem.writeFile(baseColorPath, extracted.baseColor.bytes);

  const metallicRoughnessPath = path.join(
    destDir,
    `metallicRoughness.${extracted.metallicRoughness.extension}`,
  );
  yield* fileSystem.writeFile(metallicRoughnessPath, extracted.metallicRoughness.bytes);

  const normalPath = path.join(destDir, `normal.${extracted.normal.extension}`);
  yield* fileSystem.writeFile(normalPath, extracted.normal.bytes);

  const files: GlbTextureFiles = {
    baseColor: baseColorPath,
    metallicRoughness: metallicRoughnessPath,
    normal: normalPath,
  };
  return files;
});
