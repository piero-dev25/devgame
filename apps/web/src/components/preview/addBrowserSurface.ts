import {
  mapAtomCommandResult,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";

import type { BrowserSettingsReadError, OpenPreviewMutation } from "~/browser/openFileInPreview";
import { BROWSER_PANEL_ID, openChatDockPanel } from "~/dock/chatDockHandle";

import { openPreviewSession } from "./openPreviewSession";

/**
 * Creates a new browser tab. Reopening an existing tab is a separate UI
 * action.
 *
 * Task #53: used to also call `rightPanelStore.openBrowser(threadRef,
 * tabId)` — now unnecessary on BOTH halves. `openPreviewSession` already
 * calls `applyPreviewServerSnapshot`, which sets `previewStateStore`'s own
 * `activeTabId` to the new tab unconditionally; the only remaining job is
 * making the (now separate) Browser dock panel visible.
 */
export async function addBrowserSurface<E>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly openPreview: OpenPreviewMutation<E>;
  /** Omit to use the configured default profile. */
  readonly profileId?: string | undefined;
}): Promise<AtomCommandResult<void, E | BrowserSettingsReadError>> {
  const result = await openPreviewSession({
    openPreview: input.openPreview,
    threadRef: input.threadRef,
    ...(input.profileId === undefined ? {} : { profileId: input.profileId }),
  });
  return mapAtomCommandResult(result, () => {
    openChatDockPanel(BROWSER_PANEL_ID);
  });
}
