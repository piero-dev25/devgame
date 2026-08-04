import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { selectProjectEngineType, useEngineSelectorStore } from "./engineSelectorStore";

const PROJECT_REF = scopeProjectRef(EnvironmentId.make("environment-1"), ProjectId.make("project-1"));
const OTHER_PROJECT_REF = scopeProjectRef(
  EnvironmentId.make("environment-1"),
  ProjectId.make("project-2"),
);

describe("engineSelectorStore", () => {
  beforeEach(() => useEngineSelectorStore.setState({ overrideByProjectKey: {} }));

  it("falls back to the detected engine when there is no override", () => {
    expect(
      selectProjectEngineType(useEngineSelectorStore.getState().overrideByProjectKey, PROJECT_REF, "godot"),
    ).toBe("godot");
  });

  it("falls back to null when there is no override and no detected engine", () => {
    expect(
      selectProjectEngineType(useEngineSelectorStore.getState().overrideByProjectKey, PROJECT_REF, null),
    ).toBeNull();
  });

  it("returns null for a null ref regardless of override state", () => {
    useEngineSelectorStore.getState().selectEngine(PROJECT_REF, "unity");
    expect(
      selectProjectEngineType(useEngineSelectorStore.getState().overrideByProjectKey, null, null),
    ).toBeNull();
  });

  it("prefers an explicit override over the detected engine", () => {
    useEngineSelectorStore.getState().selectEngine(PROJECT_REF, "unity");

    expect(
      selectProjectEngineType(useEngineSelectorStore.getState().overrideByProjectKey, PROJECT_REF, "godot"),
    ).toBe("unity");
  });

  it("scopes the override to its own project only", () => {
    useEngineSelectorStore.getState().selectEngine(PROJECT_REF, "unity");

    expect(
      selectProjectEngineType(
        useEngineSelectorStore.getState().overrideByProjectKey,
        OTHER_PROJECT_REF,
        "godot",
      ),
    ).toBe("godot");
  });

  it("clearOverride returns to the detected default", () => {
    const store = useEngineSelectorStore.getState();
    store.selectEngine(PROJECT_REF, "unity");
    store.clearOverride(PROJECT_REF);

    expect(
      selectProjectEngineType(useEngineSelectorStore.getState().overrideByProjectKey, PROJECT_REF, "godot"),
    ).toBe("godot");
  });

  it("clearOverride on a project with no override is a no-op", () => {
    const before = useEngineSelectorStore.getState().overrideByProjectKey;
    useEngineSelectorStore.getState().clearOverride(PROJECT_REF);
    expect(useEngineSelectorStore.getState().overrideByProjectKey).toBe(before);
  });
});
