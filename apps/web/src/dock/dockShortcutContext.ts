import type { ScopedThreadRef } from "@t3tools/contracts";

import { readThreadPreviewState } from "~/previewStateStore";
import { selectThreadTerminalDockState, useTerminalDockStore } from "~/terminalDockStore";

export interface DockShortcutPanelContext {
  readonly terminalOpen: boolean;
  readonly previewOpen: boolean;
}

/**
 * The `terminalOpen` / `previewOpen` keybinding `when` context for a thread.
 *
 * Upstream reads `terminalOpen` from `terminalUiStateStore` and `previewOpen`
 * from the right panel's active surface. In DevGame both are dock panels
 * (spec-surfaces-as-dock-panels.md, Part B): nothing writes those upstream
 * stores for them, so a custom binding conditioned on either would never
 * fire. The dock's own stores answer instead: a terminal group open in
 * `terminalDockStore`, or a browser tab open in `previewStateStore`.
 *
 * Read at keydown time, not subscribed: shortcut handlers only need the value
 * when a key is pressed.
 */
export function readDockShortcutPanelContext(
  threadRef: ScopedThreadRef | null | undefined,
): DockShortcutPanelContext {
  if (!threadRef) return { terminalOpen: false, previewOpen: false };
  return {
    terminalOpen:
      selectThreadTerminalDockState(useTerminalDockStore.getState().byThreadKey, threadRef).groups
        .length > 0,
    previewOpen: Object.keys(readThreadPreviewState(threadRef).sessions).length > 0,
  };
}
