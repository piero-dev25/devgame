import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  CHROME_PANEL_IDS,
  recordActivePanelForKey,
  recordActivePanelForKeyUnlessRestoring,
  selectActivePanelForKey,
  SETTLE_MS,
  SIDEBAR_PANEL_ID,
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
  // `SETTLE_MS` itself as the "settled" sentinel throughout this describe
  // block (except the round-7 tests below, which exist specifically to test
  // the settle window) — `msSinceSwitch < SETTLE_MS` is false at exactly
  // `SETTLE_MS`, so this reliably clears the settle guard without a magic
  // "large enough" number.
  it("isRestoring: true suppresses the write entirely, even for an otherwise-valid key/panelId", () => {
    recordActivePanelForKeyUnlessRestoring(true, SETTLE_MS, "thread-A", "diff");

    expect(useDockActiveSelectionStore.getState().byActivationKey).toEqual({});
  });

  it("isRestoring: false, settled: delegates to recordActivePanelForKey — identical behaviour to calling it directly", () => {
    recordActivePanelForKeyUnlessRestoring(false, SETTLE_MS, "thread-A", "diff");

    expect(
      selectActivePanelForKey(useDockActiveSelectionStore.getState().byActivationKey, "thread-A"),
    ).toBe("diff");
  });

  it("a value already in the store before a suppressed call survives it unchanged — restore never needs to write what it's only applying", () => {
    recordActivePanelForKey("thread-A", "files");

    recordActivePanelForKeyUnlessRestoring(true, SETTLE_MS, "thread-A", "diff");

    expect(
      selectActivePanelForKey(useDockActiveSelectionStore.getState().byActivationKey, "thread-A"),
    ).toBe("files");
  });

  // Task #108, round 6 (live QA, diagnostic-build repro, all four "return to
  // a thread" windows log-confirmed): the sidebar thread-list panel is a
  // real dockview panel, so clicking a thread to navigate fires a genuine
  // onDidActivePanelChange for it SYNCHRONOUSLY, before React commits the
  // new activationKey — landing a "sidebar" write under the OUTGOING
  // thread's key on every single switch. See CHROME_PANEL_IDS's own doc
  // comment (dockActiveSelectionStore.ts) for the full traced mechanism.
  it("ignores a CHROME_PANEL_IDS member even when isRestoring is false and settled — a real, unsuppressed sidebar activation must not overwrite a thread's real selection", () => {
    recordActivePanelForKey("thread-A", "files");

    recordActivePanelForKeyUnlessRestoring(false, SETTLE_MS, "thread-A", SIDEBAR_PANEL_ID);

    expect(
      selectActivePanelForKey(useDockActiveSelectionStore.getState().byActivationKey, "thread-A"),
    ).toBe("files");
  });

  it("still records a non-chrome panelId normally when settled — the filter is scoped to CHROME_PANEL_IDS, not a blanket suppression", () => {
    recordActivePanelForKeyUnlessRestoring(false, SETTLE_MS, "thread-A", "diff");

    expect(
      selectActivePanelForKey(useDockActiveSelectionStore.getState().byActivationKey, "thread-A"),
    ).toBe("diff");
  });

  it("CHROME_PANEL_IDS contains SIDEBAR_PANEL_ID — sanity check the fixture matches the real set, not a copy of the literal", () => {
    expect(CHROME_PANEL_IDS.has(SIDEBAR_PANEL_ID)).toBe(true);
  });

  // Task #108, round 7 (live QA, diagnostic-build repro — dock-diag2,
  // 2026-08-05): the settle-window half of the fix. See `SETTLE_MS`'s own
  // doc comment for the traced mechanism — a Chat-panel autofocus echo
  // landing 9-23ms after every restore, unsuppressed by round 4's
  // `isRestoring` guard because it fires asynchronously, outside that
  // guard's synchronous window.
  describe("the settle window (round 7)", () => {
    it("an event 20ms after the switch, panelId=chat, is NOT recorded — this is the measured echo shape, and the literal bug this round closes", () => {
      recordActivePanelForKeyUnlessRestoring(false, 20, "thread-A", "chat");

      expect(useDockActiveSelectionStore.getState().byActivationKey).toEqual({});
    });

    it("an event 300ms after the switch IS recorded — the window suppresses the echo, not every activation after a switch", () => {
      recordActivePanelForKeyUnlessRestoring(false, 300, "thread-A", "chat");

      expect(
        selectActivePanelForKey(useDockActiveSelectionStore.getState().byActivationKey, "thread-A"),
      ).toBe("chat");
    });

    it("msSinceSwitch exactly at SETTLE_MS is NOT suppressed by the settle guard — the boundary belongs to the caller, not the echo", () => {
      recordActivePanelForKeyUnlessRestoring(false, SETTLE_MS, "thread-A", "chat");

      expect(
        selectActivePanelForKey(useDockActiveSelectionStore.getState().byActivationKey, "thread-A"),
      ).toBe("chat");
    });

    it("all three guards compose independently: isRestoring alone suppresses even when settled and non-chrome", () => {
      recordActivePanelForKeyUnlessRestoring(true, SETTLE_MS, "thread-A", "diff");

      expect(useDockActiveSelectionStore.getState().byActivationKey).toEqual({});
    });

    it("all three guards compose independently: the settle window alone suppresses even when not restoring and non-chrome", () => {
      recordActivePanelForKeyUnlessRestoring(false, 20, "thread-A", "diff");

      expect(useDockActiveSelectionStore.getState().byActivationKey).toEqual({});
    });

    it("all three guards compose independently: CHROME_PANEL_IDS alone suppresses even when not restoring and settled", () => {
      recordActivePanelForKeyUnlessRestoring(false, SETTLE_MS, "thread-A", SIDEBAR_PANEL_ID);

      expect(useDockActiveSelectionStore.getState().byActivationKey).toEqual({});
    });

    it("clearing all three guards at once records normally", () => {
      recordActivePanelForKeyUnlessRestoring(false, SETTLE_MS, "thread-A", "files");

      expect(
        selectActivePanelForKey(useDockActiveSelectionStore.getState().byActivationKey, "thread-A"),
      ).toBe("files");
    });
  });
});
