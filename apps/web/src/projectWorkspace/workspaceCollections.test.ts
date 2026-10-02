import {
  EnvironmentId,
  ThreadId,
  type MrMakImportFileOrigin,
  type MrMakImportStatusSuccess,
  type ResolvedWorkspaceEntity,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveWorkspacePanelView } from "./resolveWorkspacePanelView";
import { resolveWorkspaceCollections } from "./workspaceCollections";

const entity = (id: string, steps: ReadonlyArray<string>): ResolvedWorkspaceEntity => ({
  id,
  title: id,
  folder: id,
  steps: steps.map((path) => ({
    name: path,
    path,
    relativePath: `workspace/${id}/${path}`,
    exists: true,
  })),
});

/** The panel's own card views, for a registry of these entities. */
const cardsOf = (entities: ReadonlyArray<ResolvedWorkspaceEntity>) => {
  const view = resolveWorkspacePanelView({
    target: {
      kind: "server",
      threadRef: { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") },
      worktreePath: null,
      projectRoot: "/projects/comparison",
    },
    query: { data: { manifest: { entities, issues: [] } }, error: null },
  });
  if (view.kind !== "ready") throw new Error(`expected ready, got ${view.kind}`);
  return view.cards;
};

const status = (files: Record<string, MrMakImportFileOrigin>): MrMakImportStatusSuccess => ({
  import: {
    receipt: {
      importId: "import-1",
      previousImportId: null,
      source: {
        repositoryPath: "/projects/mr-mak",
        revision: "6248c9ec0123456789",
        branch: "main",
      },
      completedAt: "2026-10-03T10:00:00.000Z",
      outcomes: { written: 4, identical: 0, updated: 0, replaced: 0, "kept-local": 0, conflict: 0 },
      conflicts: [],
      changes: { added: 0, modified: 0, removed: 0 },
      exclusions: 0,
      transforms: [],
      skills: null,
    },
    files: Object.entries(files).map(([path, origin]) => ({ path, origin })),
  },
});

describe("resolveWorkspaceCollections", () => {
  it("is null for a project no import wrote into", () => {
    expect(
      resolveWorkspaceCollections({ cards: cardsOf([]), status: { import: null } }),
    ).toBeNull();
    expect(resolveWorkspaceCollections({ cards: cardsOf([]), status: null })).toBeNull();
  });

  it("keeps unchanged imported cards in Original and the rest in Adaptation, ids and step order intact", () => {
    const cards = cardsOf([
      entity("intro", ["a.html", "b.md"]),
      entity("lore", ["index.html"]),
      entity("playtest", ["notes.md"]),
      entity("pitch", ["deck.html", "extra.md"]),
    ]);
    const collections = resolveWorkspaceCollections({
      cards,
      status: status({
        "workspace/intro/a.html": "original",
        "workspace/intro/b.md": "original",
        "workspace/lore/index.html": "adapted",
        "workspace/pitch/deck.html": "original",
      }),
    });

    const summary = (list: NonNullable<typeof collections>["original"]["cards"]) =>
      list.map(({ card, origin }) => [card.entity.id, origin, card.steps.map((step) => step.name)]);
    expect(summary(collections?.original.cards ?? [])).toEqual([
      ["intro", "mrmak", ["a.html", "b.md"]],
    ]);
    expect(summary(collections?.adaptation.cards ?? [])).toEqual([
      ["lore", "adapted", ["index.html"]],
      // Not in the receipt at all: made here.
      ["playtest", "devgame", ["notes.md"]],
      // An imported card with a step added here is an adaptation.
      ["pitch", "adapted", ["deck.html", "extra.md"]],
    ]);
    expect(collections?.provenance).toEqual({
      repositoryPath: "/projects/mr-mak",
      revision: "6248c9ec0123456789",
      branch: "main",
      importedAt: "2026-10-03T10:00:00.000Z",
    });
  });

  it("labels workflows, context and skills, and never opens a removed or non-relative path", () => {
    const collections = resolveWorkspaceCollections({
      cards: cardsOf([]),
      status: status({
        "processes/review.md": "original",
        "processes/playtest.md": "devgame",
        "context/brand.md": "removed",
        "context/tone.md": "adapted",
        "/etc/passwd": "original",
        "context/../../secrets.md": "original",
        ".agents/skills/alpha/SKILL.md": "original",
        ".claude/skills/alpha/SKILL.md": "original",
        ".agents/skills/beta/SKILL.md": "removed",
        ".claude/skills/beta/SKILL.md": "original",
        ".agents/skills/gamma/scripts/run.py": "devgame",
      }),
    });

    expect(collections?.original.workflows.map((item) => item.path)).toEqual([
      "processes/review.md",
    ]);
    expect(collections?.original.context).toEqual([]);
    expect(
      collections?.adaptation.workflows.map((item) => [item.name, item.origin, item.removed]),
    ).toEqual([["playtest.md", "devgame", false]]);
    expect(
      collections?.adaptation.context.map((item) => [item.name, item.origin, item.removed]),
    ).toEqual([
      ["brand.md", "adapted", true],
      ["tone.md", "adapted", false],
    ]);

    expect(collections?.original.skills).toEqual([
      { name: "alpha", origin: "mrmak", openPath: ".agents/skills/alpha/SKILL.md" },
    ]);
    expect(collections?.adaptation.skills).toEqual([
      // Its .agents copy is gone, so the Claude copy is the one to open.
      { name: "beta", origin: "adapted", openPath: ".claude/skills/beta/SKILL.md" },
      { name: "gamma", origin: "devgame", openPath: null },
    ]);
  });
});
