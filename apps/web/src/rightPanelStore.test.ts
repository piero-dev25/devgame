import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  migratePersistedRightPanelState,
  selectActiveRightPanel,
  selectActiveRightPanelSurface,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "./rightPanelStore";

const refA = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));
const refB = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-B"));

beforeEach(() => {
  useRightPanelStore.setState({ byThreadKey: {} });
});

describe("rightPanelStore", () => {
  it("drops a stale terminal surface during migration (terminal moved to a dock panel, task #53)", () => {
    // Covers BOTH shapes a persisted "terminal" surface could be — the
    // legacy singleton (`{id:"terminal",kind:"terminal"}`, no
    // terminalIds/activeTerminalId) and the split-capable shape v9 already
    // normalized (`{id:"terminal:term-1",kind:"terminal",terminalIds:[...],
    // activeTerminalId:...}`) — both are simply STRIPPED as of v10, same as
    // "diff"/"files"/"file" before it. There is nothing left to normalize;
    // the equivalent state (which terminal groups are open, split layout)
    // moved to terminalDockStore.ts, with its own equivalent coverage in
    // terminalDockStore.test.ts.
    expect(
      migratePersistedRightPanelState({
        byThreadKey: {
          "env-1:thread-A": {
            activeSurfaceId: "terminal",
            surfaces: [
              { id: "browser:tab-a", kind: "preview", resourceId: "tab-a" },
              { id: "terminal", kind: "terminal" },
              {
                id: "terminal:term-1",
                kind: "terminal",
                resourceId: "term-1",
                terminalIds: ["term-1"],
                activeTerminalId: "term-1",
              },
            ],
          },
        },
      }),
    ).toEqual({
      byThreadKey: {
        "env-1:thread-A": {
          isOpen: false,
          activeSurfaceId: null,
          surfaces: [{ id: "browser:tab-a", kind: "preview", resourceId: "tab-a" }],
        },
      },
    });
  });

  it("drops a stale diff surface during migration (diff moved to a dock panel)", () => {
    expect(
      migratePersistedRightPanelState({
        byThreadKey: {
          "env-1:thread-A": {
            activeSurfaceId: "diff",
            surfaces: [
              { id: "browser:tab-a", kind: "preview", resourceId: "tab-a" },
              { id: "diff", kind: "diff" },
            ],
          },
        },
      }),
    ).toEqual({
      byThreadKey: {
        "env-1:thread-A": {
          isOpen: false,
          activeSurfaceId: null,
          surfaces: [{ id: "browser:tab-a", kind: "preview", resourceId: "tab-a" }],
        },
      },
    });
  });

  it("closes the panel when the ONLY surface was diff — a persisted isOpen: true must not survive its one surface being stripped", () => {
    // Review fix (#56): the v8 migration used to carry `isOpen` straight
    // through from what was persisted, so a thread whose sole surface was
    // "diff" migrated to {isOpen: true, activeSurfaceId: null, surfaces:
    // []} — a visibly-open, silently-empty right panel on resume, since
    // ChatView.tsx's `rightPanelOpen` reads `isOpen` with no surfaces-length
    // guard. This fixture is deliberately the single-surface case the
    // earlier "drops a stale diff surface" test (with a browser tab still
    // present) doesn't exercise.
    expect(
      migratePersistedRightPanelState({
        byThreadKey: {
          "env-1:thread-A": {
            isOpen: true,
            activeSurfaceId: "diff",
            surfaces: [{ id: "diff", kind: "diff" }],
          },
        },
      }),
    ).toEqual({
      byThreadKey: {
        "env-1:thread-A": {
          isOpen: false,
          activeSurfaceId: null,
          surfaces: [],
        },
      },
    });
  });

  it("drops a stale files (explorer) surface during migration (files moved to a dock panel, task #61)", () => {
    expect(
      migratePersistedRightPanelState({
        byThreadKey: {
          "env-1:thread-A": {
            activeSurfaceId: "files",
            surfaces: [
              { id: "browser:tab-a", kind: "preview", resourceId: "tab-a" },
              { id: "files", kind: "files" },
            ],
          },
        },
      }),
    ).toEqual({
      byThreadKey: {
        "env-1:thread-A": {
          isOpen: false,
          activeSurfaceId: null,
          surfaces: [{ id: "browser:tab-a", kind: "preview", resourceId: "tab-a" }],
        },
      },
    });
  });

  it("drops a stale file surface during migration — the old upgrade-with-neutral-reveal-state behaviour is retired, not preserved (task #61)", () => {
    // This used to be "upgrades saved file surfaces with neutral reveal
    // state," coercing revealLine/revealRequestId to safe defaults on an
    // old save. As of v9, "file" is a retired kind (like "files"/"diff"
    // before it) — there is nothing left to coerce, only to strip. The
    // equivalent "which file was open" state, for a build new enough to
    // have used fileExplorerStore.ts in the first place, is that store's
    // own concern now, not this migration's.
    expect(
      migratePersistedRightPanelState({
        byThreadKey: {
          "env-1:thread-A": {
            isOpen: true,
            activeSurfaceId: "file:src/index.ts",
            surfaces: [{ id: "file:src/index.ts", kind: "file", relativePath: "src/index.ts" }],
          },
        },
      }),
    ).toEqual({
      byThreadKey: {
        "env-1:thread-A": {
          isOpen: false,
          activeSurfaceId: null,
          surfaces: [],
        },
      },
    });
  });

  it("open sets the active panel for a thread", () => {
    useRightPanelStore.getState().open(refA, "preview");
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBe("preview");
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refB)).toBeNull();
  });

  it("opening a different kind keeps both surfaces and activates the new one", () => {
    useRightPanelStore.getState().open(refA, "plan");
    useRightPanelStore.getState().open(refA, "preview");
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBe("preview");
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA).surfaces,
    ).toHaveLength(2);
  });

  it("reopening an inactive singleton activates its existing surface", () => {
    // "files" was task #61's own replacement for this test's original
    // "diff" example kind (during #56's review-fix round) — now retired
    // too. "plan" is the only simple singleton left reachable via open();
    // "preview" is a genuine second kind to interpose (its own open()
    // branch, distinct surface shape).
    useRightPanelStore.getState().open(refA, "plan");
    useRightPanelStore.getState().open(refA, "preview");
    useRightPanelStore.getState().open(refA, "plan");

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "plan",
      surfaces: [
        { id: "plan", kind: "plan" },
        { id: "browser:new", kind: "preview", resourceId: null },
      ],
    });
  });

  it("keeps plan as a singleton surface", () => {
    useRightPanelStore.getState().open(refA, "plan");
    useRightPanelStore.getState().open(refA, "plan");
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "plan",
      surfaces: [{ id: "plan", kind: "plan" }],
    });
  });

  // "replaces the standalone explorer with peer file surfaces", "updates
  // line reveal requests when reopening a file surface", and "removes
  // persisted file surfaces when their workspace no longer exists" used to
  // live here — DELETED, not just moved, as of task #61: "files"/"file"
  // are retired kinds this store no longer models at all (see
  // RIGHT_PANEL_KINDS's own comment). The capability itself (which file is
  // open, revealLine/revealRequestId, reconciling on workspace loss) moved
  // to fileExplorerStore.ts, with its own equivalent coverage in
  // fileExplorerStore.test.ts — "keeps an already-open path's position but
  // still bumps revealRequestId" for the reveal-request case, and the
  // "reconcileFiles" describe block for the workspace-loss case. The
  // standalone-explorer-removal assertion specifically is NOT ported: the
  // new store deliberately does NOT remove the explorer when a file opens
  // (an explicit, documented simplification — see fileExplorerStore.ts's
  // own module doc), so porting that exact assertion would just assert the
  // OLD, now-wrong behaviour.

  it("close hides the panel without clearing its selected surface", () => {
    useRightPanelStore.getState().open(refA, "plan");
    useRightPanelStore.getState().close(refA);
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBeNull();
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: false,
      activeSurfaceId: "plan",
      surfaces: [{ id: "plan", kind: "plan" }],
    });
  });

  it("toggles empty panel visibility without creating a surface", () => {
    useRightPanelStore.getState().toggleVisibility(refA);
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: null,
      surfaces: [],
    });

    useRightPanelStore.getState().toggleVisibility(refA);
    expect(useRightPanelStore.getState().byThreadKey).toEqual({});
  });

  it("toggle hides the panel without discarding the active surface", () => {
    useRightPanelStore.getState().toggle(refA, "plan");
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBe("plan");
    useRightPanelStore.getState().toggle(refA, "plan");
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBeNull();
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: false,
      activeSurfaceId: "plan",
      surfaces: [{ id: "plan", kind: "plan" }],
    });
  });

  it("toggle to a different kind switches active", () => {
    useRightPanelStore.getState().toggle(refA, "preview");
    useRightPanelStore.getState().toggle(refA, "plan");
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBe("plan");
  });

  it("removeThread clears persisted state", () => {
    useRightPanelStore.getState().open(refA, "plan");
    useRightPanelStore.getState().removeThread(refA);
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBeNull();
  });

  it("close on never-opened thread is a no-op", () => {
    useRightPanelStore.getState().close(refA);
    expect(useRightPanelStore.getState().byThreadKey).toEqual({});
  });

  it("tracks one surface per browser session", () => {
    useRightPanelStore.getState().openBrowser(refA, "tab-a");
    useRightPanelStore.getState().openBrowser(refA, "tab-b");

    const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);
    expect(state.surfaces.map((surface) => surface.id)).toEqual(["browser:tab-a", "browser:tab-b"]);
    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      id: "browser:tab-b",
      kind: "preview",
      resourceId: "tab-b",
    });
  });

  // "tracks one surface per terminal session", "tracks split panes and the
  // active pane within a terminal surface", "tracks vertical layout for a
  // terminal surface", and "closing the final terminal pane removes its
  // surface and closes the panel" used to live here — DELETED, not just
  // moved, as of task #53: "terminal" is a retired kind this store no
  // longer models at all (see RIGHT_PANEL_KINDS's own comment). The
  // capability itself (which terminal groups are open, split layout, which
  // pane is active) moved to terminalDockStore.ts, with its own equivalent
  // coverage in terminalDockStore.test.ts. The four "mixed surface kind"
  // tests below that used to lean on `openTerminal` as their non-preview,
  // non-plan stand-in now use `open(refA, "plan")` instead — their own
  // intent was never terminal-specific.

  it("closing the active surface activates a neighboring surface", () => {
    useRightPanelStore.getState().openBrowser(refA, "tab-a");
    useRightPanelStore.getState().open(refA, "plan");
    useRightPanelStore.getState().closeSurface(refA, "plan");

    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA)?.id).toBe(
      "browser:tab-a",
    );
  });

  it("closing the final surface closes the panel", () => {
    useRightPanelStore.getState().open(refA, "plan");
    useRightPanelStore.getState().closeSurface(refA, "plan");

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: false,
      activeSurfaceId: null,
      surfaces: [],
    });
  });

  it("closing other surfaces keeps the selected surface active", () => {
    useRightPanelStore.getState().openBrowser(refA, "tab-a");
    useRightPanelStore.getState().open(refA, "plan");

    useRightPanelStore.getState().closeOtherSurfaces(refA, "plan");

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "plan",
      surfaces: [{ id: "plan", kind: "plan" }],
    });
  });

  it("closing surfaces to the right activates the selected surface when active was removed", () => {
    useRightPanelStore.getState().openBrowser(refA, "tab-a");
    useRightPanelStore.getState().open(refA, "plan");

    useRightPanelStore.getState().closeSurfacesToRight(refA, "browser:tab-a");

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "browser:tab-a",
      surfaces: [{ id: "browser:tab-a", kind: "preview", resourceId: "tab-a" }],
    });
  });

  it("closing all surfaces closes the panel", () => {
    useRightPanelStore.getState().openBrowser(refA, "tab-a");
    useRightPanelStore.getState().open(refA, "plan");

    useRightPanelStore.getState().closeAllSurfaces(refA);

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: false,
      activeSurfaceId: null,
      surfaces: [],
    });
  });

  it("reconciles browser surfaces without deleting other surface kinds", () => {
    useRightPanelStore.getState().open(refA, "plan");
    useRightPanelStore.getState().openBrowser(refA, "tab-a");
    useRightPanelStore.getState().openBrowser(refA, "tab-b");
    useRightPanelStore.getState().reconcileBrowserSurfaces(refA, ["tab-b", "tab-c"]);

    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA).surfaces.map(
        (surface) => surface.id,
      ),
    ).toEqual(["plan", "browser:tab-b", "browser:tab-c"]);
  });
});
