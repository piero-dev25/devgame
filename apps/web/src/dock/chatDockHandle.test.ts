import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  DIFF_PANEL_ID,
  openChatDockPanel,
  registerChatDockHandle,
  toggleChatDockPanel,
} from "./chatDockHandle";

// The module-scope slot this file exercises is a SINGLETON — every test must
// leave it null when it's done, or a later test (in this file or another
// that happens to import the same module instance) would silently observe a
// stale handle from a previous test.
afterEach(() => {
  registerChatDockHandle(null);
});

describe("chatDockHandle — before the dock has registered", () => {
  it("openChatDockPanel no-ops without throwing", () => {
    expect(() => openChatDockPanel(DIFF_PANEL_ID)).not.toThrow();
  });

  it("toggleChatDockPanel no-ops without throwing", () => {
    expect(() => toggleChatDockPanel(DIFF_PANEL_ID)).not.toThrow();
  });
});

describe("chatDockHandle — after the dock registers its handle", () => {
  it("routes openChatDockPanel(id) to the registered handle's openPanel", () => {
    const openPanel = vi.fn();
    const togglePanel = vi.fn();
    registerChatDockHandle({ openPanel, togglePanel });

    openChatDockPanel(DIFF_PANEL_ID);

    expect(openPanel).toHaveBeenCalledExactlyOnceWith(DIFF_PANEL_ID);
    expect(togglePanel).not.toHaveBeenCalled();
  });

  it("routes toggleChatDockPanel(id) to the registered handle's togglePanel", () => {
    const openPanel = vi.fn();
    const togglePanel = vi.fn();
    registerChatDockHandle({ openPanel, togglePanel });

    toggleChatDockPanel(DIFF_PANEL_ID);

    expect(togglePanel).toHaveBeenCalledExactlyOnceWith(DIFF_PANEL_ID);
    expect(openPanel).not.toHaveBeenCalled();
  });
});

describe("chatDockHandle — after the dock unmounts (cleared back to null)", () => {
  it("stops routing to the torn-down handle and no-ops instead", () => {
    const openPanel = vi.fn();
    const togglePanel = vi.fn();
    registerChatDockHandle({ openPanel, togglePanel });
    registerChatDockHandle(null);

    expect(() => openChatDockPanel(DIFF_PANEL_ID)).not.toThrow();
    expect(() => toggleChatDockPanel(DIFF_PANEL_ID)).not.toThrow();
    expect(openPanel).not.toHaveBeenCalled();
    expect(togglePanel).not.toHaveBeenCalled();
  });
});
