import {
  EnvironmentId,
  ThreadId,
  type ProjectWorkspaceReadSuccess,
  type ResolvedWorkspaceEntity,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveWorkspacePanelView } from "./resolveWorkspacePanelView";

const threadRef: ScopedThreadRef = {
  environmentId: EnvironmentId.make("env-1"),
  threadId: ThreadId.make("thread-1"),
};
const server = {
  kind: "server" as const,
  threadRef,
  worktreePath: null,
  projectRoot: "/repo/game",
};
const draft = { kind: "draft" as const };

const entity = (
  overrides: Partial<ResolvedWorkspaceEntity> & Pick<ResolvedWorkspaceEntity, "id">,
): ResolvedWorkspaceEntity => ({
  title: overrides.id,
  folder: overrides.id,
  steps: [],
  ...overrides,
});

const registry: ProjectWorkspaceReadSuccess = {
  manifest: {
    entities: [
      entity({
        id: "pitch",
        title: "Pitch",
        defaultStep: 1,
        steps: [
          {
            name: "Report",
            path: "report.md",
            relativePath: "workspace/pitch/report.md",
            exists: true,
          },
          {
            name: "Deck",
            path: "deck.html",
            relativePath: "workspace/pitch/deck.html",
            exists: false,
            issue: "missing",
          },
          { name: "Escape", path: "../../etc", relativePath: null, exists: false, issue: "escape" },
        ],
      }),
      entity({ id: "gdd", title: "Game design", pinned: true }),
      entity({ id: "pitch", title: "Pitch copy" }),
    ],
    issues: [
      {
        kind: "step-missing",
        entityId: "pitch",
        stepIndex: 1,
        message: 'Step "deck.html" does not exist.',
      },
      { kind: "duplicate-id", entityId: "pitch", message: 'Entity id "pitch" is used twice.' },
    ],
  },
};

describe("resolveWorkspacePanelView", () => {
  it("asks for a thread when there is no project to read", () => {
    expect(
      resolveWorkspacePanelView({ target: null, query: { data: null, error: null } }).kind,
    ).toBe("no-project");
  });

  it("is loading, not asking for a thread, while a selected thread's project is unresolved", () => {
    expect(
      resolveWorkspacePanelView({ target: { kind: "pending" }, query: { data: null, error: null } })
        .kind,
    ).toBe("loading");
  });

  it("is loading until the first read lands", () => {
    expect(
      resolveWorkspacePanelView({ target: server, query: { data: null, error: null } }).kind,
    ).toBe("loading");
  });

  it("shows the missing-registry state when the project has no workspace.json", () => {
    expect(
      resolveWorkspacePanelView({
        target: server,
        query: { data: { manifest: null }, error: null },
      }).kind,
    ).toBe("missing");
  });

  it("shows the server's refusal of a malformed registry as an error, not an empty workspace", () => {
    const view = resolveWorkspacePanelView({
      target: server,
      query: { data: null, error: "workspace/workspace.json is not valid JSON." },
    });
    expect(view).toEqual({
      kind: "error",
      message: "workspace/workspace.json is not valid JSON.",
      staleCards: null,
    });
  });

  it("never presents stale cards as live after a failed refresh", () => {
    const view = resolveWorkspacePanelView({
      target: server,
      query: { data: registry, error: "Connection lost." },
    });
    if (view.kind !== "error") throw new Error(`expected error, got ${view.kind}`);
    expect(view.message).toBe("Connection lost.");
    expect(view.staleCards?.map((card) => card.title)).toEqual([
      "Game design",
      "Pitch",
      "Pitch copy",
    ]);
    expect(view.staleCards?.flatMap((card) => card.steps).some((step) => step.openable)).toBe(
      false,
    );
  });

  it("orders pinned cards first and keeps duplicate ids as distinct cards", () => {
    const view = resolveWorkspacePanelView({
      target: server,
      query: { data: registry, error: null },
    });
    if (view.kind !== "ready") throw new Error(`expected ready, got ${view.kind}`);
    expect(view.cards.map((card) => card.title)).toEqual(["Game design", "Pitch", "Pitch copy"]);
    expect(new Set(view.cards.map((card) => card.key)).size).toBe(3);
    expect(view.threadRef).toEqual(threadRef);
    expect(view.openBlockedReason).toBeNull();
    expect(view.openNotice).toBeNull();
  });

  it("warns that steps open from the thread's worktree when it is not the project root", () => {
    const view = resolveWorkspacePanelView({
      target: { ...server, worktreePath: "/repo/.worktrees/feature" },
      query: { data: registry, error: null },
    });
    if (view.kind !== "ready") throw new Error(`expected ready, got ${view.kind}`);
    expect(view.openNotice).toMatch(/worktree/);
    expect(view.threadInWorktree).toBe(true);
    expect(view.threadRef).toEqual(threadRef);
  });

  it("adds no worktree notice when the worktree is the project root itself", () => {
    const view = resolveWorkspacePanelView({
      target: { ...server, worktreePath: "/repo/game" },
      query: { data: registry, error: null },
    });
    if (view.kind !== "ready") throw new Error(`expected ready, got ${view.kind}`);
    expect(view.openNotice).toBeNull();
    expect(view.threadInWorktree).toBe(false);
  });

  it("lists registry problems above the cards and keeps step problems on their step", () => {
    const view = resolveWorkspacePanelView({
      target: server,
      query: { data: registry, error: null },
    });
    if (view.kind !== "ready") throw new Error(`expected ready, got ${view.kind}`);
    expect(view.issues).toEqual(['Entity id "pitch" is used twice.']);
  });

  it("maps an existing step to its project-relative path and refuses missing or escaping steps", () => {
    const view = resolveWorkspacePanelView({
      target: server,
      query: { data: registry, error: null },
    });
    if (view.kind !== "ready") throw new Error(`expected ready, got ${view.kind}`);
    const pitch = view.cards.find((card) => card.title === "Pitch");
    expect(pitch?.steps).toEqual([
      expect.objectContaining({
        name: "Report",
        relativePath: "workspace/pitch/report.md",
        openable: true,
        problem: null,
        isDefault: false,
      }),
      expect.objectContaining({
        name: "Deck",
        openable: false,
        problem: "File not found",
        isDefault: true,
      }),
      expect.objectContaining({
        name: "Escape",
        relativePath: null,
        openable: false,
        problem: "Outside the workspace folder",
      }),
    ]);
  });

  it("shows a draft's cards but disables opening with a reason", () => {
    const view = resolveWorkspacePanelView({
      target: draft,
      query: { data: registry, error: null },
    });
    if (view.kind !== "ready") throw new Error(`expected ready, got ${view.kind}`);
    expect(view.cards).toHaveLength(3);
    expect(view.openBlockedReason).toMatch(/first message/);
    expect(view.threadRef).toBeNull();
    expect(view.cards.flatMap((card) => card.steps).some((step) => step.openable)).toBe(false);
  });

  it("falls back to the id, then a placeholder, for a blank title", () => {
    const view = resolveWorkspacePanelView({
      target: server,
      query: {
        data: {
          manifest: {
            entities: [entity({ id: "art", title: "  " }), entity({ id: " ", title: "" })],
            issues: [],
          },
        },
        error: null,
      },
    });
    if (view.kind !== "ready") throw new Error(`expected ready, got ${view.kind}`);
    expect(view.cards.map((card) => card.title)).toEqual(["art", "Untitled"]);
  });
});
