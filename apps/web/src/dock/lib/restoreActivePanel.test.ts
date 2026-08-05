import type { DockviewApi, IDockviewPanel } from "dockview";
import { describe, expect, it } from "vite-plus/test";

import { restoreActivePanelForKey, restoreActivePanelForThread } from "./restoreActivePanel";

function fakePanel(id: string, onSetActive?: () => void): IDockviewPanel {
  return {
    id,
    api: { setActive: () => onSetActive?.() },
  } as unknown as IDockviewPanel;
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
