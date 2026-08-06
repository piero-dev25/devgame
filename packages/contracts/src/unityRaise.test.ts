import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { UNITY_RAISE_PATH, UnityRaiseInput, UnityRaiseResult } from "./index.ts";

const decodeUnityRaiseInput = Schema.decodeUnknownSync(UnityRaiseInput);
const decodeUnityRaiseResult = Schema.decodeUnknownSync(UnityRaiseResult);

describe("Unity raise contract", () => {
  it("publishes the POST path and accepts only an opaque projectId input", () => {
    expect(UNITY_RAISE_PATH).toBe("/unity/raise");
    expect(decodeUnityRaiseInput({ projectId: "project-unity" })).toEqual({
      projectId: "project-unity",
    });
    expect(
      decodeUnityRaiseInput({
        projectId: "project-unity",
        workspaceRoot: "/caller/supplied/path",
      }),
    ).toEqual({ projectId: "project-unity" });
  });

  it("decodes the raised, cold-started, and typed-error outcomes", () => {
    expect(decodeUnityRaiseResult({ _tag: "raised" })).toEqual({
      _tag: "raised",
    });
    expect(decodeUnityRaiseResult({ _tag: "coldStartStarted" })).toEqual({
      _tag: "coldStartStarted",
    });
    expect(
      decodeUnityRaiseResult({
        _tag: "error",
        message: "Project not found.",
      }),
    ).toEqual({ _tag: "error", message: "Project not found." });
  });
});
