import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  DIFF_PANEL_ID,
  getChatDockSidebarVisible,
  openChatDockPanel,
  registerChatDockHandle,
  reportChatDockSidebarVisibleChange,
  subscribeChatDockSidebarVisible,
  toggleChatDockPanel,
  toggleChatDockSidebarVisibility,
} from "./chatDockHandle";

// The module-scope slot this file exercises is a SINGLETON — every test must
// leave it null when it's done, or a later test (in this file or another
// that happens to import the same module instance) would silently observe a
// stale handle from a previous test. `sidebarVisible`'s own mirror is the
// same kind of module-scope singleton (dock-chrome-strip.md, Section C) —
// reset back to its default (`true`) the same way.
afterEach(() => {
  registerChatDockHandle(null);
  reportChatDockSidebarVisibleChange(true);
});

function fakeHandle(overrides: {
  openPanel?: (id: string) => void;
  togglePanel?: (id: string) => void;
  toggleSidebarVisibility?: () => void;
}) {
  return {
    openPanel: overrides.openPanel ?? vi.fn(),
    togglePanel: overrides.togglePanel ?? vi.fn(),
    toggleSidebarVisibility: overrides.toggleSidebarVisibility ?? vi.fn(),
  };
}

describe("chatDockHandle — before the dock has registered", () => {
  it("openChatDockPanel no-ops without throwing", () => {
    expect(() => openChatDockPanel(DIFF_PANEL_ID)).not.toThrow();
  });

  it("toggleChatDockPanel no-ops without throwing", () => {
    expect(() => toggleChatDockPanel(DIFF_PANEL_ID)).not.toThrow();
  });

  it("toggleChatDockSidebarVisibility no-ops without throwing", () => {
    expect(() => toggleChatDockSidebarVisibility()).not.toThrow();
  });
});

describe("chatDockHandle — after the dock registers its handle", () => {
  it("routes openChatDockPanel(id) to the registered handle's openPanel", () => {
    const openPanel = vi.fn();
    const togglePanel = vi.fn();
    registerChatDockHandle(fakeHandle({ openPanel, togglePanel }));

    openChatDockPanel(DIFF_PANEL_ID);

    expect(openPanel).toHaveBeenCalledExactlyOnceWith(DIFF_PANEL_ID);
    expect(togglePanel).not.toHaveBeenCalled();
  });

  it("routes toggleChatDockPanel(id) to the registered handle's togglePanel", () => {
    const openPanel = vi.fn();
    const togglePanel = vi.fn();
    registerChatDockHandle(fakeHandle({ openPanel, togglePanel }));

    toggleChatDockPanel(DIFF_PANEL_ID);

    expect(togglePanel).toHaveBeenCalledExactlyOnceWith(DIFF_PANEL_ID);
    expect(openPanel).not.toHaveBeenCalled();
  });

  it("routes toggleChatDockSidebarVisibility() to the registered handle's toggleSidebarVisibility", () => {
    const toggleSidebarVisibility = vi.fn();
    registerChatDockHandle(fakeHandle({ toggleSidebarVisibility }));

    toggleChatDockSidebarVisibility();

    expect(toggleSidebarVisibility).toHaveBeenCalledOnce();
  });
});

describe("chatDockHandle — after the dock unmounts (cleared back to null)", () => {
  it("stops routing to the torn-down handle and no-ops instead", () => {
    const openPanel = vi.fn();
    const togglePanel = vi.fn();
    const toggleSidebarVisibility = vi.fn();
    registerChatDockHandle(fakeHandle({ openPanel, togglePanel, toggleSidebarVisibility }));
    registerChatDockHandle(null);

    expect(() => openChatDockPanel(DIFF_PANEL_ID)).not.toThrow();
    expect(() => toggleChatDockPanel(DIFF_PANEL_ID)).not.toThrow();
    expect(() => toggleChatDockSidebarVisibility()).not.toThrow();
    expect(openPanel).not.toHaveBeenCalled();
    expect(togglePanel).not.toHaveBeenCalled();
    expect(toggleSidebarVisibility).not.toHaveBeenCalled();
  });
});

// dock-chrome-strip.md, Section C: the mirrored sidebar-visibility store —
// independent of the handle's own lifecycle (see the store's own doc
// comment in chatDockHandle.ts for why), so these tests exercise it without
// ever calling registerChatDockHandle at all.
describe("chatDockHandle — sidebar visibility mirror", () => {
  it("defaults to true (visible) before anything reports a change", () => {
    expect(getChatDockSidebarVisible()).toBe(true);
  });

  it("reportChatDockSidebarVisibleChange updates the snapshot read by getChatDockSidebarVisible", () => {
    reportChatDockSidebarVisibleChange(false);
    expect(getChatDockSidebarVisible()).toBe(false);

    reportChatDockSidebarVisibleChange(true);
    expect(getChatDockSidebarVisible()).toBe(true);
  });

  it("subscribeChatDockSidebarVisible notifies listeners on every change", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeChatDockSidebarVisible(listener);

    reportChatDockSidebarVisibleChange(false);
    reportChatDockSidebarVisibleChange(true);

    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("does not notify a listener that already unsubscribed", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeChatDockSidebarVisible(listener);
    unsubscribe();

    reportChatDockSidebarVisibleChange(false);

    expect(listener).not.toHaveBeenCalled();
  });

  it("does not notify when the reported value is unchanged (no-op write)", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeChatDockSidebarVisible(listener);

    reportChatDockSidebarVisibleChange(true); // already true — no change

    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("subscribing before the dock ever registers still receives the FIRST real report — mount-order independence", () => {
    // This is the scenario the store's own doc comment names: the strip
    // (subscriber) renders above <Outlet/>, the dock (reporter) mounts as
    // part of the route content under it — subscription necessarily
    // precedes the dock's first report in real usage.
    const listener = vi.fn();
    const unsubscribe = subscribeChatDockSidebarVisible(listener);
    expect(getChatDockSidebarVisible()).toBe(true); // pre-dock default

    reportChatDockSidebarVisibleChange(false); // the dock's first real report

    expect(getChatDockSidebarVisible()).toBe(false);
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
  });
});
