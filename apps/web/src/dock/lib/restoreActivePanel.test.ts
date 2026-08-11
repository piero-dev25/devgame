import type { DockviewApi, DockviewGroupPanel, IDockviewPanel } from "dockview";
import { describe, expect, it } from "vite-plus/test";

import { SIDEBAR_PANEL_ID } from "~/dockActiveSelectionStore";

import { restoreActivePanelForKey, restoreActivePanelForThread } from "./restoreActivePanel";

function fakePanel(
  id: string,
  onSetActive?: () => void,
  group?: DockviewGroupPanel,
): IDockviewPanel {
  return {
    id,
    group,
    api: { setActive: () => onSetActive?.() },
  } as unknown as IDockviewPanel;
}

// Task #108, QA round 3 reopen: models dockview-core's real
// `panel.group.api.setActive()` -> `panel.api.setActive()` distinction (see
// `restoreActivePanel.ts`'s own doc comment for the traced root cause) —
// unlike `fakePanel` above, which has no group by default and stays that way
// on purpose for the pre-existing tests below (they must keep passing
// unmodified: a stub with no group at all is a real case this function has
// to tolerate, not just the new one it now also has to get right).
function fakeGroup(onSetActive: () => void): DockviewGroupPanel {
  return { api: { setActive: onSetActive } } as unknown as DockviewGroupPanel;
}

function fakeApi(overrides: {
  getPanel?: (id: string) => IDockviewPanel | undefined;
}): DockviewApi {
  return {
    getPanel: overrides.getPanel ?? (() => undefined),
  } as unknown as DockviewApi;
}

// Task #108: the outer dock tab-selection leak. Repro was A(Browser) ->
// B(Diff) -> back to A, where A incorrectly showed Diff instead of Browser.
// This is the red case for that bug: proves the REMEMBERED panel wins over
// whatever fallback a caller names, not merely that a value was stored.
describe("restoreActivePanelForKey — a remembered panel is open in the live layout", () => {
  it("activates the remembered panel, not the fallback", () => {
    let browserActivated = false;
    let chatActivated = false;
    const api = fakeApi({
      getPanel: (id) => {
        if (id === "browser") return fakePanel("browser", () => (browserActivated = true));
        if (id === "chat") return fakePanel("chat", () => (chatActivated = true));
        return undefined;
      },
    });

    restoreActivePanelForKey(api, { rememberedPanelId: "browser", fallbackPanelId: "chat" });

    expect(browserActivated).toBe(true);
    expect(chatActivated).toBe(false);
  });
});

// Task #108, QA round 3 reopen ("per-thread tab selection leaks when two
// panels share ONE dock group"): the ordering assertion here is the red case
// for THIS round — it fails against a panel-only restore (the pre-fix
// implementation calls only `panel.api.setActive()`, so `calls` would be
// `["panel"]`, never reaching the group at all) and passes once the group is
// activated first. See `restoreActivePanel.ts`'s own doc comment for why
// that ordering, not the panel alone, is what actually closes the leak.
describe("restoreActivePanelForKey — the panel's group is activated first (task #108 round 3)", () => {
  it("activates the panel's GROUP before the panel itself", () => {
    const calls: string[] = [];
    const group = fakeGroup(() => calls.push("group"));
    const api = fakeApi({
      getPanel: (id) =>
        id === "diff" ? fakePanel("diff", () => calls.push("panel"), group) : undefined,
    });

    restoreActivePanelForKey(api, { rememberedPanelId: "diff" });

    expect(calls).toEqual(["group", "panel"]);
  });

  it("also orders the FALLBACK panel's group before the panel — the fallback path shares the same helper", () => {
    const calls: string[] = [];
    const group = fakeGroup(() => calls.push("group"));
    const api = fakeApi({
      getPanel: (id) =>
        id === "chat" ? fakePanel("chat", () => calls.push("panel"), group) : undefined,
    });

    restoreActivePanelForKey(api, { rememberedPanelId: null, fallbackPanelId: "chat" });

    expect(calls).toEqual(["group", "panel"]);
  });

  it("a panel with no group (stub/edge context) still activates — the group half is a safe no-op, not a throw", () => {
    let panelActivated = false;
    const api = fakeApi({
      getPanel: (id) =>
        id === "diff" ? fakePanel("diff", () => (panelActivated = true)) : undefined,
    });

    expect(() => restoreActivePanelForKey(api, { rememberedPanelId: "diff" })).not.toThrow();
    expect(panelActivated).toBe(true);
  });
});

