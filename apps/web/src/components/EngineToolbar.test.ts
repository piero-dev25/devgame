import { describe, expect, it } from "vite-plus/test";

import type { EditorPresenceEntry } from "../editorPresence/protocol";
import { isPlayEngaged, resolveEngineToolbarView } from "./EngineToolbar.logic";

function editor(overrides: Partial<EditorPresenceEntry> = {}): EditorPresenceEntry {
  return {
    editor: { id: "godot-1", name: "Godot", version: "4.7.1" },
    session: { id: "session-1" },
    workspace: { root: "/repo" },
    connected: true,
    lastSeenAt: "2026-08-03T00:00:00.000Z",
    selection: null,
    capabilities: [],
    playState: null,
    ...overrides,
  };
}

describe("resolveEngineToolbarView — three.js", () => {
  it("short-circuits to isThreeJs with no control cluster, regardless of a connected editor", () => {
    const view = resolveEngineToolbarView({
      engineType: "threejs",
      connectedEditor: editor({ capabilities: ["play", "stop"] }),
    });
    expect(view.isThreeJs).toBe(true);
    expect(view.hasConnectedEditor).toBe(false);
    expect(view.availableActions).toEqual([]);
  });
});

describe("resolveEngineToolbarView — no connected editor", () => {
  it("reports no connected editor and an empty action list, but keeps the engine type", () => {
    const view = resolveEngineToolbarView({ engineType: "godot", connectedEditor: null });
    expect(view.engineType).toBe("godot");
    expect(view.hasConnectedEditor).toBe(false);
    expect(view.availableActions).toEqual([]);
    expect(view.playState).toBeNull();
  });
});

describe("resolveEngineToolbarView — capability gating", () => {
  it("shows only what the connected editor actually advertised, e.g. Godot's real play+stop", () => {
    const view = resolveEngineToolbarView({
      engineType: "godot",
      connectedEditor: editor({ capabilities: ["play", "stop"] }),
    });
    expect(view.hasConnectedEditor).toBe(true);
    expect(view.availableActions).toEqual(["play", "stop"]);
  });

  it("shows Unity's full set in the fixed Play/Pause/Stop/Step order regardless of wire order", () => {
    const view = resolveEngineToolbarView({
      engineType: "unity",
      connectedEditor: editor({ capabilities: ["step", "stop", "play", "pause"] }),
    });
    expect(view.availableActions).toEqual(["play", "pause", "stop", "step"]);
  });

  it("never fabricates an action the editor did not advertise", () => {
    const view = resolveEngineToolbarView({
      engineType: "unity",
      connectedEditor: editor({ capabilities: ["play"] }),
    });
    expect(view.availableActions).toEqual(["play"]);
  });

  it("shows nothing for an editor that advertised no capabilities at all", () => {
    const view = resolveEngineToolbarView({
      engineType: "unreal",
      connectedEditor: editor({ capabilities: [] }),
    });
    expect(view.availableActions).toEqual([]);
  });
});

describe("resolveEngineToolbarView — playState passthrough", () => {
  it("passes the connected editor's playState through untouched", () => {
    const view = resolveEngineToolbarView({
      engineType: "unity",
      connectedEditor: editor({ capabilities: ["play"], playState: "playing" }),
    });
    expect(view.playState).toBe("playing");
  });
});

describe("isPlayEngaged", () => {
  it("is engaged while playing", () => {
    expect(isPlayEngaged("playing")).toBe(true);
  });
  it("is engaged while paused", () => {
    expect(isPlayEngaged("paused")).toBe(true);
  });
  it("is not engaged while stopped", () => {
    expect(isPlayEngaged("stopped")).toBe(false);
  });
  it("is not engaged when unknown", () => {
    expect(isPlayEngaged(null)).toBe(false);
  });
});
