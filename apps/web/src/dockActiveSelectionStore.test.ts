import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  recordActivePanelForKey,
  recordActivePanelForKeyUnlessRestoring,
  selectActivePanelForKey,
  useDockActiveSelectionStore,
} from "./dockActiveSelectionStore";

beforeEach(() => {
  useDockActiveSelectionStore.setState({ byActivationKey: {} });
});

describe("dockActiveSelectionStore — defaults", () => {
  it("defaults an unset key to null", () => {
    expect(
      selectActivePanelForKey(useDockActiveSelectionStore.getState().byActivationKey, "thread-A"),
    ).toBeNull();
  });

  it("defaults an undefined key to null, without touching the store", () => {
    expect(
      selectActivePanelForKey(useDockActiveSelectionStore.getState().byActivationKey, undefined),
    ).toBeNull();
  });
});

// Task #108's actual repro: A(Browser) -> B(Diff) -> back to A must read
// "browser" for A, never whatever B most recently wrote.
describe("dockActiveSelectionStore — is isolated per key", () => {
  it("recording B's selection does not change what A reads", () => {
    useDockActiveSelectionStore.getState().setActivePanel("thread-A", "browser");
    useDockActiveSelectionStore.getState().setActivePanel("thread-B", "diff");

    expect(
      selectActivePanelForKey(useDockActiveSelectionStore.getState().byActivationKey, "thread-A"),
    ).toBe("browser");
    expect(
      selectActivePanelForKey(useDockActiveSelectionStore.getState().byActivationKey, "thread-B"),
    ).toBe("diff");
  });
});

describe("dockActiveSelectionStore — setActivePanel", () => {
  it("overwrites a key's previous value on a later call", () => {
    useDockActiveSelectionStore.getState().setActivePanel("thread-A", "browser");
    useDockActiveSelectionStore.getState().setActivePanel("thread-A", "diff");

    expect(
      selectActivePanelForKey(useDockActiveSelectionStore.getState().byActivationKey, "thread-A"),
    ).toBe("diff");
  });

  it("clears the entry entirely when panelId is null", () => {
    useDockActiveSelectionStore.getState().setActivePanel("thread-A", "browser");
    useDockActiveSelectionStore.getState().setActivePanel("thread-A", null);

    expect("thread-A" in useDockActiveSelectionStore.getState().byActivationKey).toBe(false);
  });
});

// Task #108, QA round 3 reopen: `recordActivePanelForKey` is the WRITE-side
// counterpart `DockviewLayout.tsx`'s mount effect now calls from BOTH the
// top-level `onDidActivePanelChange` subscription AND (new this round) each
// group's own `onDidActivePanelChange` — see that effect's own comment for
// why the second one exists (a tab flip inside a group that isn't dockview's
// currently-active group is invisible to the top-level event alone). These
// tests cover the pure decision (is there a thread to record against, and
// under which key string) as far as a function that writes into a real
// Zustand store CAN be unit-tested — NOT the dockview-core subscription
// wiring itself, which has no jsdom to drive; see this round's report for
// what only live QA proves.
describe("recordActivePanelForKey", () => {
  it("activationKey: undefined is a silent no-op — never touches the store", () => {
    recordActivePanelForKey(undefined, "browser");

    expect(useDockActiveSelectionStore.getState().byActivationKey).toEqual({});
  });

  it("records panelId under String(activationKey), readable back via selectActivePanelForKey", () => {
    recordActivePanelForKey("thread-A", "browser");

    expect(
      selectActivePanelForKey(useDockActiveSelectionStore.getState().byActivationKey, "thread-A"),
    ).toBe("browser");
  });

  it("a numeric activationKey is converted via String(), the same conversion restoreActivePanelForThread's caller applies", () => {
    recordActivePanelForKey(42, "diff");

    expect(
      selectActivePanelForKey(useDockActiveSelectionStore.getState().byActivationKey, "42"),
    ).toBe("diff");
  });

  it("panelId: null clears the key's entry — the shape DockviewLayout.tsx's `panel?.id ?? null` produces when nothing is active", () => {
    recordActivePanelForKey("thread-A", "browser");
    recordActivePanelForKey("thread-A", null);

    expect("thread-A" in useDockActiveSelectionStore.getState().byActivationKey).toBe(false);
  });
});

// Task #108, round 4 (live QA, merge-gate finding F7): the suppression half
// of the fix — `DockviewLayout.tsx` now calls THIS, not `recordActivePanelForKey`
// directly, from both its onDidActivePanelChange subscriptions, passing
// `isRestoringRef.current`. See `recordActivePanelForKeyUnlessRestoring`'s
// own doc comment for the traced root cause (restoreActivePanelForKey's
// `panel.group.api.setActive()` step can transiently re-fire dockview's
// top-level event with the group's OLD panel) and this round's report for
// why a headless dockview-core repro showed the transient self-corrects to
// the right final value even WITHOUT this guard — meaning these tests below
// prove the SUPPRESSION mechanism itself works, not that it fixes an
// observed-wrong final value (there wasn't one to reproduce here).
describe("recordActivePanelForKeyUnlessRestoring", () => {
  it("isRestoring: true suppresses the write entirely, even for an otherwise-valid key/panelId", () => {
    recordActivePanelForKeyUnlessRestoring(true, "thread-A", "diff");

    expect(useDockActiveSelectionStore.getState().byActivationKey).toEqual({});
  });

  it("isRestoring: false delegates to recordActivePanelForKey — identical behaviour to calling it directly", () => {
    recordActivePanelForKeyUnlessRestoring(false, "thread-A", "diff");

    expect(
      selectActivePanelForKey(useDockActiveSelectionStore.getState().byActivationKey, "thread-A"),
    ).toBe("diff");
  });

  it("a value already in the store before a suppressed call survives it unchanged — restore never needs to write what it's only applying", () => {
    recordActivePanelForKey("thread-A", "files");

    recordActivePanelForKeyUnlessRestoring(true, "thread-A", "diff");

    expect(
      selectActivePanelForKey(useDockActiveSelectionStore.getState().byActivationKey, "thread-A"),
    ).toBe("files");
  });
});
