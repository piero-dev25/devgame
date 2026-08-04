import { describe, expect, it } from "vite-plus/test";

import { parseEditorPresenceFrame } from "./protocol";

/** Builds a minimally-valid `presence` frame JSON string, with `capabilities`
 * and `playState` overridable per test — everything else pinned to a fixed
 * valid shape so each test only varies the field it's actually about. */
function buildFrame(overrides: {
  readonly capabilities?: unknown;
  readonly playState?: unknown;
}): string {
  return JSON.stringify({
    v: 1,
    type: "presence",
    editors: [
      {
        editor: { id: "godot-1", name: "Godot", version: "4.7.1" },
        session: { id: "sess-1" },
        workspace: { root: "/repo" },
        connected: true,
        lastSeenAt: "2026-08-03T00:00:00.000Z",
        selection: null,
        ...overrides,
      },
    ],
  });
}

describe("parseEditorPresenceFrame — capabilities", () => {
  it("parses a valid capabilities array through", () => {
    const frame = parseEditorPresenceFrame(buildFrame({ capabilities: ["play", "stop"] }));
    expect(frame?.editors[0]?.capabilities).toEqual(["play", "stop"]);
  });

  it("defaults to [] when capabilities is absent — an older publisher, not a lie", () => {
    const frame = parseEditorPresenceFrame(buildFrame({}));
    expect(frame?.editors[0]?.capabilities).toEqual([]);
  });

  it("defaults to [] when capabilities is not an array", () => {
    const frame = parseEditorPresenceFrame(buildFrame({ capabilities: "play" }));
    expect(frame?.editors[0]?.capabilities).toEqual([]);
  });

  it("drops non-string items individually rather than rejecting the whole entry", () => {
    const frame = parseEditorPresenceFrame(buildFrame({ capabilities: ["play", 7, null, "stop"] }));
    expect(frame?.editors[0]?.capabilities).toEqual(["play", "stop"]);
  });
});

describe("parseEditorPresenceFrame — playState", () => {
  it.each(["stopped", "playing", "paused"] as const)("parses %s through", (playState) => {
    const frame = parseEditorPresenceFrame(buildFrame({ playState }));
    expect(frame?.editors[0]?.playState).toBe(playState);
  });

  it("defaults to null when playState is absent — a publisher that hasn't reported yet", () => {
    const frame = parseEditorPresenceFrame(buildFrame({}));
    expect(frame?.editors[0]?.playState).toBeNull();
  });

  it("defaults to null for a value outside the closed set", () => {
    const frame = parseEditorPresenceFrame(buildFrame({ playState: "buffering" }));
    expect(frame?.editors[0]?.playState).toBeNull();
  });
});
