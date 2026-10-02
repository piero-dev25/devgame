import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, type PreviewSessionSnapshot, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { applyPreviewServerSnapshot, resetPreviewStateForTests } from "~/previewStateStore";
import { useTerminalDockStore } from "~/terminalDockStore";

import { readDockShortcutPanelContext } from "./dockShortcutContext";

const threadA = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));
const threadB = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-B"));

const snapshot: PreviewSessionSnapshot = {
  threadId: threadA.threadId,
  tabId: "tab-1",
  navStatus: { _tag: "Idle" },
  canGoBack: false,
  canGoForward: false,
  updatedAt: "2026-06-18T19:00:01.000Z",
};

beforeEach(() => {
  resetPreviewStateForTests();
  useTerminalDockStore.setState({ byThreadKey: {} });
});

describe("readDockShortcutPanelContext", () => {
  it("reports nothing open without a thread or before the dock opens anything", () => {
    expect(readDockShortcutPanelContext(null)).toEqual({
      terminalOpen: false,
      previewOpen: false,
    });
    expect(readDockShortcutPanelContext(threadA)).toEqual({
      terminalOpen: false,
      previewOpen: false,
    });
  });

  it("reads terminalOpen from the Terminal dock panel's groups, scoped to the thread", () => {
    useTerminalDockStore.getState().openTerminal(threadA, "term-1");

    expect(readDockShortcutPanelContext(threadA).terminalOpen).toBe(true);
    expect(readDockShortcutPanelContext(threadB).terminalOpen).toBe(false);
  });

  it("reads previewOpen from the Browser dock panel's tabs, scoped to the thread", () => {
    applyPreviewServerSnapshot(threadA, snapshot);

    expect(readDockShortcutPanelContext(threadA).previewOpen).toBe(true);
    expect(readDockShortcutPanelContext(threadB).previewOpen).toBe(false);
  });
});
