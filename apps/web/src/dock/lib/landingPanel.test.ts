import { describe, expect, it } from "vite-plus/test";

import { SIDEBAR_PANEL_ID } from "~/dockActiveSelectionStore";

import { CHAT_PANEL_ID, DIFF_PANEL_ID, WORKSPACE_PANEL_ID } from "../chatDockHandle";
import { resolveDockLandingPanelId, shouldApplyLateLanding } from "./landingPanel";

const openPanels =
  (...ids: string[]) =>
  (id: string) =>
    ids.includes(id);

describe("resolveDockLandingPanelId", () => {
  it("lands game projects on Workspace for every engine", () => {
    for (const engine of ["unity", "unreal", "godot", "threejs"] as const) {
      expect(resolveDockLandingPanelId(engine)).toBe(WORKSPACE_PANEL_ID);
    }
  });

  it("lands on Chat when the project is not a game or its engine is not known yet", () => {
    expect(resolveDockLandingPanelId("none")).toBe(CHAT_PANEL_ID);
    expect(resolveDockLandingPanelId("unknown")).toBe(CHAT_PANEL_ID);
  });
});

describe("shouldApplyLateLanding", () => {
  const base = {
    landingPanelId: WORKSPACE_PANEL_ID,
    rememberedPanelId: null,
    activePanelId: CHAT_PANEL_ID,
    isPanelOpen: openPanels(CHAT_PANEL_ID, WORKSPACE_PANEL_ID, DIFF_PANEL_ID),
  };

  it("brings Workspace forward once the engine resolves on a thread with no remembered tab", () => {
    expect(shouldApplyLateLanding(base)).toBe(true);
  });

  it("does nothing when the landing panel is Chat", () => {
    expect(shouldApplyLateLanding({ ...base, landingPanelId: CHAT_PANEL_ID })).toBe(false);
  });

  it("never reopens a Workspace panel the user closed", () => {
    expect(
      shouldApplyLateLanding({ ...base, isPanelOpen: openPanels(CHAT_PANEL_ID, DIFF_PANEL_ID) }),
    ).toBe(false);
  });

  it("respects a remembered selection that is still open, including Chat itself", () => {
    expect(shouldApplyLateLanding({ ...base, rememberedPanelId: DIFF_PANEL_ID })).toBe(false);
    expect(shouldApplyLateLanding({ ...base, rememberedPanelId: CHAT_PANEL_ID })).toBe(false);
  });

  it("ignores a remembered selection that is closed or is a chrome panel", () => {
    expect(shouldApplyLateLanding({ ...base, rememberedPanelId: "terminal" })).toBe(true);
    expect(
      shouldApplyLateLanding({
        ...base,
        rememberedPanelId: SIDEBAR_PANEL_ID,
        isPanelOpen: openPanels(SIDEBAR_PANEL_ID, CHAT_PANEL_ID, WORKSPACE_PANEL_ID),
      }),
    ).toBe(true);
  });

  it("does nothing once the user has moved off Chat", () => {
    expect(shouldApplyLateLanding({ ...base, activePanelId: DIFF_PANEL_ID })).toBe(false);
    expect(shouldApplyLateLanding({ ...base, activePanelId: null })).toBe(false);
  });
});
