import type { ScopedThreadRef } from "@t3tools/contracts";

import { BROWSER_PANEL_ID, openChatDockPanel } from "~/dock/chatDockHandle";
import { usePreviewMiniPlayerStore } from "~/previewMiniPlayerStore";
import { setActivePreviewTab } from "~/previewStateStore";

/**
 * Moves a floating browser preview back into the Browser dock panel.
 *
 * Upstream restores into the right panel (`rightPanelStore.openBrowser`);
 * in DevGame Browser is a dock panel, so the restore selects the tab in
 * `previewStateStore` and opens that panel. Unlike the other open-preview
 * call sites, no fresh snapshot is applied here: the mini-player was showing
 * `tabId`, which need not be the thread's current `activeTabId` (the user can
 * switch tabs elsewhere while it floats), so it is selected explicitly.
 *
 * Device sources still restore through `rightPanelStore.openDevice`, since
 * Device remains a right-panel surface.
 */
export function restoreBrowserMiniPlayerToDock(threadRef: ScopedThreadRef, tabId: string): void {
  usePreviewMiniPlayerStore.getState().close(threadRef);
  setActivePreviewTab(threadRef, tabId);
  openChatDockPanel(BROWSER_PANEL_ID);
}
