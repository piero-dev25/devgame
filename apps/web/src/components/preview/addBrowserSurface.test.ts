import type { PreviewOpenInput, PreviewSessionSnapshot, ScopedThreadRef } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { BROWSER_PANEL_ID, registerChatDockHandle } from "~/dock/chatDockHandle";
import {
  applyPreviewServerSnapshot,
  readThreadPreviewState,
  resetPreviewStateForTests,
} from "~/previewStateStore";

import { addBrowserSurface } from "./addBrowserSurface";

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
});
afterEach(() => {
  registerChatDockHandle(null);
});

describe("addBrowserSurface", () => {
  it("creates another preview session when a browser tab is already active, and opens the Browser dock panel", async () => {
    const first = snapshot("tab-1");
    const second = snapshot("tab-2");
    applyPreviewServerSnapshot(threadRef, first);
    const openPanel = vi.fn();
    registerChatDockHandle({ openPanel, togglePanel: vi.fn() });
    const openPreview = vi.fn(async (_input: PreviewOpenInput) => AsyncResult.success(second));

    await addBrowserSurface({ threadRef, openPreview: ({ input }) => openPreview(input) });

    expect(openPreview).toHaveBeenCalledWith({ threadId: "thread-1" });
    expect(Object.keys(readThreadPreviewState(threadRef).sessions)).toEqual(["tab-1", "tab-2"]);
    // Task #53: previewStateStore's own `applyPreviewServerSnapshot` already
    // activates the new tab (see addBrowserSurface.ts's own doc comment) —
    // the only remaining job for this function is making the dock panel
    // visible, which this asserts directly rather than through
    // rightPanelStore's now-deleted "preview" surfaces.
    expect(readThreadPreviewState(threadRef).activeTabId).toBe("tab-2");
    expect(openPanel).toHaveBeenCalledExactlyOnceWith(BROWSER_PANEL_ID);
  });
});
