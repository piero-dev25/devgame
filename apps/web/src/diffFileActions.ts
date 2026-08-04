import type { ScopedThreadRef } from "@t3tools/contracts";

import { FILES_PANEL_ID, openChatDockPanel } from "./dock/chatDockHandle";
import { useFileExplorerStore } from "./fileExplorerStore";
import { resolvePathLinkTarget } from "./terminal-links";

interface OpenDiffFilePrimaryActionInput {
  readonly threadRef: ScopedThreadRef | null;
  readonly filePath: string;
  readonly activeCwd: string | undefined;
  readonly openInEditor: (targetPath: string) => void;
}

export function openDiffFilePrimaryAction({
  threadRef,
  filePath,
  activeCwd,
  openInEditor,
}: OpenDiffFilePrimaryActionInput): void {
  if (threadRef) {
    // Task #61: "which file is open" moved to fileExplorerStore.ts; making
    // the Files panel itself visible is now the dock's job.
    useFileExplorerStore.getState().openFile(threadRef, filePath);
    openChatDockPanel(FILES_PANEL_ID);
    return;
  }

  openInEditor(activeCwd ? resolvePathLinkTarget(filePath, activeCwd) : filePath);
}
