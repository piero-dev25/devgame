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
  // Every migration fixture below now shows "agents" as the surviving
  // surface. It used to be a browser tab, then "plan" — as of v11 (task
  // #53's fourth slice) "preview" became a retired kind (see the "drops a
  // stale preview surface" test), and as of v12 so did "plan", which
  // upstream retired on its own side when plans moved inline into the
  // transcript. "agents" is the only kind left that can play the "prove the
  // stripped surface's SIBLINGS survive" role at all.
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
              { id: "agents", kind: "agents" },
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
          surfaces: [{ id: "agents", kind: "agents" }],
        },
      },
    });
  });

  it("drops a stale preview (browser) surface during migration (browser moved to a dock panel, task #53)", () => {
    // v11's own addition, following the exact template every prior kind
    // set: strip, don't coerce — `previewStateStore.ts` already carries
    // the equivalent "which tab is open/active" state independently (see
    // BrowserDockPanel.tsx's own doc comment for why this migration needs
    // no coercion logic at all, unlike Terminal's v10 pass).
    expect(
      migratePersistedRightPanelState({
        byThreadKey: {
          "env-1:thread-A": {
            activeSurfaceId: "browser:tab-a",
            surfaces: [
              { id: "agents", kind: "agents" },
              { id: "browser:tab-a", kind: "preview", resourceId: "tab-a" },
              { id: "browser:new", kind: "preview", resourceId: null },
            ],
          },
        },
      }),
    ).toEqual({
      byThreadKey: {
        "env-1:thread-A": {
          isOpen: false,
          activeSurfaceId: null,
          surfaces: [{ id: "agents", kind: "agents" }],
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
              { id: "agents", kind: "agents" },
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
          surfaces: [{ id: "agents", kind: "agents" }],
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
    // earlier "drops a stale diff surface" test (with an agents surface
    // still present) doesn't exercise.
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
      // Merge-gate hardening (2026-08-08): a record migration emptied is now
      // PRUNED, not kept as {isOpen:false, surfaces:[]} — absent and empty
      // mean the same thing to every reader, and the empty rows leaked in
      // localStorage forever. The claim under test is unchanged and now
      // holds even more strongly: no trace of the open-and-empty panel
      // survives at all.
    ).toEqual({ byThreadKey: {} });
  });

  it("drops a stale files (explorer) surface during migration (files moved to a dock panel, task #61)", () => {
    expect(
      migratePersistedRightPanelState({
        byThreadKey: {
          "env-1:thread-A": {
            activeSurfaceId: "files",
            surfaces: [
              { id: "agents", kind: "agents" },
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
          surfaces: [{ id: "agents", kind: "agents" }],
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
      // Pruned-not-kept, same as the diff-only test above (2026-08-08).
    ).toEqual({ byThreadKey: {} });
  });

  it("drops persisted plan surfaces and does not reopen an empty panel", () => {
    // Upstream's own v9 test (plans render inline in the transcript now),
    // kept for the behaviour it proves rather than the fixture it shipped
    // with: thread B's surviving sibling was "diff" upstream, which this
    // fork retired to a dock panel, so it is "agents" here — the only kind
    // that survives migration in the merged build. The claim under test is
    // upstream's and unchanged: when migration drops the surface that was
    // ACTIVE but others survive, the panel stays open and falls back to the
    // first survivor instead of rendering open-and-empty.
    expect(
      migratePersistedRightPanelState({
        byThreadKey: {
          "env-1:thread-A": {
            isOpen: true,
            activeSurfaceId: "plan",
            surfaces: [{ id: "plan", kind: "plan" }],
          },
          "env-1:thread-B": {
            isOpen: true,
            activeSurfaceId: "plan",
            surfaces: [
              { id: "plan", kind: "plan" },
              { id: "agents", kind: "agents" },
            ],
          },
        },
      }),
    ).toEqual({
      byThreadKey: {
        // thread-A (every surface stripped) is pruned outright — see the
        // diff-only test above (2026-08-08) — while thread-B proves the
        // open-panel fallback to the first surviving surface.
        "env-1:thread-B": {
          isOpen: true,
          activeSurfaceId: "agents",
          surfaces: [{ id: "agents", kind: "agents" }],
        },
      },
    });
  });

  it("open sets the active panel for a thread", () => {
    useRightPanelStore.getState().open(refA, "agents");
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBe("agents");
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refB)).toBeNull();
  });

  // "opening a different kind keeps both surfaces and activates the new
  // one" and "reopening an inactive singleton activates its existing
  // surface" used to live here, both leaning on a SECOND kind ("preview",
  // then "diff") to interpose alongside the first — DELETED, not ported, as
  // of task #53's fourth slice, and the upstream merge only widened the
  // reason: every kind those tests used is retired (see RIGHT_PANEL_KINDS's
  // own comment), and "agents" is the ONLY kind left. There is no second
  // kind this store's public API can produce anymore to exercise "two
  // different surfaces coexisting" with — `open`/`toggle` only ever resolve
  // to the one singleton surface `{id:"agents",kind:"agents"}`. This is
  // exactly the "collapse" signal flagged to the owner, not an oversight:
  // keeping these tests would mean either deleting real coverage silently
  // or fabricating an impossible surface via a type cast, and neither is
  // honest about what this store can do today.

  it("keeps agents as a singleton surface", () => {
    useRightPanelStore.getState().open(refA, "agents");
    useRightPanelStore.getState().open(refA, "agents");
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "agents",
      surfaces: [{ id: "agents", kind: "agents" }],
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
    useRightPanelStore.getState().open(refA, "agents");
    useRightPanelStore.getState().close(refA);
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBeNull();
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: false,
      activeSurfaceId: "agents",
      surfaces: [{ id: "agents", kind: "agents" }],
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
    useRightPanelStore.getState().toggle(refA, "agents");
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBe("agents");
    useRightPanelStore.getState().toggle(refA, "agents");
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBeNull();
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: false,
      activeSurfaceId: "agents",
      surfaces: [{ id: "agents", kind: "agents" }],
    });
  });

  // "toggle to a different kind switches active" used to live here (toggle
  // one kind, then another, assert the second wins) — DELETED for the same
  // reason as the two `open`-based tests above: there is no second kind
  // left to toggle between. Upstream still ships this test against
  // "preview" and "agents"; it is not portable here, because "preview" is
  // one of the kinds this fork moved to a dock panel.

  it("removeThread clears persisted state", () => {
    useRightPanelStore.getState().open(refA, "agents");
    useRightPanelStore.getState().removeThread(refA);
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBeNull();
  });

  it("close on never-opened thread is a no-op", () => {
    useRightPanelStore.getState().close(refA);
    expect(useRightPanelStore.getState().byThreadKey).toEqual({});
  });

  // "tracks one surface per browser session" (openBrowser) and "reconciles
  // browser surfaces without deleting other surface kinds"
  // (reconcileBrowserSurfaces) used to live here — DELETED, not moved: both
  // functions are gone from this store as of task #53's fourth slice.
  // `BrowserDockPanel.tsx` needs neither — see its own doc comment for why
  // `previewStateStore.ts` already carried everything a browser tab strip
  // needs, with no reconciliation into this store required at all.

  // "tracks one surface per terminal session", "tracks split panes and the
  // active pane within a terminal surface", "tracks vertical layout for a
  // terminal surface", and "closing the final terminal pane removes its
  // surface and closes the panel" used to live here — DELETED, not just
  // moved, as of task #53: "terminal" is a retired kind this store no
  // longer models at all (see RIGHT_PANEL_KINDS's own comment). The
  // capability itself (which terminal groups are open, split layout, which
  // pane is active) moved to terminalDockStore.ts, with its own equivalent
  // coverage in terminalDockStore.test.ts.

  // "closing the active surface activates a neighboring surface", "closing
  // other surfaces keeps the selected surface active", and "closing
  // surfaces to the right activates the selected surface when active was
  // removed" used to live here, each seeding a SECOND surface (a browser
  // tab, then later a plan surface after Terminal's own promotion) to
  // exercise `closeSurface`'s neighbor-fallback, `closeOtherSurfaces`, and
  // `closeSurfacesToRight`. DELETED, not ported to a synthetic two-surface
  // state: with "agents" as the only kind left AND a singleton, this
  // store's real public API (`open`/`toggle`) can never produce more than
  // one surface at a time — `surfaces` physically cannot exceed length 1
  // through any type-safe call. Constructing a second surface here would
  // mean type-casting past `RightPanelSurface` to fabricate a kind that
  // cannot exist, which would test an impossible state rather than real
  // behaviour. `closeOtherSurfaces` and `closeSurfacesToRight` are
  // therefore DEAD CODE as of this slice — still exported, still callable,
  // but unreachable from any real UI action, since `RightPanelTabs`' own
  // multi-surface tab strip (its context menu's "close others"/"close to
  // the right" items) can equally never see more than one tab. This is
  // exactly the "collapse" signal flagged to the owner in
  // rightPanelStore.ts's own top comment, not an oversight.

  it("closing the final surface closes the panel", () => {
    useRightPanelStore.getState().open(refA, "agents");
    useRightPanelStore.getState().closeSurface(refA, "agents");

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: false,
      activeSurfaceId: null,
      surfaces: [],
    });
  });

  it("closing all surfaces closes the panel", () => {
    useRightPanelStore.getState().open(refA, "agents");

    useRightPanelStore.getState().closeAllSurfaces(refA);

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: false,
      activeSurfaceId: null,
      surfaces: [],
    });
  });

  it("selectActiveRightPanelSurface returns null when the panel is closed", () => {
    useRightPanelStore.getState().open(refA, "agents");
    useRightPanelStore.getState().close(refA);
    expect(
      selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA),
    ).toBeNull();
  });
});
