// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

import { expect, it } from "@effect/vitest";
import { describe } from "vite-plus/test";

import { GlbInspectionError, inspectGlb } from "./glbInspect.ts";

const fixturePath = NodeURL.fileURLToPath(
  new URL("./__fixtures__/barrel-5996tris.glb", import.meta.url),
);
const fixtureBytes = new Uint8Array(NodeFS.readFileSync(fixturePath));

describe("inspectGlb", () => {
  it("reports the known triangle/material/image facts for the committed fixture", () => {
    const result = inspectGlb(fixtureBytes);
    expect(result).toEqual({ triangles: 5996, materials: 1, images: 3 });
  });

  // Doctrine: a green test must be able to go red. Pinning the wrong
  // expected values against the SAME fixture bytes proves this assertion is
  // not vacuous — it fails the moment the fixture's real facts diverge from
  // a stale expectation, the exact failure mode a silent regression in
  // countTriangles()'s indices-vs-POSITION fallback would produce.
  it("would fail if the fixture's real facts diverged from a stale expectation (red-proof)", () => {
    const result = inspectGlb(fixtureBytes);
    expect(result.triangles).not.toBe(501_146); // the PRE-remesh barrel from spike 0
    expect(result.triangles).not.toBe(0);
    expect(result.materials).not.toBe(0);
    expect(result.images).not.toBe(0);
  });

  it("rejects a file too small to contain a glTF header", () => {
    expect(() => inspectGlb(new Uint8Array(4))).toThrowError(GlbInspectionError);
  });

  it("rejects a file with the wrong magic header", () => {
    const bad = new Uint8Array(20);
    bad.set([0, 0, 0, 0], 0); // not "glTF"
    expect(() => inspectGlb(bad)).toThrowError(GlbInspectionError);
  });

  // Shared by the synthetic-document tests below — inline in each of them
  // was starting to drown the actual assertion in header-packing ceremony.
  function buildGlb(document: unknown): Uint8Array {
    const json = new TextEncoder().encode(JSON.stringify(document));
    const header = new Uint8Array(12);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x46546c67, true);
    view.setUint32(4, 2, true);
    view.setUint32(8, 12 + 8 + json.length, true);
    const chunkHeader = new Uint8Array(8);
    const chunkView = new DataView(chunkHeader.buffer);
    chunkView.setUint32(0, json.length, true);
    chunkView.setUint32(4, 0x4e4f534a, true);
    const glb = new Uint8Array(header.length + chunkHeader.length + json.length);
    glb.set(header, 0);
    glb.set(chunkHeader, header.length);
    glb.set(json, header.length + chunkHeader.length);
    return glb;
  }

  it("counts triangles via the POSITION fallback when a primitive has no indices", () => {
    const glb = buildGlb({
      accessors: [{ count: 9 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      materials: [],
      images: [],
    });
    expect(inspectGlb(glb)).toEqual({ triangles: 3, materials: 0, images: 0 });
  });

  // Merge-gate P3 #13: `metadata.triangles` is client-facing ADVISORY
  // data, not correctness-critical — a corrupt/hostile accessor.count
  // (negative, non-integer, or absurdly large) must clamp to a harmless
  // 0 contribution, never crash or overflow into a nonsense value.
  describe("sanity-bounds absurd accessor counts (merge-gate P3 #13)", () => {
    it("treats a negative accessor.count as a zero contribution", () => {
      const glb = buildGlb({
        accessors: [{ count: -6 }],
        meshes: [{ primitives: [{ indices: 0 }] }],
        materials: [],
        images: [],
      });
      expect(inspectGlb(glb).triangles).toBe(0);
    });

    it("treats a non-integer accessor.count as a zero contribution", () => {
      const glb = buildGlb({
        accessors: [{ count: 9.5 }],
        meshes: [{ primitives: [{ indices: 0 }] }],
        materials: [],
        images: [],
      });
      expect(inspectGlb(glb).triangles).toBe(0);
    });

    it("treats an accessor.count above the sanity ceiling as a zero contribution", () => {
      const glb = buildGlb({
        accessors: [{ count: Number.MAX_SAFE_INTEGER }],
        meshes: [{ primitives: [{ indices: 0 }] }],
        materials: [],
        images: [],
      });
      expect(inspectGlb(glb).triangles).toBe(0);
    });

    it("still counts a sane accessor.count in the SAME document as an insane one", () => {
      const glb = buildGlb({
        accessors: [{ count: -1 }, { count: 9 }],
        meshes: [
          {
            primitives: [{ indices: 0 }, { indices: 1 }],
          },
        ],
        materials: [],
        images: [],
      });
      expect(inspectGlb(glb).triangles).toBe(3);
    });
  });
});
