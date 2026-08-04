import { describe, expect, it } from "vite-plus/test";

import type { EditorPresenceEntry } from "../editorPresence/protocol";
import {
  isPlayEngaged,
  resolveEngineDispatchBackend,
  resolveEngineToolbarView,
} from "./EngineToolbar.logic";

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

describe("resolveEngineDispatchBackend", () => {
  it("routes Godot and Unreal to editor-presence", () => {
    expect(resolveEngineDispatchBackend("godot")).toBe("editor-presence");
    expect(resolveEngineDispatchBackend("unreal")).toBe("editor-presence");
  });
  it("routes Unity to the CLI backend, not editor-presence", () => {
    expect(resolveEngineDispatchBackend("unity")).toBe("unity-cli");
  });
  it("routes three.js to the script backend", () => {
    expect(resolveEngineDispatchBackend("threejs")).toBe("threejs-script");
  });
});

describe("resolveEngineToolbarView — no engine known", () => {
  it("renders no backend and no controls when the project has no engine at all", () => {
    const view = resolveEngineToolbarView({ engineType: null, connectedEditor: null });
    expect(view.backend).toBeNull();
    expect(view.requiresPresenceCommandScope).toBe(false);
    expect(view.availableActions).toEqual([]);
  });
});

describe("resolveEngineToolbarView — threejs-script backend", () => {
  it("needs no presence scope and has no control cluster, regardless of a connected editor", () => {
    const view = resolveEngineToolbarView({
      engineType: "threejs",
      connectedEditor: editor({ capabilities: ["play", "stop"] }),
    });
    expect(view.backend).toBe("threejs-script");
    expect(view.requiresPresenceCommandScope).toBe(false);
    expect(view.hasConnectedEditor).toBe(false);
    expect(view.availableActions).toEqual([]);
  });
});

describe("resolveEngineToolbarView — unity-cli backend", () => {
  it("needs presence:command too — same risk class as editor-presence (may make the editor execute code), different transport", () => {
    const view = resolveEngineToolbarView({ engineType: "unity", connectedEditor: null });
    expect(view.backend).toBe("unity-cli");
    expect(view.requiresPresenceCommandScope).toBe(true);
  });

  it("advertises the fixed play/pause/stop set — no step, Pipeline has no scriptable frame step", () => {
    const view = resolveEngineToolbarView({ engineType: "unity", connectedEditor: null });
    expect(view.availableActions).toEqual(["play", "pause", "stop"]);
  });

  it("ignores any connectedEditor passed in — Unity never appears in the presence feed", () => {
    const view = resolveEngineToolbarView({
      engineType: "unity",
      connectedEditor: editor({ editor: { id: "unity-1", name: "Unity", version: "6000.3" } }),
    });
    expect(view.hasConnectedEditor).toBe(false);
    expect(view.availableActions).toEqual(["play", "pause", "stop"]);
  });

  it("defaults playState to null when no status has been supplied", () => {
    const view = resolveEngineToolbarView({ engineType: "unity", connectedEditor: null });
    expect(view.playState).toBeNull();
  });

  it("passes an explicitly supplied unityPlayState through", () => {
    const view = resolveEngineToolbarView({
      engineType: "unity",
      connectedEditor: null,
      unityPlayState: "playing",
    });
    expect(view.playState).toBe("playing");
  });
});

describe("resolveEngineToolbarView — editor-presence backend (Godot today)", () => {
  it("requires the presence scope with nothing connected", () => {
    const view = resolveEngineToolbarView({ engineType: "godot", connectedEditor: null });
    expect(view.backend).toBe("editor-presence");
    expect(view.requiresPresenceCommandScope).toBe(true);
  });

  it("requires the presence scope even once an editor is connected", () => {
    const view = resolveEngineToolbarView({
      engineType: "godot",
      connectedEditor: editor({ capabilities: ["play"] }),
    });
    expect(view.requiresPresenceCommandScope).toBe(true);
  });

  it("reports no connected editor and an empty action list when nothing is connected", () => {
    const view = resolveEngineToolbarView({ engineType: "godot", connectedEditor: null });
    expect(view.hasConnectedEditor).toBe(false);
    expect(view.availableActions).toEqual([]);
    expect(view.playState).toBeNull();
  });

  it("shows only what the connected editor actually advertised, e.g. Godot's real play+stop", () => {
    const view = resolveEngineToolbarView({
      engineType: "godot",
      connectedEditor: editor({ capabilities: ["play", "stop"] }),
    });
    expect(view.hasConnectedEditor).toBe(true);
    expect(view.availableActions).toEqual(["play", "stop"]);
  });

  it("shows a full set in the fixed Play/Pause/Stop/Step order regardless of wire order", () => {
    const view = resolveEngineToolbarView({
      engineType: "godot",
      connectedEditor: editor({ capabilities: ["step", "stop", "play", "pause"] }),
    });
    expect(view.availableActions).toEqual(["play", "pause", "stop", "step"]);
  });

  it("never fabricates an action the editor did not advertise", () => {
    const view = resolveEngineToolbarView({
      engineType: "godot",
      connectedEditor: editor({ capabilities: ["play"] }),
    });
    expect(view.availableActions).toEqual(["play"]);
  });

  it("passes the connected editor's playState through untouched", () => {
    const view = resolveEngineToolbarView({
      engineType: "godot",
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
