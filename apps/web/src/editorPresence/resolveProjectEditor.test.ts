import { describe, expect, it } from "vite-plus/test";

import type { EditorPresenceEntry } from "./protocol";
import { resolveConnectedEditorForProject } from "./resolveProjectEditor";

function editor(overrides: Partial<EditorPresenceEntry> = {}): EditorPresenceEntry {
  return {
    editor: { id: "godot-1", name: "Godot", version: "4.7.1" },
    session: { id: "session-1" },
    workspace: { root: "/repo" },
    connected: true,
    lastSeenAt: "2026-08-03T00:00:00.000Z",
    selection: null,
    capabilities: ["play", "stop"],
    playState: "stopped",
    ...overrides,
  };
}

describe("resolveConnectedEditorForProject", () => {
  it("matches an editor by workspace root", () => {
    const match = editor();
    expect(resolveConnectedEditorForProject([match], { workspaceRoot: "/repo" })).toBe(match);
  });

  it("returns null when the project is null", () => {
    expect(resolveConnectedEditorForProject([editor()], null)).toBeNull();
  });

  it("returns null when no editor matches the workspace root", () => {
    expect(
      resolveConnectedEditorForProject([editor({ workspace: { root: "/other" } })], {
        workspaceRoot: "/repo",
      }),
    ).toBeNull();
  });

  it("ignores a matching-root entry that is no longer connected", () => {
    expect(
      resolveConnectedEditorForProject([editor({ connected: false })], { workspaceRoot: "/repo" }),
    ).toBeNull();
  });

  it("normalizes a trailing slash difference between the two sides", () => {
    const match = editor({ workspace: { root: "/repo/" } });
    expect(resolveConnectedEditorForProject([match], { workspaceRoot: "/repo" })).toBe(match);

    const matchOtherDirection = editor({ workspace: { root: "/repo" } });
    expect(
      resolveConnectedEditorForProject([matchOtherDirection], { workspaceRoot: "/repo/" }),
    ).toBe(matchOtherDirection);
  });
});
