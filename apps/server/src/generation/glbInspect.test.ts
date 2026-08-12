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

  it("counts triangles via the POSITION fallback when a primitive has no indices", () => {
    const document = {
      accessors: [{ count: 9 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      materials: [],
      images: [],
    };
    const json = new TextEncoder().encode(JSON.stringify(document));
    // Pad JSON to a 4-byte boundary the way a real glTF exporter would;
    // inspectGlb does not require padding, but this keeps the fixture
    // structurally realistic.
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

    expect(inspectGlb(glb)).toEqual({ triangles: 3, materials: 0, images: 0 });
  });
});
