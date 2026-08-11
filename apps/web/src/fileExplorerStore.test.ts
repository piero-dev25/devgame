import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { selectThreadFileExplorerState, useFileExplorerStore } from "./fileExplorerStore";

const refA = scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("thread-A"));
const refB = scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("thread-B"));

beforeEach(() => {
  useFileExplorerStore.setState({ byThreadKey: {} });
});

describe("fileExplorerStore — defaults", () => {
  it("defaults an unopened thread to the explorer, nothing open", () => {
    expect(
      selectThreadFileExplorerState(useFileExplorerStore.getState().byThreadKey, refA),
    ).toEqual({
      openPaths: [],
      activePath: null,
      revealLine: null,
      revealRequestId: 0,
      pendingPaths: [],
    });
  });

  it("is isolated per thread", () => {
    useFileExplorerStore.getState().openFile(refA, "src/app.ts");
    expect(
      selectThreadFileExplorerState(useFileExplorerStore.getState().byThreadKey, refB),
    ).toEqual({
      openPaths: [],
      activePath: null,
      revealLine: null,
      revealRequestId: 0,
      pendingPaths: [],
    });
  });
});

describe("fileExplorerStore — openFile", () => {
  it("appends a new path, makes it active, and bumps revealRequestId", () => {
    useFileExplorerStore.getState().openFile(refA, "src/app.ts", 42);
    const state = selectThreadFileExplorerState(useFileExplorerStore.getState().byThreadKey, refA);
    expect(state.openPaths).toEqual(["src/app.ts"]);
    expect(state.activePath).toBe("src/app.ts");
    expect(state.revealLine).toBe(42);
    expect(state.revealRequestId).toBe(1);
  });

  it("keeps an already-open path's position but still bumps revealRequestId, for a re-reveal", () => {
    useFileExplorerStore.getState().openFile(refA, "src/app.ts");
    useFileExplorerStore.getState().openFile(refA, "src/other.ts");
    useFileExplorerStore.getState().openFile(refA, "src/app.ts", 7);

    const state = selectThreadFileExplorerState(useFileExplorerStore.getState().byThreadKey, refA);
    expect(state.openPaths).toEqual(["src/app.ts", "src/other.ts"]);
    expect(state.activePath).toBe("src/app.ts");
    expect(state.revealLine).toBe(7);
    expect(state.revealRequestId).toBe(3);
  });

  it("normalizes a non-finite or sub-1 line to null/1, same as rightPanelStore's old behaviour", () => {
    useFileExplorerStore.getState().openFile(refA, "src/app.ts", -5);
    expect(
      selectThreadFileExplorerState(useFileExplorerStore.getState().byThreadKey, refA).revealLine,
    ).toBe(1);

    useFileExplorerStore.getState().openFile(refA, "src/app.ts", Number.NaN);
    expect(
      selectThreadFileExplorerState(useFileExplorerStore.getState().byThreadKey, refA).revealLine,
    ).toBeNull();
  });
});

describe("fileExplorerStore — showExplorer", () => {
  it("clears activePath without closing any open file", () => {
    useFileExplorerStore.getState().openFile(refA, "src/app.ts");
    useFileExplorerStore.getState().showExplorer(refA);

    const state = selectThreadFileExplorerState(useFileExplorerStore.getState().byThreadKey, refA);
    expect(state.activePath).toBeNull();
    expect(state.openPaths).toEqual(["src/app.ts"]);
  });
});