// Task #108, round 4 (live QA, merge-gate finding F7): models the REAL
// dockview-core event sequence a group-then-panel restore produces — traced
// against the installed dockview-core@7.0.4 source AND independently
// confirmed via a standalone headless dockview-core@7.0.4 + jsdom repro (see
// this round's report for the script): `panel.group.api.setActive()` can
// transiently re-fire dockview's TOP-LEVEL `onDidActivePanelChange` carrying
// the group's OLD active panel (`dockviewComponent.js`'s `doSetGroupActive`
// override calls `fireActivePanelChange(this.activePanel)` using whichever
// panel was ALREADY active in the group at that instant), and the following
// `panel.api.setActive()` then fires it AGAIN, correctly, with the NEW
// panel.
//
// HONEST LIMIT, exactly as the brief for this round anticipated: this does
// NOT go red against the current (post-round-3) `restoreActivePanelForKey`.
// The headless repro proved the transient self-corrects to the right FINAL
// value within the SAME synchronous call, in every scenario it could
// construct — dockview-core's own guarded re-broadcast
// (`dockviewComponent.js:3050-3061`) fires a second, correcting event once
// the group IS the active one, which by this point in the call it already
// is. What round 4 actually adds is `isRestoringRef` /
// `recordActivePanelForKeyUnlessRestoring` in `DockviewLayout.tsx` (see that
// file, and `dockActiveSelectionStore.test.ts`'s own red-then-green pair for
// the suppression mechanism itself — no jsdom exists here to drive
// `DockviewLayout`'s own subscriptions end to end), which suppresses BOTH
// fires unconditionally, rather than continuing to rely on dockview-core's
// own correction timing to keep bailing this out. This test's narrower job:
// document that the sequence really is [OLD, NEW] — F7 is real — and that
// restoreActivePanelForKey's group-then-panel ordering (proven above) is
// exactly what makes NEW the LAST call, which is what the self-correction
// depends on upstream of the suppression.
describe("restoreActivePanelForKey — F7 event sequence (task #108, round 4)", () => {
  it("group.api.setActive() transiently fires with the group's OLD active panel, THEN panel.api.setActive() fires with the correct NEW one", () => {
    const topLevelFires: string[] = [];
    // simulates dockviewComponent.js's doSetGroupActive -> fireActivePanelChange(oldActivePanel)
    const group = fakeGroup(() => topLevelFires.push("diff"));
    const api = fakeApi({
      getPanel: (id) =>
        id === "files"
          ? // simulates the SUBSEQUENT, corrected top-level fire once the group is active
            fakePanel("files", () => topLevelFires.push("files"), group)
          : undefined,
    });

    restoreActivePanelForKey(api, { rememberedPanelId: "files" });

    expect(topLevelFires).toEqual(["diff", "files"]);
    expect(topLevelFires.at(-1)).toBe("files");
  });
});

describe("restoreActivePanelForKey — nothing remembered yet (a thread visited for the first time)", () => {
  it("falls back to fallbackPanelId — preserves fix-round finding #5's original guarantee", () => {
    let chatActivated = false;
    const api = fakeApi({
      getPanel: (id) =>
        id === "chat" ? fakePanel("chat", () => (chatActivated = true)) : undefined,
    });

    restoreActivePanelForKey(api, { rememberedPanelId: null, fallbackPanelId: "chat" });

    expect(chatActivated).toBe(true);
  });
});

describe("restoreActivePanelForKey — the remembered panel was since closed", () => {
  it("falls back rather than silently no-oping on a panel id that's no longer open", () => {
    let chatActivated = false;
    const api = fakeApi({
      getPanel: (id) =>
        id === "chat" ? fakePanel("chat", () => (chatActivated = true)) : undefined,
    });

    restoreActivePanelForKey(api, { rememberedPanelId: "diff", fallbackPanelId: "chat" });

    expect(chatActivated).toBe(true);
  });
});

describe("restoreActivePanelForKey — nothing remembered, no fallback given", () => {
  it("no-ops silently rather than throwing", () => {
    const api = fakeApi({ getPanel: () => undefined });

    expect(() => restoreActivePanelForKey(api, { rememberedPanelId: null })).not.toThrow();
  });
});

