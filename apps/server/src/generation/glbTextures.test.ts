// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { describe } from "vite-plus/test";

import { GlbTextureExtractionError, extractGlbTextures, writeGlbTextures } from "./glbTextures.ts";

const fixturePath = NodeURL.fileURLToPath(
  new URL("./__fixtures__/barrel-5996tris.glb", import.meta.url),
);
const fixtureBytes = new Uint8Array(NodeFS.readFileSync(fixturePath));

// Packs a minimal, deliberately synthetic glTF binary container — the JSON
// chunk plus a real binary buffer chunk (glbInspect.ts's own test helper
// only builds the JSON chunk, since glbInspect never reads chunk1; this
// module's whole point is reading it). No 4-byte alignment padding: this
// module's parser trusts the declared chunk lengths exactly, the same way
// glbInspect.ts's parser does, so unpadded chunks round-trip fine for a
// test fixture even though a REAL glTF exporter would pad them.
function buildGlb(document: unknown, binaryChunk: Uint8Array = new Uint8Array(0)): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(document));
  const totalLength = 12 + 8 + json.length + 8 + binaryChunk.length;
  const bytes = new Uint8Array(totalLength);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true); // "glTF"
  view.setUint32(4, 2, true); // version
  view.setUint32(8, totalLength, true);
  view.setUint32(12, json.length, true);
  view.setUint32(16, 0x4e4f534a, true); // "JSON"
  bytes.set(json, 20);
  const binHeaderOffset = 20 + json.length;
  view.setUint32(binHeaderOffset, binaryChunk.length, true);
  view.setUint32(binHeaderOffset + 4, 0x004e4942, true); // "BIN\0"
  bytes.set(binaryChunk, binHeaderOffset + 8);
  return bytes;
}

/** One material, all three PBR roles present, each pointing (via the real
 * texture→image→bufferView indirection) at a distinguishable byte range
 * in `minimalBinaryChunk` below. */
const minimalValidDocument = {
  materials: [
    {
      pbrMetallicRoughness: {
        baseColorTexture: { index: 0 },
        metallicRoughnessTexture: { index: 1 },
      },
      normalTexture: { index: 2 },
    },
  ],
  textures: [{ source: 0 }, { source: 1 }, { source: 2 }],
  images: [
    { mimeType: "image/png", bufferView: 0 },
    { mimeType: "image/png", bufferView: 1 },
    { mimeType: "image/png", bufferView: 2 },
  ],
  bufferViews: [
    { byteOffset: 0, byteLength: 2 },
    { byteOffset: 2, byteLength: 3 },
    { byteOffset: 5, byteLength: 1 },
  ],
};
const minimalBinaryChunk = new Uint8Array([0xaa, 0xaa, 0xbb, 0xbb, 0xbb, 0xcc]);

