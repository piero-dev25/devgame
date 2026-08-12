import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import { Tool } from "effect/unstable/ai";
import { describe } from "vite-plus/test";

import {
  Generate3dTool,
  GenerationStatusTool,
  GenerationToolkit,
  ImportGeneratedAssetTool,
  InspectGenerationTool,
  ListGenerationsTool,
} from "./tools.ts";

describe("GenerationToolkit", () => {
  it("exports exactly the five tools the frozen specs name (increments 1 + 2a)", () => {
    expect(Object.keys(GenerationToolkit.tools).sort()).toEqual(
      [
        "generate_3d",
        "generation_status",
        "import_generated_asset",
        "inspect_generation",
        "list_generations",
      ].sort(),
    );
  });

  it("gives every tool a substantive description and an object parameter schema", () => {
    for (const tool of Object.values(GenerationToolkit.tools)) {
      expect(
        tool.description?.length ?? 0,
        `${tool.name} should have a useful description`,
      ).toBeGreaterThan(40);
      const schema = Tool.getJsonSchema(tool) as { readonly type?: unknown };
      // list_generations takes no parameters — Schema.Struct({})'s generated
      // JSON schema omits `type` entirely rather than emitting an
      // essentially-vacuous `{type:"object",properties:{}}`, so it is
      // exempted from the "must declare object" check the other four
      // (real-parameter) tools get.
      if (tool.name === "list_generations") continue;
      expect(schema.type, `${tool.name} must export a top-level object schema`).toBe("object");
    }
  });

  it("marks generate_3d as non-readonly, non-idempotent, open-world (it calls a paid external provider)", () => {
    expect(Context.get(Generate3dTool.annotations, Tool.Readonly)).toBe(false);
    expect(Context.get(Generate3dTool.annotations, Tool.Idempotent)).toBe(false);
    expect(Context.get(Generate3dTool.annotations, Tool.OpenWorld)).toBe(true);
  });

  it("marks import_generated_asset as non-readonly, non-idempotent, open-world (it mutates the caller's Unity project)", () => {
    expect(Context.get(ImportGeneratedAssetTool.annotations, Tool.Readonly)).toBe(false);
    expect(Context.get(ImportGeneratedAssetTool.annotations, Tool.Idempotent)).toBe(false);
    expect(Context.get(ImportGeneratedAssetTool.annotations, Tool.Destructive)).toBe(false);
    expect(Context.get(ImportGeneratedAssetTool.annotations, Tool.OpenWorld)).toBe(true);
  });

  it("marks the three read tools as readonly and idempotent", () => {
    for (const tool of [GenerationStatusTool, ListGenerationsTool, InspectGenerationTool]) {
      expect(Context.get(tool.annotations, Tool.Readonly), tool.name).toBe(true);
      expect(Context.get(tool.annotations, Tool.Idempotent), tool.name).toBe(true);
      expect(Context.get(tool.annotations, Tool.Destructive), tool.name).toBe(false);
    }
  });
});
