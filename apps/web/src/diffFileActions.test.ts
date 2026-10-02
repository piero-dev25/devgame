import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { FILES_PANEL_ID, registerChatDockHandle } from "./dock/chatDockHandle";
import { openDiffFilePrimaryAction, resolveDiffPathForWorkspace } from "./diffFileActions";
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
    registerChatDockHandle({ openPanel, togglePanel, toggleSidebarVisibility: vi.fn() });

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

  it("opens repository-relative diff files from a nested project in the Files dock panel", () => {
    const openInEditor = vi.fn();
    const openPanel = vi.fn();
    registerChatDockHandle({
      openPanel,
      togglePanel: vi.fn(),
      toggleSidebarVisibility: vi.fn(),
    });

    openDiffFilePrimaryAction({
      threadRef: THREAD_REF,
      filePath: "frontend/Dockerfile",
      activeCwd: "/repo/frontend",
      repositoryRoot: "/repo",
      openInEditor,
    });

    expect(
      selectThreadFileExplorerState(useFileExplorerStore.getState().byThreadKey, THREAD_REF),
    ).toMatchObject({ activePath: "Dockerfile" });
    expect(openPanel).toHaveBeenCalledExactlyOnceWith(FILES_PANEL_ID);
    expect(openInEditor).not.toHaveBeenCalled();
  });

  it("preserves repository-relative paths in a separate worktree", () => {
    expect(
      resolveDiffPathForWorkspace({
        filePath: "frontend/Dockerfile",
        workspaceRoot: "/worktrees/feature",
        repositoryRoot: "/repo",
      }),
    ).toBe("frontend/Dockerfile");
  });

  it("handles Windows roots and mixed diff separators", () => {
    expect(
      resolveDiffPathForWorkspace({
        filePath: "Frontend/src\\index.ts",
        workspaceRoot: "C:\\repo\\frontend",
        repositoryRoot: "C:\\repo",
      }),
    ).toBe("src/index.ts");
  });

  it.each([
    { workspaceRoot: "/frontend", repositoryRoot: "/" },
    { workspaceRoot: "C:\\frontend", repositoryRoot: "C:\\" },
  ])("handles filesystem roots: $repositoryRoot", ({ workspaceRoot, repositoryRoot }) => {
    expect(
      resolveDiffPathForWorkspace({
        filePath: "frontend/index.ts",
        workspaceRoot,
        repositoryRoot,
      }),
    ).toBe("index.ts");
  });

  it.each(["backend/server.ts", "frontend2/app.ts", "frontend/../secret.ts", "C:secret.ts"])(
    "does not open an out-of-project diff path: %s",
    (filePath) => {
      const openInEditor = vi.fn();
      const openPanel = vi.fn();
      registerChatDockHandle({
        openPanel,
        togglePanel: vi.fn(),
        toggleSidebarVisibility: vi.fn(),
      });

      openDiffFilePrimaryAction({
        threadRef: THREAD_REF,
        filePath,
        activeCwd: "/repo/frontend",
        repositoryRoot: "/repo",
        openInEditor,
      });

      expect(useFileExplorerStore.getState().byThreadKey).toEqual({});
      expect(openPanel).not.toHaveBeenCalled();
      expect(openInEditor).not.toHaveBeenCalled();
    },
  );
});
