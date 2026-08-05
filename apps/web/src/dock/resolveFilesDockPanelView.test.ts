import type { EnvironmentProject, EnvironmentThread } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { DraftId } from "~/composerDraftStore";

import type { ThreadRouteContextValue } from "./ChatPanel";
import { resolveFilesDockPanelView } from "./resolveFilesDockPanelView";

const ENVIRONMENT_ID = EnvironmentId.make("env-1");
const THREAD_ID = ThreadId.make("thread-1");
const PROJECT_ID = ProjectId.make("project-1");

const serverRouteContext: ThreadRouteContextValue = {
  routeKind: "server",
  environmentId: ENVIRONMENT_ID,
  threadId: THREAD_ID,
  threadSyncPhase: null,
};

const draftRouteContext: ThreadRouteContextValue = {
  routeKind: "draft",
  environmentId: ENVIRONMENT_ID,
  threadId: THREAD_ID,
  draftId: DraftId.make("draft-1"),
};

const activeThread = {
  environmentId: ENVIRONMENT_ID,
  projectId: PROJECT_ID,
  worktreePath: "/repo/worktree",
} as EnvironmentThread;

const activeProject: EnvironmentProject = {
  environmentId: ENVIRONMENT_ID,
  id: PROJECT_ID,
  title: "My Project",
  workspaceRoot: "/repo",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("resolveFilesDockPanelView — draft thread", () => {
  it("returns draft-empty regardless of whatever activeThread/activeProject happen to be, and NEVER reaches the ready branch", () => {
    // The exact asymmetry the review flagged: Diff's useParams-based
    // mechanism collapses "draft route" into the same null case as "no
    // route at all," so it never even sees thread/project data for a
    // draft. This wrapper's ThreadRouteContext-based mechanism DOES see
    // separate thread/project data — proving the draft check short-circuits
    // BEFORE that data is used is the actual regression risk here.
    const view = resolveFilesDockPanelView({
      routeContext: draftRouteContext,
      activeThread,
      activeProject,
    });
    expect(view).toEqual({ kind: "draft-empty" });
  });

  it("returns draft-empty even with no thread/project data at all", () => {
    const view = resolveFilesDockPanelView({
      routeContext: draftRouteContext,
      activeThread: null,
      activeProject: null,
    });
    expect(view).toEqual({ kind: "draft-empty" });
  });
});

describe("resolveFilesDockPanelView — server thread, not ready yet", () => {
  it("returns loading when activeProject hasn't resolved", () => {
    const view = resolveFilesDockPanelView({
      routeContext: serverRouteContext,
      activeThread,
      activeProject: null,
    });
    expect(view).toEqual({ kind: "loading" });
  });

  it("returns loading when neither the thread's worktreePath nor the project's workspaceRoot is available", () => {
    const view = resolveFilesDockPanelView({
      routeContext: serverRouteContext,
      activeThread: { ...activeThread, worktreePath: null } as EnvironmentThread,
      activeProject: { ...activeProject, workspaceRoot: "" } as EnvironmentProject,
    });
    expect(view.kind).toBe("loading");
  });
});

describe("resolveFilesDockPanelView — server thread, ready", () => {
  it("prefers the thread's worktreePath as cwd over the project's workspaceRoot", () => {
    const view = resolveFilesDockPanelView({
      routeContext: serverRouteContext,
      activeThread,
      activeProject,
    });
    expect(view).toEqual({
      kind: "ready",
      environmentId: ENVIRONMENT_ID,
      cwd: "/repo/worktree",
      projectName: "My Project",
      threadRef: { environmentId: ENVIRONMENT_ID, threadId: THREAD_ID },
      composerDraftTarget: { environmentId: ENVIRONMENT_ID, threadId: THREAD_ID },
      previewPanelKey: "env-1:thread-1:/repo/worktree",
    });
  });

  it("falls back to the project's workspaceRoot when the thread has no worktreePath", () => {
    const view = resolveFilesDockPanelView({
      routeContext: serverRouteContext,
      activeThread: { ...activeThread, worktreePath: null } as EnvironmentThread,
      activeProject,
    });
    expect(view.kind).toBe("ready");
    if (view.kind === "ready") {
      expect(view.cwd).toBe("/repo");
    }
  });

  it("sets composerDraftTarget equal to threadRef — matching ChatView's own formula for a server thread", () => {
    const view = resolveFilesDockPanelView({
      routeContext: serverRouteContext,
      activeThread,
      activeProject,
    });
    expect(view.kind).toBe("ready");
    if (view.kind === "ready") {
      expect(view.composerDraftTarget).toEqual(view.threadRef);
    }
  });
});

// Task #112: FilesDockPanel.tsx mounts `<FilePreviewPanel key={view.previewPanelKey}>`.
// React only remounts a component (resetting its own internal useState —
// FilePreviewPanel.tsx's explorerOpen/handledReveal/etc.) when its `key`
// CHANGES. What's provable here, without jsdom/mounted-component infra (see
// openPanel.ts's own doc comment for why this repo's dock module extracts
// pure decision logic instead), is that the INPUT to that reconciliation
// differs between two threads — not the DOM-level remount/reset itself.
describe("resolveFilesDockPanelView — previewPanelKey (task #112)", () => {
  const THREAD_B_ID = ThreadId.make("thread-2");

  it("differs for two different threads in the SAME project — the actual repro shape (same cwd, different thread)", () => {
    const viewA = resolveFilesDockPanelView({
      routeContext: serverRouteContext,
      activeThread,
      activeProject,
    });
    const viewB = resolveFilesDockPanelView({
      routeContext: { ...serverRouteContext, threadId: THREAD_B_ID },
      activeThread,
      activeProject,
    });
    expect(viewA.kind).toBe("ready");
    expect(viewB.kind).toBe("ready");
    if (viewA.kind === "ready" && viewB.kind === "ready") {
      // Both threads share the identical cwd — proving THIS is what makes
      // the case meaningful: a key that only varied by cwd (the pre-fix
      // formula) would collide right here.
      expect(viewA.cwd).toBe(viewB.cwd);
      expect(viewA.previewPanelKey).not.toBe(viewB.previewPanelKey);
    }
  });

  it("still differs when the SAME thread's cwd changes — preserves the original remount trigger (e.g. a worktree operation)", () => {
    const viewBefore = resolveFilesDockPanelView({
      routeContext: serverRouteContext,
      activeThread,
      activeProject,
    });
    const viewAfter = resolveFilesDockPanelView({
      routeContext: serverRouteContext,
      activeThread: { ...activeThread, worktreePath: "/repo/worktree-2" } as EnvironmentThread,
      activeProject,
    });
    expect(viewBefore.kind).toBe("ready");
    expect(viewAfter.kind).toBe("ready");
    if (viewBefore.kind === "ready" && viewAfter.kind === "ready") {
      expect(viewBefore.previewPanelKey).not.toBe(viewAfter.previewPanelKey);
    }
  });

  it("is stable across an unrelated re-render of the SAME thread and cwd", () => {
    const first = resolveFilesDockPanelView({
      routeContext: serverRouteContext,
      activeThread,
      activeProject,
    });
    const second = resolveFilesDockPanelView({
      routeContext: serverRouteContext,
      activeThread,
      activeProject,
    });
    expect(first.kind).toBe("ready");
    expect(second.kind).toBe("ready");
    if (first.kind === "ready" && second.kind === "ready") {
      expect(first.previewPanelKey).toBe(second.previewPanelKey);
    }
  });
});
