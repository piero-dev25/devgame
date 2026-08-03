import type { VcsStatusResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { decideFilesPanelView } from "./FilesPanel.logic";

// Same fixture-builder convention as GitActionsControl.logic.test.ts —
// override only what a given test cares about.
function status(overrides: Partial<VcsStatusResult> = {}): VcsStatusResult {
  return {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "main",
    hasWorkingTreeChanges: false,
    workingTree: {
      files: [],
      insertions: 0,
      deletions: 0,
    },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    ...overrides,
  };
}

describe("decideFilesPanelView", () => {
  it("shows waiting-for-project when there is no cwd yet, before anything else is checked", () => {
    // Even with an error AND data both present, no cwd means no query was
    // ever issued for either to have come FROM — this must win.
    const view = decideFilesPanelView({
      gitCwd: null,
      error: "should be ignored",
      data: status(),
    });
    expect(view).toEqual({ kind: "waiting-for-project" });
  });

  it("surfaces the query error verbatim — acceptance check 4's error-state case", () => {
    const view = decideFilesPanelView({
      gitCwd: "/repo",
      error: "ECONNREFUSED talking to the environment",
      data: null,
    });
    expect(view).toEqual({ kind: "error", message: "ECONNREFUSED talking to the environment" });
  });

  it("prefers a live error over stale data — an error must never be swallowed by leftover data", () => {
    const view = decideFilesPanelView({
      gitCwd: "/repo",
      error: "boom",
      data: status({ workingTree: { files: [], insertions: 0, deletions: 0 } }),
    });
    expect(view).toEqual({ kind: "error", message: "boom" });
  });

  it("shows loading while the query is in flight (cwd known, no error yet, no data yet)", () => {
    const view = decideFilesPanelView({ gitCwd: "/repo", error: null, data: null });
    expect(view).toEqual({ kind: "loading" });
  });

  it("shows not-a-repo for a successful RPC response that says isRepo: false — this is NOT an error and NOT clean", () => {
    // Acceptance check 4's exact case: a real, successful response that
    // reports "not a repository" must not collapse into the clean-tree
    // reading just because workingTree.files also happens to be empty.
    const view = decideFilesPanelView({
      gitCwd: "/not-a-repo",
      error: null,
      data: status({ isRepo: false, workingTree: { files: [], insertions: 0, deletions: 0 } }),
    });
    expect(view).toEqual({ kind: "not-a-repo", cwd: "/not-a-repo" });
  });

  it("shows clean, distinct from not-a-repo, for a real repo with an empty file list", () => {
    const view = decideFilesPanelView({
      gitCwd: "/repo",
      error: null,
      data: status({
        isRepo: true,
        refName: "main",
        workingTree: { files: [], insertions: 0, deletions: 0 },
      }),
    });
    expect(view).toEqual({ kind: "clean", refName: "main" });
    // The two failure-shaped/empty-shaped kinds must never be the same value
    // — this is acceptance check 4's "distinguishable" requirement pinned as
    // a plain inequality, not just two separate toEqual assertions that could
    // each pass while secretly sharing a kind.
    const notRepo = decideFilesPanelView({
      gitCwd: "/repo",
      error: null,
      data: status({ isRepo: false, workingTree: { files: [], insertions: 0, deletions: 0 } }),
    });
    expect(view.kind).not.toBe(notRepo.kind);
  });

  it("passes a detached HEAD (refName: null) through to the clean view untouched", () => {
    const view = decideFilesPanelView({
      gitCwd: "/repo",
      error: null,
      data: status({ refName: null, workingTree: { files: [], insertions: 0, deletions: 0 } }),
    });
    expect(view).toEqual({ kind: "clean", refName: null });
  });

  it("shows files with totals and the file list passed through untouched, including a delete-shaped stat", () => {
    // insertions:0/deletions:3 is exactly the ambiguous shape a deleted file
    // and a delete-only edit both produce — decideFilesPanelView's job is
    // only to pick the "files" kind, not to editorialize about what a stat
    // means. That editorializing (or lack of it) belongs to the renderer,
    // pinned separately in FilesPanel.test.tsx.
    const files = [
      { path: "physics.js", insertions: 1, deletions: 0 },
      { path: "throwaway.txt", insertions: 0, deletions: 3 },
      { path: "scratch-note.txt", insertions: 0, deletions: 0 },
    ];
    const view = decideFilesPanelView({
      gitCwd: "/repo",
      error: null,
      data: status({
        refName: "main",
        workingTree: { files, insertions: 1, deletions: 3 },
      }),
    });
    expect(view).toEqual({
      kind: "files",
      refName: "main",
      files,
      totalInsertions: 1,
      totalDeletions: 3,
    });
  });
});
