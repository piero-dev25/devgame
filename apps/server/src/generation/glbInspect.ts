/**
 * Server-side glTF binary (.glb) inspection — no Unity involved. Spike 0
 * (docs/v2/SPIKE_RESULTS.md) proved this is enough to catch the "501,146
 * triangles vs a 5,000 budget" defect before any engine import. Parses only
 * the glTF 2.0 binary container header + JSON chunk; never touches the
 * binary buffer chunk.
 *
 * glTF 2.0 binary layout (little-endian throughout):
 *   header:  magic "glTF" (uint32) | version (uint32) | length (uint32)
 *   chunk0:  chunkLength (uint32) | chunkType (uint32, "JSON") | chunkData
 *   chunk1+: binary buffer chunk(s) — not read here.
 */
import * as Schema from "effect/Schema";

const GLB_MAGIC = 0x46546c67; // "glTF" read as a little-endian uint32
const CHUNK_TYPE_JSON = 0x4e4f534a; // "JSON" read as a little-endian uint32

export class GlbInspectionError extends Schema.TaggedErrorClass<GlbInspectionError>()(
  "GlbInspectionError",
  { detail: Schema.String },
) {
  override get message(): string {
    return `Failed to inspect GLB: ${this.detail}`;
  }
}

export interface GlbInspectionResult {
  readonly triangles: number;
  readonly materials: number;
  readonly images: number;
}

// Only the fields inspection actually reads — a glTF JSON chunk has many
// more, and decoding the rest would be exactly the "giant schema" this
// program's doctrine (docs/v2/GENERATION_ARCHITECTURE.md §5) warns against
// for a fact nothing here needs.
interface GltfAccessor {
  readonly count: number;
}
interface GltfPrimitive {
  readonly indices?: number;
  readonly attributes?: { readonly POSITION?: number };
}
interface GltfMesh {
  readonly primitives?: ReadonlyArray<GltfPrimitive>;
}
interface GltfDocument {
  readonly accessors?: ReadonlyArray<GltfAccessor>;
  readonly meshes?: ReadonlyArray<GltfMesh>;
  readonly materials?: ReadonlyArray<unknown>;
  readonly images?: ReadonlyArray<unknown>;
}

const readUint32LE = (bytes: Uint8Array, offset: number): number =>
  bytes[offset]! |
  (bytes[offset + 1]! << 8) |
  (bytes[offset + 2]! << 16) |
  (bytes[offset + 3]! << 24);

/** Sum of `accessors[primitive.indices].count / 3` over every mesh
 * primitive (the indexed-triangle-list case Tripo's exports always use,
 * per SPIKE_RESULTS.md). Falls back to `POSITION` accessor count / 3 for
 * the (unobserved but glTF-legal) non-indexed case rather than skipping
 * the primitive silently. */
function countTriangles(document: GltfDocument): number {
  const accessors = document.accessors ?? [];
  let total = 0;
  for (const mesh of document.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      const accessorIndex = primitive.indices ?? primitive.attributes?.POSITION;
      if (accessorIndex === undefined) continue;
      const accessor = accessors[accessorIndex];
      if (accessor === undefined) continue;
      total += Math.floor(accessor.count / 3);
    }
  }
  return total;
}

/**
 * Parse a GLB's header + JSON chunk and return the technical facts
 * `inspect_generation` reports: triangle count, material count, image
 * count. Never reads the binary buffer chunk.
 */
export function inspectGlb(bytes: Uint8Array): GlbInspectionResult {
  if (bytes.length < 20) {
    throw new GlbInspectionError({ detail: `file too small (${bytes.length} bytes)` });
  }
  const magic = readUint32LE(bytes, 0);
  if (magic !== GLB_MAGIC) {
    throw new GlbInspectionError({ detail: "missing glTF magic header" });
  }
  const chunkLength = readUint32LE(bytes, 12);
  const chunkType = readUint32LE(bytes, 16);
  if (chunkType !== CHUNK_TYPE_JSON) {
    throw new GlbInspectionError({ detail: "first chunk is not JSON" });
  }
  const jsonStart = 20;
  const jsonEnd = jsonStart + chunkLength;
  if (jsonEnd > bytes.length) {
    throw new GlbInspectionError({ detail: "JSON chunk length exceeds file size" });
  }
  const jsonBytes = bytes.subarray(jsonStart, jsonEnd);
  let document: GltfDocument;
  try {
    document = JSON.parse(new TextDecoder().decode(jsonBytes)) as GltfDocument;
  } catch (cause) {
    throw new GlbInspectionError({ detail: `invalid JSON chunk: ${String(cause)}` });
  }
  return {
    triangles: countTriangles(document),
    materials: (document.materials ?? []).length,
    images: (document.images ?? []).length,
  };
}
