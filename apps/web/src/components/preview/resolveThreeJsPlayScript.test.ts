import type { ProjectScript } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveThreeJsPlayScript } from "./resolveThreeJsPlayScript";

function script(overrides: Partial<ProjectScript> = {}): ProjectScript {
  return {
    id: "dev",
    name: "dev",
    command: "npm run dev",
    icon: "play",
    runOnWorktreeCreate: false,
    ...overrides,
  };
}

describe("resolveThreeJsPlayScript", () => {
  it("returns null when scripts is undefined", () => {
    expect(resolveThreeJsPlayScript(undefined)).toBeNull();
  });

  it("returns null when no script qualifies", () => {
    expect(resolveThreeJsPlayScript([script(), script({ id: "build", name: "build" })])).toBeNull();
  });

  it("finds a script with autoOpenPreview and a previewUrl", () => {
    const target = script({ autoOpenPreview: true, previewUrl: "http://localhost:5173" });
    expect(resolveThreeJsPlayScript([script(), target])).toBe(target);
  });

  it("ignores autoOpenPreview without a previewUrl", () => {
    expect(resolveThreeJsPlayScript([script({ autoOpenPreview: true })])).toBeNull();
  });

  it("ignores a previewUrl without autoOpenPreview", () => {
    expect(resolveThreeJsPlayScript([script({ previewUrl: "http://localhost:5173" })])).toBeNull();
  });

  it("returns the first qualifying script when more than one qualifies", () => {
    const first = script({ id: "a", autoOpenPreview: true, previewUrl: "http://localhost:1" });
    const second = script({ id: "b", autoOpenPreview: true, previewUrl: "http://localhost:2" });
    expect(resolveThreeJsPlayScript([first, second])).toBe(first);
  });
});