// F3 (2026-08-05, merge-gate review): `restoreActivePanelForThread` is the
// function BOTH of `DockviewLayout.tsx`'s call sites now share — the
// activation-key-change effect (a thread switch on an already-mounted dock)
// and `loadInitialLayout`'s own post-mount correction (the root cause: an
// initial `fromJSON`/`applyPreset` applies the shared blob's or preset's own
// GLOBAL active panel, and nothing corrected it to the CURRENT thread's
// remembered selection). These tests cover the `byActivationKey` ->
// `selectActivePanelForKey` -> `restoreActivePanelForKey` wiring end to end
// — including the `String(activationKey)` conversion and the `undefined`
// guard, NEITHER of which the tests above ever exercised (they always
// called `restoreActivePanelForKey` with an already-computed
// `rememberedPanelId`, never touching `byActivationKey` or a real
// `activationKey` value at all).
//
// HONEST LIMIT: this proves the DECISION is correct given a snapshot of
// state. It does NOT and CANNOT prove `DockviewLayout.tsx`'s own
// `loadInitialLayout` actually CALLS this at the right point in its
// sequence (after `fromJSON`/`applyPreset`, before the auto-save
// subscriptions) — that would require running the component's real
// `useEffect`s, which nothing in this repo's test environment can do
// (`apps/web/vite.config.ts` has no DOM environment configured,
// `@testing-library/react` isn't a dependency — the same structural
// constraint `TerminalDockPanel.test.tsx`'s own doc comment already
// establishes, mutation-proven there, not re-derived here).
describe("restoreActivePanelForThread", () => {
  it("a numeric activationKey is looked up via String(activationKey), the same conversion the caller applies", () => {
    let browserActivated = false;
    const api = fakeApi({
      getPanel: (id) =>
        id === "browser" ? fakePanel("browser", () => (browserActivated = true)) : undefined,
    });

    restoreActivePanelForThread(api, {
      byActivationKey: { "env-1:thread-42": "browser" },
      activationKey: "env-1:thread-42",
      fallbackPanelId: "chat",
    });

    expect(browserActivated).toBe(true);
  });

  it("activationKey: undefined (no thread yet) is a silent no-op — never falls back, never throws", () => {
    let chatActivated = false;
    const api = fakeApi({
      getPanel: (id) =>
        id === "chat" ? fakePanel("chat", () => (chatActivated = true)) : undefined,
    });

    expect(() =>
      restoreActivePanelForThread(api, {
        byActivationKey: { "env-1:thread-42": "browser" },
        activationKey: undefined,
        fallbackPanelId: "chat",
      }),
    ).not.toThrow();
    expect(chatActivated).toBe(false);
  });

  it("a thread with no entry in byActivationKey falls back — the F3 first-mount case for a brand-new thread", () => {
    let chatActivated = false;
    const api = fakeApi({
      getPanel: (id) =>
        id === "chat" ? fakePanel("chat", () => (chatActivated = true)) : undefined,
    });

    restoreActivePanelForThread(api, {
      byActivationKey: {},
      activationKey: "env-1:brand-new-thread",
      fallbackPanelId: "chat",
    });

    expect(chatActivated).toBe(true);
  });

  it("the remembered panel for THIS thread wins even when other threads have different remembered panels", () => {
    let diffActivated = false;
    let browserActivated = false;
    const api = fakeApi({
      getPanel: (id) => {
        if (id === "diff") return fakePanel("diff", () => (diffActivated = true));
        if (id === "browser") return fakePanel("browser", () => (browserActivated = true));
        return undefined;
      },
    });

    restoreActivePanelForThread(api, {
      byActivationKey: { "env-1:thread-A": "browser", "env-1:thread-B": "diff" },
      activationKey: "env-1:thread-B",
      fallbackPanelId: "chat",
    });

    expect(diffActivated).toBe(true);
    expect(browserActivated).toBe(false);
  });
});

// Task #108, round 6 (live QA, diagnostic-build repro): a `rememberedPanelId`
// that names a chrome panel (the thread-list sidebar) must be treated as NO
// ENTRY, not as a real remembered selection — see `restoreActivePanelForKey`'s
// own doc comment for the traced mechanism (every thread switch recorded
// "sidebar" under the OUTGOING thread's key) and why this read-side guard is
// needed independently of the write-side one: `byActivationKey` persists to
// localStorage, so already-poisoned entries from before this fix survive an
// app restart.
describe("restoreActivePanelForKey — a remembered panel is a chrome id (task #108, round 6)", () => {
  it("falls through to fallbackPanelId when the remembered panel is SIDEBAR_PANEL_ID, exactly like rememberedPanelId: null", () => {
    let chatActivated = false;
    let sidebarActivated = false;
    const api = fakeApi({
      getPanel: (id) => {
        if (id === "chat") return fakePanel("chat", () => (chatActivated = true));
        if (id === SIDEBAR_PANEL_ID)
          return fakePanel(SIDEBAR_PANEL_ID, () => (sidebarActivated = true));
        return undefined;
      },
    });

    restoreActivePanelForKey(api, {
      rememberedPanelId: SIDEBAR_PANEL_ID,
      fallbackPanelId: "chat",
    });

    expect(chatActivated).toBe(true);
    expect(sidebarActivated).toBe(false);
  });

  it("no-ops silently (no fallback given) rather than activating the sidebar — mirrors the null-rememberedPanelId, no-fallback case", () => {
    let sidebarActivated = false;
    const api = fakeApi({
      getPanel: (id) =>
        id === SIDEBAR_PANEL_ID
          ? fakePanel(SIDEBAR_PANEL_ID, () => (sidebarActivated = true))
          : undefined,
    });

    expect(() =>
      restoreActivePanelForKey(api, { rememberedPanelId: SIDEBAR_PANEL_ID }),
    ).not.toThrow();
    expect(sidebarActivated).toBe(false);
  });

  it("restoreActivePanelForThread carries the same guard end to end, from a poisoned byActivationKey entry", () => {
    let chatActivated = false;
    const api = fakeApi({
      getPanel: (id) =>
        id === "chat" ? fakePanel("chat", () => (chatActivated = true)) : undefined,
    });

    // Models exactly the persisted-localStorage shape round 6's live repro
    // produced: A's real "files" selection clobbered to "sidebar" the moment
    // the user switched away.
    restoreActivePanelForThread(api, {
      byActivationKey: { "env-1:thread-A": SIDEBAR_PANEL_ID },
      activationKey: "env-1:thread-A",
      fallbackPanelId: "chat",
    });

    expect(chatActivated).toBe(true);
  });
});
