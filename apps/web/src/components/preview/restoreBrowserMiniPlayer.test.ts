import type { PreviewSessionSnapshot, ScopedThreadRef } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { BROWSER_PANEL_ID, registerChatDockHandle } from "~/dock/chatDockHandle";
import {
  browserMiniPlayerSource,
  selectThreadPreviewMiniPlayerTabId,
  usePreviewMiniPlayerStore,
} from "~/previewMiniPlayerStore";
import {
  applyPreviewServerSnapshot,
  readThreadPreviewState,
  resetPreviewStateForTests,
} from "~/previewStateStore";

import { restoreBrowserMiniPlayerToDock } from "./restoreBrowserMiniPlayer";

const threadRef = {
  environmentId: "local" as ScopedThreadRef["environmentId"],
  threadId: "thread-1" as ScopedThreadRef["threadId"],
};

const snapshot = (tabId: string): PreviewSessionSnapshot => ({
  threadId: threadRef.threadId,
  tabId,
  navStatus: { _tag: "Idle" },
  canGoBack: false,
  canGoForward: false,
  updatedAt: `2026-06-18T19:00:0${tabId.at(-1) ?? "0"}.000Z`,
});

beforeEach(() => {
  resetPreviewStateForTests();
  usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
});
afterEach(() => {
  registerChatDockHandle(null);
});

describe("restoreBrowserMiniPlayerToDock", () => {
  it("selects the floating tab, closes the mini-player, and shows the Browser dock panel", () => {
    applyPreviewServerSnapshot(threadRef, snapshot("tab-1"));
    applyPreviewServerSnapshot(threadRef, snapshot("tab-2"));
    usePreviewMiniPlayerStore.getState().open(threadRef, browserMiniPlayerSource("tab-1"));
    const openPanel = vi.fn();
    registerChatDockHandle({ openPanel, togglePanel: vi.fn(), toggleSidebarVisibility: vi.fn() });
    expect(readThreadPreviewState(threadRef).activeTabId).toBe("tab-2");

    restoreBrowserMiniPlayerToDock(threadRef, "tab-1");

    // The tab that was floating, not whichever tab the thread had selected.
    expect(readThreadPreviewState(threadRef).activeTabId).toBe("tab-1");
    expect(
      selectThreadPreviewMiniPlayerTabId(
        usePreviewMiniPlayerStore.getState().byThreadKey,
        threadRef,
      ),
    ).toBeNull();
    expect(openPanel).toHaveBeenCalledExactlyOnceWith(BROWSER_PANEL_ID);
  });
});