describe("fileExplorerStore — closeFile", () => {
  it("removes a non-active path, leaving the active one untouched", () => {
    useFileExplorerStore.getState().openFile(refA, "a.ts");
    useFileExplorerStore.getState().openFile(refA, "b.ts");
    useFileExplorerStore.getState().closeFile(refA, "a.ts");

    const state = selectThreadFileExplorerState(useFileExplorerStore.getState().byThreadKey, refA);
    expect(state.openPaths).toEqual(["b.ts"]);
    expect(state.activePath).toBe("b.ts");
  });

  it("activates a neighboring open file when the active one closes", () => {
    useFileExplorerStore.getState().openFile(refA, "a.ts");
    useFileExplorerStore.getState().openFile(refA, "b.ts");
    useFileExplorerStore.getState().openFile(refA, "c.ts");
    // active is c.ts (index 2); closing it should fall back to b.ts, the
    // nearest remaining neighbor at min(2, 1) = index 1 of [a.ts, b.ts].
    useFileExplorerStore.getState().closeFile(refA, "c.ts");

    const state = selectThreadFileExplorerState(useFileExplorerStore.getState().byThreadKey, refA);
    expect(state.openPaths).toEqual(["a.ts", "b.ts"]);
    expect(state.activePath).toBe("b.ts");
  });

  it("prunes the thread's entry from byThreadKey entirely once everything is closed", () => {
    useFileExplorerStore.getState().openFile(refA, "a.ts");
    useFileExplorerStore.getState().closeFile(refA, "a.ts");

    // Direct check on the raw record, not just the selector's fallback
    // shape — a stale-but-empty entry left behind would pass the selector
    // check below just as well as a genuinely pruned one.
    expect(Object.keys(useFileExplorerStore.getState().byThreadKey)).toEqual([]);
  });

  it("falls back to the explorer when the last open file closes", () => {
    useFileExplorerStore.getState().openFile(refA, "a.ts");
    useFileExplorerStore.getState().closeFile(refA, "a.ts");

    expect(
      selectThreadFileExplorerState(useFileExplorerStore.getState().byThreadKey, refA),
    ).toEqual({
      openPaths: [],
      activePath: null,
      revealLine: null,
      revealRequestId: 0,
      pendingPaths: [],
    });
  });

  it("drops the closed path from pendingPaths too", () => {
    useFileExplorerStore.getState().openFile(refA, "a.ts");
    useFileExplorerStore.getState().setPending(refA, "a.ts", true);
    useFileExplorerStore.getState().closeFile(refA, "a.ts");

    expect(
      selectThreadFileExplorerState(useFileExplorerStore.getState().byThreadKey, refA).pendingPaths,
    ).toEqual([]);
  });
});

describe("fileExplorerStore — setPending", () => {
  it("tracks and clears the unsaved-edit indicator per path", () => {
    useFileExplorerStore.getState().openFile(refA, "a.ts");
    useFileExplorerStore.getState().setPending(refA, "a.ts", true);
    expect(
      selectThreadFileExplorerState(useFileExplorerStore.getState().byThreadKey, refA).pendingPaths,
    ).toEqual(["a.ts"]);

    useFileExplorerStore.getState().setPending(refA, "a.ts", false);
    expect(
      selectThreadFileExplorerState(useFileExplorerStore.getState().byThreadKey, refA).pendingPaths,
    ).toEqual([]);
  });
});

describe("fileExplorerStore — reconcileFiles", () => {
  it("drops everything for the thread when its workspace becomes unavailable", () => {
    useFileExplorerStore.getState().openFile(refA, "a.ts");
    useFileExplorerStore.getState().reconcileFiles(refA, false);

    expect(
      selectThreadFileExplorerState(useFileExplorerStore.getState().byThreadKey, refA),
    ).toEqual({
      openPaths: [],
      activePath: null,
      revealLine: null,
      revealRequestId: 0,
      pendingPaths: [],
    });
  });

  it("does nothing when the workspace IS available", () => {
    useFileExplorerStore.getState().openFile(refA, "a.ts");
    useFileExplorerStore.getState().reconcileFiles(refA, true);

    expect(
      selectThreadFileExplorerState(useFileExplorerStore.getState().byThreadKey, refA).openPaths,
    ).toEqual(["a.ts"]);
  });
});

describe("fileExplorerStore — removeThread", () => {
  it("clears a thread's entry entirely", () => {
    useFileExplorerStore.getState().openFile(refA, "a.ts");
    useFileExplorerStore.getState().removeThread(refA);

    expect(useFileExplorerStore.getState().byThreadKey).toEqual({});
  });
});
