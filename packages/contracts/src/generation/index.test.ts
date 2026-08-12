import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { FaceLimit, Generate3dInput, GenerationParameters } from "./index.ts";

const decodeFaceLimit = Schema.decodeUnknownSync(FaceLimit);
const decodeGenerate3dInput = Schema.decodeUnknownSync(Generate3dInput);
const decodeGenerationParameters = Schema.decodeUnknownSync(GenerationParameters);

// Merge-gate P3 #12: bounded to a sane positive range. Spike 0's own
// unbounded default (501,146 triangles) is the concrete evidence this
// guards against — nothing upstream previously stopped a caller from
// passing 0, a negative number, or an absurd value.
describe("FaceLimit", () => {
  it("accepts a real spike value", () => {
    expect(decodeFaceLimit(6000)).toBe(6000);
  });

  it("rejects zero", () => {
    expect(() => decodeFaceLimit(0)).toThrow();
  });

  it("rejects a negative value", () => {
    expect(() => decodeFaceLimit(-1)).toThrow();
  });

  it("rejects a non-integer value", () => {
    expect(() => decodeFaceLimit(6000.5)).toThrow();
  });

  it("rejects a value above the sanity ceiling", () => {
    expect(() => decodeFaceLimit(1_000_001)).toThrow();
  });

  it("accepts the sanity ceiling itself", () => {
    expect(decodeFaceLimit(1_000_000)).toBe(1_000_000);
  });
});

describe("Generate3dInput / GenerationParameters faceLimit", () => {
  it("rejects a zero faceLimit on the generate_3d tool input", () => {
    expect(() => decodeGenerate3dInput({ prompt: "a barrel", faceLimit: 0 })).toThrow();
  });

  it("rejects a negative faceLimit on GenerationParameters", () => {
    expect(() => decodeGenerationParameters({ faceLimit: -6000 })).toThrow();
  });

  it("still allows faceLimit to be omitted entirely", () => {
    expect(decodeGenerate3dInput({ prompt: "a barrel" }).faceLimit).toBeUndefined();
    expect(decodeGenerationParameters({}).faceLimit).toBeUndefined();
  });
});