describe("extractGlbTextures", () => {
  describe("against the real committed fixture", () => {
    it("returns exactly {baseColor, metallicRoughness, normal}, all real JPEG bytes", () => {
      const result = extractGlbTextures(fixtureBytes);
      expect(Object.keys(result).sort()).toEqual(
        ["baseColor", "metallicRoughness", "normal"].sort(),
      );
      for (const role of ["baseColor", "metallicRoughness", "normal"] as const) {
        expect(result[role].extension, role).toBe("jpg");
        // Real JPEG magic bytes (0xFFD8) — proves these are the actual
        // embedded image bytes, not some placeholder or the wrong slice.
        expect(result[role].bytes[0], `${role} first byte`).toBe(0xff);
        expect(result[role].bytes[1], `${role} second byte`).toBe(0xd8);
      }
    });

    // Doctrine: a green test must be able to go red. Real sizes measured
    // directly off the committed fixture's own bufferViews — a role swap
    // (e.g. returning normal's bytes under the baseColor key) would still
    // pass a bare "non-zero length" check, so pin the EXACT byte counts,
    // not just their presence.
    it("would fail if extraction returned zero bytes or swapped roles (red-proof)", () => {
      const result = extractGlbTextures(fixtureBytes);
      expect(result.baseColor.bytes.length).not.toBe(0);
      expect(result.metallicRoughness.bytes.length).not.toBe(0);
      expect(result.normal.bytes.length).not.toBe(0);
      expect(result.baseColor.bytes.length).toBe(262_356);
      expect(result.metallicRoughness.bytes.length).toBe(138_527);
      expect(result.normal.bytes.length).toBe(117_239);
    });
  });

  describe("against a minimal synthetic document", () => {
    it("resolves the real texture→image→bufferView indirection for all three roles", () => {
      const glb = buildGlb(minimalValidDocument, minimalBinaryChunk);
      const result = extractGlbTextures(glb);
      expect(Array.from(result.baseColor.bytes)).toEqual([0xaa, 0xaa]);
      expect(Array.from(result.metallicRoughness.bytes)).toEqual([0xbb, 0xbb, 0xbb]);
      expect(Array.from(result.normal.bytes)).toEqual([0xcc]);
      expect(result.baseColor.extension).toBe("png");
    });

    it("rejects a GLB with no materials at all", () => {
      const glb = buildGlb({ materials: [] }, minimalBinaryChunk);
      expect(() => extractGlbTextures(glb)).toThrowError(GlbTextureExtractionError);
    });

    it("rejects a material missing the baseColor texture role", () => {
      const document = structuredClone(minimalValidDocument);
      delete (document.materials[0]!.pbrMetallicRoughness as Record<string, unknown>)
        .baseColorTexture;
      const glb = buildGlb(document, minimalBinaryChunk);
      expect(() => extractGlbTextures(glb)).toThrowError(GlbTextureExtractionError);
    });

    it("rejects a material missing the normal texture role", () => {
      const document = structuredClone(minimalValidDocument);
      delete (document.materials[0] as Record<string, unknown>).normalTexture;
      const glb = buildGlb(document, minimalBinaryChunk);
      expect(() => extractGlbTextures(glb)).toThrowError(GlbTextureExtractionError);
    });

    it("rejects a texture index that has no source image", () => {
      const document = structuredClone(minimalValidDocument);
      document.materials[0]!.pbrMetallicRoughness.baseColorTexture = { index: 99 };
      const glb = buildGlb(document, minimalBinaryChunk);
      expect(() => extractGlbTextures(glb)).toThrowError(GlbTextureExtractionError);
    });

    it("rejects an image with no bufferView (external URI images are unsupported)", () => {
      const document = structuredClone(minimalValidDocument);
      document.images[0] = { mimeType: "image/png" } as (typeof document.images)[0];
      const glb = buildGlb(document, minimalBinaryChunk);
      expect(() => extractGlbTextures(glb)).toThrowError(GlbTextureExtractionError);
    });

    it("rejects an image with an unsupported mimeType", () => {
      const document = structuredClone(minimalValidDocument);
      document.images[0] = { mimeType: "image/webp", bufferView: 0 };
      const glb = buildGlb(document, minimalBinaryChunk);
      expect(() => extractGlbTextures(glb)).toThrowError(GlbTextureExtractionError);
    });

    it("rejects a bufferView range exceeding the binary chunk size", () => {
      const document = structuredClone(minimalValidDocument);
      document.bufferViews[0] = { byteOffset: 0, byteLength: 999 };
      const glb = buildGlb(document, minimalBinaryChunk);
      expect(() => extractGlbTextures(glb)).toThrowError(GlbTextureExtractionError);
    });
  });

  it("rejects a GLB with no binary buffer chunk at all", () => {
    // buildGlb with a zero-length binary chunk still WRITES chunk1's own
    // header (length 0, type BIN) — this constructs a JSON-chunk-only GLB
    // with no chunk1 header whatsoever, the real "GLB has no textures"
    // case (glbInspect.ts's own inspection-only spike-0 fixtures were like
    // this before spike 2 added embedded images).
    const json = new TextEncoder().encode(JSON.stringify({ materials: [] }));
    const bytes = new Uint8Array(20 + json.length);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0x46546c67, true);
    view.setUint32(4, 2, true);
    view.setUint32(8, bytes.length, true);
    view.setUint32(12, json.length, true);
    view.setUint32(16, 0x4e4f534a, true);
    bytes.set(json, 20);
    expect(() => extractGlbTextures(bytes)).toThrowError(GlbTextureExtractionError);
  });
});

describe("writeGlbTextures", () => {
  it.effect(
    "writes baseColor.jpg, metallicRoughness.jpg, normal.jpg with the real extracted bytes",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const destDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3code-glb-textures-test-",
        });

        const files = yield* writeGlbTextures(fixtureBytes, destDir);

        expect(Object.keys(files).sort()).toEqual(
          ["baseColor", "metallicRoughness", "normal"].sort(),
        );
        expect(files.baseColor).toBe(`${destDir}/baseColor.jpg`);
        expect(files.metallicRoughness).toBe(`${destDir}/metallicRoughness.jpg`);
        expect(files.normal).toBe(`${destDir}/normal.jpg`);

        const expected = extractGlbTextures(fixtureBytes);
        const writtenBaseColor = yield* fileSystem.readFile(files.baseColor);
        const writtenMetallicRoughness = yield* fileSystem.readFile(files.metallicRoughness);
        const writtenNormal = yield* fileSystem.readFile(files.normal);

        // Round-trip proof, not just "a file exists": the bytes on disk are
        // EXACTLY the bytes `extractGlbTextures` read out of the GLB, for
        // every one of the three roles — a mutation writing zero bytes, or
        // writing the wrong role's bytes to a file, fails this.
        expect(writtenBaseColor.length).toBe(expected.baseColor.bytes.length);
        expect(Array.from(writtenBaseColor)).toEqual(Array.from(expected.baseColor.bytes));
        expect(writtenMetallicRoughness.length).toBe(expected.metallicRoughness.bytes.length);
        expect(Array.from(writtenMetallicRoughness)).toEqual(
          Array.from(expected.metallicRoughness.bytes),
        );
        expect(writtenNormal.length).toBe(expected.normal.bytes.length);
        expect(Array.from(writtenNormal)).toEqual(Array.from(expected.normal.bytes));
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "fails with GlbTextureExtractionError (not a generic error) for an unextractable GLB",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const destDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3code-glb-textures-test-",
        });
        const badGlb = buildGlb({ materials: [] }, minimalBinaryChunk);

        const error = yield* Effect.flip(writeGlbTextures(badGlb, destDir));
        expect(error._tag).toBe("GlbTextureExtractionError");

        // No texture files should exist on a failed extraction — a
        // partial/zero-file write on failure would be a silent-corruption
        // trap for a caller that only checks the returned Effect's error.
        const entries = yield* fileSystem.readDirectory(destDir);
        expect(entries).toEqual([]);
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
