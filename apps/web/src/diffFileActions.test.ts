import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { FILES_PANEL_ID, registerChatDockHandle } from "./dock/chatDockHandle";
import { openDiffFilePrimaryAction } from "./diffFileActions";
import { selectThreadFileExplorerState, useFileExplorerStore } from "./fileExplorerStore";

const THREAD_REF = scopeThreadRef(
  EnvironmentId.make("environment-local"),
  ThreadId.make("thread-1"),
);

describe("openDiffFilePrimaryAction", () => {
  beforeEach(() => {
    useFileExplorerStore.setState({ byThreadKey: {} });
  });
  afterEach(() => {
    registerChatDockHandle(null);
  });

  it("opens diff files in the thread file viewer AND makes the Files dock panel visible", () => {
    const openInEditor = vi.fn();
    const openPanel = vi.fn();
    const togglePanel = vi.fn();
    registerChatDockHandle({ openPanel, togglePanel });

    openDiffFilePrimaryAction({
      threadRef: THREAD_REF,
      filePath: "apps/web/src/components/DiffPanel.tsx",
      activeCwd: "/repo/project",
      openInEditor,
    });

    expect(
      selectThreadFileExplorerState(useFileExplorerStore.getState().byThreadKey, THREAD_REF),
    ).toMatchObject({
      activePath: "apps/web/src/components/DiffPanel.tsx",
      openPaths: ["apps/web/src/components/DiffPanel.tsx"],
    });
    expect(openPanel).toHaveBeenCalledExactlyOnceWith(FILES_PANEL_ID);
    expect(openInEditor).not.toHaveBeenCalled();
  });

  it("falls back to the editor without thread context", () => {
    const openInEditor = vi.fn();

    openDiffFilePrimaryAction({
      threadRef: null,
      filePath: "apps/web/src/components/DiffPanel.tsx",
      activeCwd: "/repo/project",
      openInEditor,
    });

    expect(openInEditor).toHaveBeenCalledWith(
      "/repo/project/apps/web/src/components/DiffPanel.tsx",
    );
  });
});
