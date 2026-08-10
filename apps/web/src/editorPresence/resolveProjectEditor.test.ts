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

  // STALE-PUBLISHER GUARD (unity-playstate-presence.md critique F3): a
  // crashed/force-quit editor leaves a half-open registry entry behind —
  // `connected` is never written false server-side (no liveness sweep, and
  // no publisher in this repo sends a ping the server could time out on), so
  // a relaunched editor registers as a SECOND publisher (a fresh
  // SessionState-backed session id — see EditorPresenceConnection.cs) that
  // shares the same workspace root. Before this fix, first-match resolution
  // would let the corpse's stale entry outrank the live one forever, for as
  // long as it happened to sort first in the array. Fixed by preferring the
  // newest `lastSeenAt` among same-root connected matches — verified wire
  // shape: `EditorPresenceEntry.lastSeenAt` (this file's `protocol.ts`) IS
  // present on every entry (server's `toEntry`/`EditorPresenceRegistry.ts`
  // always sets it, and stamps a fresh one on every playState/selection
  // update, not just at hello), so the newest-`lastSeenAt` variant applies —
  // not the registration-order fallback the spec names for a publisher whose
  // wire entry omits the field entirely. This also fixes the same ambiguity
  // for selection chips, which share this same resolver.
  describe("stale-publisher guard — prefers the newest lastSeenAt among same-root connected matches", () => {
    it("prefers the live re-registration over a stale corpse entry that sorts first", () => {
      const stale = editor({
        session: { id: "stale-session" },
        lastSeenAt: "2026-08-10T10:00:00.000Z",
        playState: "playing",
      });
      const live = editor({
        session: { id: "live-session" },
        lastSeenAt: "2026-08-10T10:05:00.000Z",
        playState: "stopped",
      });
      // Stale-first array order, matching the real scenario: the corpse's
      // map entry was inserted before the relaunch's fresh session id.
      expect(resolveConnectedEditorForProject([stale, live], { workspaceRoot: "/repo" })).toBe(
        live,
      );
    });

    it("is order-independent — the newest lastSeenAt wins regardless of array position", () => {
      const live = editor({
        session: { id: "live-session" },
        lastSeenAt: "2026-08-10T10:05:00.000Z",
      });
      const stale = editor({
        session: { id: "stale-session" },
        lastSeenAt: "2026-08-10T10:00:00.000Z",
      });
      expect(resolveConnectedEditorForProject([live, stale], { workspaceRoot: "/repo" })).toBe(
        live,
      );
    });
  });
});
