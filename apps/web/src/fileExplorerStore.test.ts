import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  fileExplorerAttachmentEntry,
  selectFileExplorerAttachment,
  selectThreadFileExplorerState,
  useFileExplorerStore,
} from "./fileExplorerStore";

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

// Ported from upstream rightPanelStore.test.ts: in DevGame, workspace files and
// chat attachments open in the Files dock panel, so the file-surface cases
// live here.
describe("fileExplorerStore — workspace-root and folder links", () => {
  it("opens a workspace-root link as the explorer view without closing open files", () => {
    const store = useFileExplorerStore.getState();
    store.openFile(refA, "README.md");
    store.openFile(refA, ".");
    store.openFile(refA, ".");

    const state = selectThreadFileExplorerState(useFileExplorerStore.getState().byThreadKey, refA);
    expect(state.activePath).toBeNull();
    expect(state.openPaths).toEqual(["README.md"]);
  });

  it.each([
    ["docs/", "docs"],
    ["docs///", "docs"],
    ["/", "/"],
    ["C:/", "C:/"],
  ])("reuses the folder entry for %j and %j", (linkPath, treePath) => {
    useFileExplorerStore.getState().openFile(refA, linkPath);
    useFileExplorerStore.getState().openFile(refA, treePath);

    const state = selectThreadFileExplorerState(useFileExplorerStore.getState().byThreadKey, refA);
    expect(state.openPaths).toEqual([treePath]);
    expect(state.revealRequestId).toBe(2);
  });

  it.each([
    ["generated\\", "generated"],
    ["notes/meeting ", "notes/meeting"],
    [" notes/meeting", "notes/meeting"],
  ])("keeps %j and %j as separate entries", (firstPath, secondPath) => {
    useFileExplorerStore.getState().openFile(refA, firstPath);
    useFileExplorerStore.getState().openFile(refA, secondPath);

    expect(
      selectThreadFileExplorerState(useFileExplorerStore.getState().byThreadKey, refA).openPaths,
    ).toEqual([firstPath, secondPath]);
  });
});

describe("fileExplorerStore — openAttachment", () => {
  const attachment = {
    type: "file" as const,
    id: "thread-A-attachment-pdf",
    name: "report.pdf",
    mimeType: "application/pdf",
    sizeBytes: 42,
  };

  it("opens an attachment as an active entry that resolves back to the attachment", () => {
    useFileExplorerStore.getState().openFile(refA, "src/app.ts");
    useFileExplorerStore.getState().openAttachment(refA, attachment);
    useFileExplorerStore.getState().openAttachment(refA, attachment);

    const state = selectThreadFileExplorerState(useFileExplorerStore.getState().byThreadKey, refA);
    const entry = fileExplorerAttachmentEntry(attachment.id);
    expect(state.openPaths).toEqual(["src/app.ts", entry]);
    expect(state.activePath).toBe(entry);
    expect(selectFileExplorerAttachment(state, state.activePath)).toEqual(attachment);
    expect(selectFileExplorerAttachment(state, "src/app.ts")).toBeNull();
  });

  it("keeps attachment and workspace file entries disjoint", () => {
    useFileExplorerStore.getState().openFile(refA, "attachment:shared-id");
    useFileExplorerStore.getState().openAttachment(refA, { ...attachment, id: "shared-id" });

    const state = selectThreadFileExplorerState(useFileExplorerStore.getState().byThreadKey, refA);
    expect(state.openPaths).toEqual([
      "attachment:shared-id",
      fileExplorerAttachmentEntry("shared-id"),
    ]);
    expect(selectFileExplorerAttachment(state, "attachment:shared-id")).toBeNull();
  });

  it("keeps attachment previews when the workspace becomes unavailable", () => {
    useFileExplorerStore.getState().openAttachment(refA, attachment);
    useFileExplorerStore.getState().openFile(refA, "README.md");
    useFileExplorerStore.getState().reconcileFiles(refA, false);

    const state = selectThreadFileExplorerState(useFileExplorerStore.getState().byThreadKey, refA);
    const entry = fileExplorerAttachmentEntry(attachment.id);
    expect(state.openPaths).toEqual([entry]);
    expect(state.activePath).toBe(entry);
    expect(selectFileExplorerAttachment(state, entry)).toEqual(attachment);
  });

  it("forgets a closed attachment and prunes the thread once nothing is open", () => {
    useFileExplorerStore.getState().openAttachment(refA, attachment);
    useFileExplorerStore.getState().closeFile(refA, fileExplorerAttachmentEntry(attachment.id));

    expect(useFileExplorerStore.getState().byThreadKey).toEqual({});
  });
});
