import { Orientation, type SerializedDockview } from "dockview";
import { describe, expect, it } from "vite-plus/test";

import { migrateLoadedLayout } from "./layoutMigration";
import { createPanelRegistry, type PanelRegistry } from "./panelRegistry";
import type { PanelDefinition } from "./types";

function stubDefinition(id: string): PanelDefinition {
  return { id, title: id, icon: () => null, component: () => null } as PanelDefinition;
}

function registryWith(...ids: string[]): PanelRegistry {
  const registry = createPanelRegistry();
  for (const id of ids) registry.register(stubDefinition(id));
  return registry;
}

// Mirrors buildChatDockPreset()'s real shape (ChatDock.tsx): a flat
// HORIZONTAL branch of single-view leaves, sidebar | chat | files.
const DEFAULT_TREE: SerializedDockview = {
  grid: {
    orientation: Orientation.HORIZONTAL,
    width: 1120,
    height: 800,
    root: {
      type: "branch",
      size: 1120,
      data: [
        {
          type: "leaf",
          size: 256,
          data: { id: "group-sidebar", views: ["sidebar"], activeView: "sidebar" },
        },
        {
          type: "leaf",
          size: 544,
          data: { id: "group-chat", views: ["chat"], activeView: "chat" },
        },
        {
          type: "leaf",
          size: 320,
          data: { id: "group-files", views: ["files"], activeView: "files" },
        },
      ],
    },
  },
  panels: {
    sidebar: { id: "sidebar", contentComponent: "sidebar", title: "Sidebar" },
    chat: { id: "chat", contentComponent: "chat", title: "Chat" },
    files: { id: "files", contentComponent: "files", title: "Files" },
  },
  activeGroup: "group-chat",
};

// A pre-Files layout — real shape of the orphaned chat-dock-v2 key — with
// the sidebar DRAGGED wider (392 instead of the preset's 256) as the user's
// own customization to prove survives migration.
function userLayoutBeforeFiles(): SerializedDockview {
  return {
    grid: {
      orientation: Orientation.HORIZONTAL,
      width: 1120,
      height: 800,
      root: {
        type: "branch",
        size: 1120,
        data: [
          {
            type: "leaf",
            size: 392,
            data: { id: "group-sidebar", views: ["sidebar"], activeView: "sidebar" },
          },
          {
            type: "leaf",
            size: 728,
            data: { id: "group-chat", views: ["chat"], activeView: "chat" },
          },
        ],
      },
    },
    panels: {
      sidebar: { id: "sidebar", contentComponent: "sidebar", title: "Sidebar" },
      chat: { id: "chat", contentComponent: "chat", title: "Chat" },
    },
    activeGroup: "group-sidebar",
  };
}

// Mirrors buildChatDockPreset()'s REAL current shape (ChatDock.tsx, after the
// Diff-as-dock-panel promotion, spec-surfaces-as-dock-panels.md Part B): a
// flat HORIZONTAL branch of single-view leaves, sidebar (256, i.e.
// THREAD_SIDEBAR_DEFAULT_WIDTH) | chat (640) | diff (400) — unlike
// DEFAULT_TREE above, whose "files" third leaf predates that panel's Part A
// deletion, this one is checked against ChatDock.tsx's live numbers so a
// future width change there has to update this fixture consciously.
const DIFF_DEFAULT_TREE: SerializedDockview = {
  grid: {
    orientation: Orientation.HORIZONTAL,
    width: 1296,
    height: 800,
    root: {
      type: "branch",
      size: 1296,
      data: [
        {
          type: "leaf",
          size: 256,
          data: { id: "group-sidebar", views: ["sidebar"], activeView: "sidebar" },
        },
        {
          type: "leaf",
          size: 640,
          data: { id: "group-chat", views: ["chat"], activeView: "chat" },
        },
        {
          type: "leaf",
          size: 400,
          data: { id: "group-diff", views: ["diff"], activeView: "diff" },
        },
      ],
    },
  },
  panels: {
    sidebar: { id: "sidebar", contentComponent: "sidebar", title: "Sidebar" },
    chat: { id: "chat", contentComponent: "chat", title: "Chat" },
    diff: { id: "diff", contentComponent: "diff", title: "Diff" },
  },
  activeGroup: "group-chat",
};

// A pre-Diff layout — sidebar dragged wider (392 instead of the preset's
// 256) as the user's own customization to prove survives migration, same
// convention as userLayoutBeforeFiles() above.
function userLayoutBeforeDiff(): SerializedDockview {
  return {
    grid: {
      orientation: Orientation.HORIZONTAL,
      width: 1120,
      height: 800,
      root: {
        type: "branch",
        size: 1120,
        data: [
          {
            type: "leaf",
            size: 392,
            data: { id: "group-sidebar", views: ["sidebar"], activeView: "sidebar" },
          },
          {
            type: "leaf",
            size: 728,
            data: { id: "group-chat", views: ["chat"], activeView: "chat" },
          },
        ],
      },
    },
    panels: {
      sidebar: { id: "sidebar", contentComponent: "sidebar", title: "Sidebar" },
      chat: { id: "chat", contentComponent: "chat", title: "Chat" },
    },
    activeGroup: "group-sidebar",
  };
}

describe("migrateLoadedLayout — proof bar: diff panel promotion (spec-surfaces-as-dock-panels.md, Part B)", () => {
  it("inserts the newly-registered diff panel at its default-preset position while leaving every existing panel's size/order/active-state untouched", () => {
    const registry = registryWith("sidebar", "chat", "diff");
    const loaded = userLayoutBeforeDiff();
    const loadedRoot = loaded.grid.root;
    if (loadedRoot.type !== "branch" || !Array.isArray(loadedRoot.data)) {
      throw new Error("fixture must be a branch root");
    }
    const loadedChildren = loadedRoot.data;

    const result = migrateLoadedLayout({
      loaded,
      knownPanelIds: ["sidebar", "chat"], // diff didn't exist when this was saved
      panelRegistry: registry,
      defaultTree: DIFF_DEFAULT_TREE,
    });

    expect(result.addedPanelIds).toEqual(["diff"]);
    expect(result.unplaceablePanelIds).toEqual([]);

    // The person's positions survived: sidebar's dragged 392 width, chat's
    // 728 width, both still first and second, activeGroup unchanged.
    const root = result.tree.grid.root;
    if (root.type !== "branch" || !Array.isArray(root.data)) {
      throw new Error("expected a branch root");
    }
    const children = root.data;
    expect(children).toHaveLength(3);
    expect(children[0]).toEqual(loadedChildren[0]);
    expect(children[1]).toEqual(loadedChildren[1]);
    expect(result.tree.activeGroup).toBe("group-sidebar");

    // The new panel is present, at the default preset's own position (last),
    // as its OWN leaf (views.length === 1) rather than tabbed into chat's
    // group, and using the default preset's own panels-map entry verbatim.
    const diffLeaf = children[2];
    expect(diffLeaf).toEqual({
      type: "leaf",
      size: 400,
      data: { id: "group-diff", views: ["diff"], activeView: "diff" },
    });
    expect(result.tree.panels.diff).toEqual(DIFF_DEFAULT_TREE.panels.diff);
  });
});

// Mirrors buildChatDockPreset()'s REAL current shape (ChatDock.tsx, after
// task #61's Files promotion): a flat HORIZONTAL branch of single-view
// leaves, sidebar (256) | chat (640) | diff (400) | files (400) — checked
// against ChatDock.tsx's live numbers, same discipline DIFF_DEFAULT_TREE
// above already follows for Diff.
const FILES_DEFAULT_TREE: SerializedDockview = {
  grid: {
    orientation: Orientation.HORIZONTAL,
    width: 1696,
    height: 800,
    root: {
      type: "branch",
      size: 1696,
      data: [
        {
          type: "leaf",
          size: 256,
          data: { id: "group-sidebar", views: ["sidebar"], activeView: "sidebar" },
        },
        {
          type: "leaf",
          size: 640,
          data: { id: "group-chat", views: ["chat"], activeView: "chat" },
        },
        {
          type: "leaf",
          size: 400,
          data: { id: "group-diff", views: ["diff"], activeView: "diff" },
        },
        {
          type: "leaf",
          size: 400,
          data: { id: "group-files", views: ["files"], activeView: "files" },
        },
      ],
    },
  },
  panels: {
    sidebar: { id: "sidebar", contentComponent: "sidebar", title: "Sidebar" },
    chat: { id: "chat", contentComponent: "chat", title: "Chat" },
    diff: { id: "diff", contentComponent: "diff", title: "Diff" },
    files: { id: "files", contentComponent: "files", title: "Files" },
  },
  activeGroup: "group-chat",
};

// A pre-Files-promotion layout — sidebar+chat+diff already existed (Diff's
// own promotion already shipped), sidebar dragged wider (392 instead of the
// preset's 256) as the user's own customization to prove survives migration.
function userLayoutBeforeFilesPanel(): SerializedDockview {
  return {
    grid: {
      orientation: Orientation.HORIZONTAL,
      width: 1520,
      height: 800,
      root: {
        type: "branch",
        size: 1520,
        data: [
          {
            type: "leaf",
            size: 392,
            data: { id: "group-sidebar", views: ["sidebar"], activeView: "sidebar" },
          },
          {
            type: "leaf",
            size: 728,
            data: { id: "group-chat", views: ["chat"], activeView: "chat" },
          },
          {
            type: "leaf",
            size: 400,
            data: { id: "group-diff", views: ["diff"], activeView: "diff" },
          },
        ],
      },
    },
    panels: {
      sidebar: { id: "sidebar", contentComponent: "sidebar", title: "Sidebar" },
      chat: { id: "chat", contentComponent: "chat", title: "Chat" },
      diff: { id: "diff", contentComponent: "diff", title: "Diff" },
    },
    activeGroup: "group-diff",
  };
}

describe("migrateLoadedLayout — proof bar: files panel promotion (spec-surfaces-as-dock-panels.md, Part B, task #61)", () => {
  it("inserts the newly-registered files panel at its default-preset position while leaving every existing panel's size/order/active-state untouched", () => {
    const registry = registryWith("sidebar", "chat", "diff", "files");
    const loaded = userLayoutBeforeFilesPanel();
    const loadedRoot = loaded.grid.root;
    if (loadedRoot.type !== "branch" || !Array.isArray(loadedRoot.data)) {
      throw new Error("fixture must be a branch root");
    }
    const loadedChildren = loadedRoot.data;

    const result = migrateLoadedLayout({
      loaded,
      knownPanelIds: ["sidebar", "chat", "diff"], // files didn't exist when this was saved
      panelRegistry: registry,
      defaultTree: FILES_DEFAULT_TREE,
    });

    expect(result.addedPanelIds).toEqual(["files"]);
    expect(result.unplaceablePanelIds).toEqual([]);

    // The person's positions survived: sidebar's dragged 392 width, chat's
    // 728 width, diff's 400 width, all three still in order, activeGroup
    // unchanged.
    const root = result.tree.grid.root;
    if (root.type !== "branch" || !Array.isArray(root.data)) {
      throw new Error("expected a branch root");
    }
    const children = root.data;
    expect(children).toHaveLength(4);
    expect(children[0]).toEqual(loadedChildren[0]);
    expect(children[1]).toEqual(loadedChildren[1]);
    expect(children[2]).toEqual(loadedChildren[2]);
    expect(result.tree.activeGroup).toBe("group-diff");

    // The new panel is present, at the default preset's own position (last),
    // as its OWN leaf (views.length === 1) rather than tabbed into chat's or
    // diff's group, and using the default preset's own panels-map entry
    // verbatim.
    const filesLeaf = children[3];
    expect(filesLeaf).toEqual({
      type: "leaf",
      size: 400,
      data: { id: "group-files", views: ["files"], activeView: "files" },
    });
    expect(result.tree.panels.files).toEqual(FILES_DEFAULT_TREE.panels.files);
  });
});

describe("migrateLoadedLayout — proof bar: positions survive AND the new panel appears", () => {
  it("inserts the newly-registered panel at its default-preset position while leaving every existing panel's size/order/active-state untouched", () => {
    const registry = registryWith("sidebar", "chat", "files");
    const loaded = userLayoutBeforeFiles();
    const loadedRoot = loaded.grid.root;
    // `SerializedGridObject.data`'s `T | SerializedGridObject<T>[]` union
    // isn't narrowed by TS just from checking `.type` (dockview's own types
    // don't wire the two together) — `Array.isArray` is the guard that
    // actually narrows it, same as layoutMigration.ts's own code does.
    if (loadedRoot.type !== "branch" || !Array.isArray(loadedRoot.data)) {
      throw new Error("fixture must be a branch root");
    }
    const loadedChildren = loadedRoot.data;

    const result = migrateLoadedLayout({
      loaded,
      knownPanelIds: ["sidebar", "chat"], // files didn't exist when this was saved
      panelRegistry: registry,
      defaultTree: DEFAULT_TREE,
    });

    expect(result.addedPanelIds).toEqual(["files"]);
    expect(result.unplaceablePanelIds).toEqual([]);

    // The person's positions survived: sidebar's dragged 392 width, chat's
    // 728 width, both still first and second, activeGroup unchanged.
    const root = result.tree.grid.root;
    if (root.type !== "branch" || !Array.isArray(root.data)) {
      throw new Error("expected a branch root");
    }
    const children = root.data;
    expect(children).toHaveLength(3);
    expect(children[0]).toEqual(loadedChildren[0]);
    expect(children[1]).toEqual(loadedChildren[1]);
    expect(result.tree.activeGroup).toBe("group-sidebar");

    // The new panel is present, at the default preset's own position (last)
    // and using the default preset's own panels-map entry verbatim.
    const filesLeaf = children[2];
    expect(filesLeaf).toEqual({
      type: "leaf",
      size: 320,
      data: { id: "group-files", views: ["files"], activeView: "files" },
    });
    expect(result.tree.panels.files).toEqual(DEFAULT_TREE.panels.files);
  });

  it("does nothing when the loaded layout already has every registered panel", () => {
    const registry = registryWith("sidebar", "chat", "files");
    const result = migrateLoadedLayout({
      loaded: DEFAULT_TREE,
      knownPanelIds: ["sidebar", "chat", "files"],
      panelRegistry: registry,
      defaultTree: DEFAULT_TREE,
    });
    expect(result).toEqual({ tree: DEFAULT_TREE, addedPanelIds: [], unplaceablePanelIds: [] });
  });
});

describe("migrateLoadedLayout — task #91: an on-demand panel absent from the default preset is not an error", () => {
  it("reports neither an add nor an unplaceable notice for a registered panel the default preset never contained, on a fresh default-shaped layout", () => {
    // The exact fresh-install shape: nothing has been dragged, nothing
    // customized — `loaded` IS today's default tree. `third-party-source` is
    // registered (catalog knows about it) but was never part of
    // `buildChatDockPreset()`, matching the real on-demand-panel shape.
    const registry = registryWith("sidebar", "chat", "files", "third-party-source");
    const result = migrateLoadedLayout({
      loaded: DEFAULT_TREE,
      knownPanelIds: ["sidebar", "chat", "files"],
      panelRegistry: registry,
      defaultTree: DEFAULT_TREE,
    });
    // Silent, not "unplaceable" — there was never a placement decision to
    // make. A red "couldn't be updated to include: third-party-source"
    // banner on a first-ever launch is exactly the bug this proves fixed.
    expect(result).toEqual({ tree: DEFAULT_TREE, addedPanelIds: [], unplaceablePanelIds: [] });
  });

  it("also stays silent for the same on-demand panel against a STALE, user-customized layout — absence there isn't migration's business either", () => {
    const registry = registryWith("sidebar", "chat", "files", "third-party-source");
    const loaded = userLayoutBeforeFiles(); // pre-existing, customized, files not yet migrated
    const result = migrateLoadedLayout({
      loaded,
      knownPanelIds: ["sidebar", "chat"], // files didn't exist when this was saved either
      panelRegistry: registry,
      defaultTree: DEFAULT_TREE,
    });
    // files (genuinely in the default preset) still gets added; third-party
    // -source (never in the default preset) is absent from BOTH result
    // lists — proves the discriminator, not just "the banner never fires,"
    // by exercising a case where a REAL migration notice-worthy add is
    // happening in the very same call.
    expect(result.addedPanelIds).toEqual(["files"]);
    expect(result.unplaceablePanelIds).toEqual([]);
  });

  it("still reports the notice-worthy case: a panel the default preset DOES contain, unplaceable due to tree shape, is unaffected by the on-demand exclusion", () => {
    // Sibling proof to the two above: the discriminator must not swallow a
    // real "couldn't place this" case just because SOME panel in the same
    // registry happens to be on-demand. `notes` here IS present in the
    // default tree's own panels map (unlike third-party-source) — it's
    // legitimately new — it just can't be placed because the default tree
    // is shaped as a nested branch, not the flat shape this function knows
    // how to graft into.
    const registry = registryWith("sidebar", "chat", "notes", "third-party-source");
    const nestedDefaultTree: SerializedDockview = {
      grid: {
        orientation: Orientation.HORIZONTAL,
        width: 800,
        height: 600,
        root: {
          type: "branch",
          size: 800,
          data: [
            {
              type: "leaf",
              size: 400,
              data: { id: "group-sidebar", views: ["sidebar"], activeView: "sidebar" },
            },
            {
              type: "branch",
              size: 400,
              data: [
                {
                  type: "leaf",
                  size: 200,
                  data: { id: "group-chat", views: ["chat"], activeView: "chat" },
                },
                {
                  type: "leaf",
                  size: 200,
                  data: { id: "group-notes", views: ["notes"], activeView: "notes" },
                },
              ],
            },
          ],
        },
      },
      panels: {
        sidebar: { id: "sidebar", contentComponent: "sidebar", title: "Sidebar" },
        chat: { id: "chat", contentComponent: "chat", title: "Chat" },
        notes: { id: "notes", contentComponent: "notes", title: "Notes" },
        // Deliberately no `third-party-source` entry — matches the real
        // default preset never including an on-demand panel.
      },
    };
    const loaded: SerializedDockview = {
      grid: {
        orientation: Orientation.HORIZONTAL,
        width: 400,
        height: 600,
        root: {
          type: "leaf",
          size: 400,
          data: { id: "group-sidebar", views: ["sidebar"], activeView: "sidebar" },
        },
      },
      panels: { sidebar: { id: "sidebar", contentComponent: "sidebar", title: "Sidebar" } },
    };
    const result = migrateLoadedLayout({
      loaded,
      knownPanelIds: ["sidebar"],
      panelRegistry: registry,
      defaultTree: nestedDefaultTree,
    });
    expect(result.addedPanelIds).toEqual([]);
    // notes still reported unplaceable (the notice DOES fire for the case
    // that deserves it); third-party-source is absent from either list.
    expect(result.unplaceablePanelIds).toEqual(["chat", "notes"]);
  });
});

describe("migrateLoadedLayout — the user closed it on purpose, do not re-add it", () => {
  it("leaves a panel closed when it WAS in the recorded knownPanelIds baseline, even though it's absent from the grid", () => {
    const registry = registryWith("sidebar", "chat", "files");
    const loaded = userLayoutBeforeFiles(); // files absent from the grid
    const result = migrateLoadedLayout({
      loaded,
      // Unlike the proof-bar test above: files WAS known at save time here —
      // the user had it, and closed it. This is the exact shape a real
      // closed-on-purpose save produces.
      knownPanelIds: ["sidebar", "chat", "files"],
      panelRegistry: registry,
      defaultTree: DEFAULT_TREE,
    });
    expect(result).toEqual({ tree: loaded, addedPanelIds: [], unplaceablePanelIds: [] });
  });
});

describe("migrateLoadedLayout — no recorded baseline (a layout saved before this field existed)", () => {
  it("falls back to treating every currently-missing registered panel as newly-registered", () => {
    const registry = registryWith("sidebar", "chat", "files");
    const loaded = userLayoutBeforeFiles();
    const result = migrateLoadedLayout({
      loaded,
      knownPanelIds: undefined, // exactly chat-dock-v2's real, pre-this-feature shape
      panelRegistry: registry,
      defaultTree: DEFAULT_TREE,
    });
    expect(result.addedPanelIds).toEqual(["files"]);
  });
});

describe("migrateLoadedLayout — degenerate shapes", () => {
  it("wraps a collapsed single-panel (leaf root) layout in a branch so the new panel has somewhere to graft", () => {
    const registry = registryWith("sidebar", "chat", "files");
    const loaded: SerializedDockview = {
      grid: {
        orientation: Orientation.HORIZONTAL,
        width: 800,
        height: 600,
        root: {
          type: "leaf",
          size: 800,
          data: { id: "group-chat", views: ["chat"], activeView: "chat" },
        },
      },
      panels: { chat: { id: "chat", contentComponent: "chat", title: "Chat" } },
    };
    const result = migrateLoadedLayout({
      loaded,
      knownPanelIds: ["chat"],
      panelRegistry: registry,
      defaultTree: DEFAULT_TREE,
    });
    // sidebar AND files are both newly registered relative to this
    // single-panel baseline.
    expect(result.addedPanelIds.slice().sort()).toEqual(["files", "sidebar"]);
    const root = result.tree.grid.root;
    if (root.type !== "branch") throw new Error("expected a branch root after wrapping");
    // The original leaf survives, unmodified, among the new siblings.
    expect(root.data).toContainEqual(loaded.grid.root);
  });

  it("reports a panel as unplaceable rather than guessing when the default tree isn't a flat branch of single-view leaves", () => {
    const registry = registryWith("sidebar", "chat", "notes");
    const nestedDefaultTree: SerializedDockview = {
      grid: {
        orientation: Orientation.HORIZONTAL,
        width: 800,
        height: 600,
        root: {
          type: "branch",
          size: 800,
          data: [
            {
              type: "leaf",
              size: 400,
              data: { id: "group-sidebar", views: ["sidebar"], activeView: "sidebar" },
            },
            {
              // A nested branch — not the flat shape this function knows how
              // to read an unambiguous edge from.
              type: "branch",
              size: 400,
              data: [
                {
                  type: "leaf",
                  size: 200,
                  data: { id: "group-chat", views: ["chat"], activeView: "chat" },
                },
                {
                  type: "leaf",
                  size: 200,
                  data: { id: "group-notes", views: ["notes"], activeView: "notes" },
                },
              ],
            },
          ],
        },
      },
      panels: {
        sidebar: { id: "sidebar", contentComponent: "sidebar", title: "Sidebar" },
        chat: { id: "chat", contentComponent: "chat", title: "Chat" },
        notes: { id: "notes", contentComponent: "notes", title: "Notes" },
      },
    };
    const loaded: SerializedDockview = {
      grid: {
        orientation: Orientation.HORIZONTAL,
        width: 400,
        height: 600,
        root: {
          type: "leaf",
          size: 400,
          data: { id: "group-sidebar", views: ["sidebar"], activeView: "sidebar" },
        },
      },
      panels: { sidebar: { id: "sidebar", contentComponent: "sidebar", title: "Sidebar" } },
    };
    const result = migrateLoadedLayout({
      loaded,
      knownPanelIds: ["sidebar"],
      panelRegistry: registry,
      defaultTree: nestedDefaultTree,
    });
    // chat is at least placeable relative to notes not being flat... in
    // fact NEITHER chat nor notes sits in a flat top-level branch here (both
    // are inside the nested branch), so both are unplaceable — nothing gets
    // silently mispositioned.
    expect(result.addedPanelIds).toEqual([]);
    expect(result.unplaceablePanelIds.slice().sort()).toEqual(["chat", "notes"]);
    // The loaded tree itself is returned untouched — an honest "couldn't
    // place it" never partially mutates the user's arrangement.
    expect(result.tree).toEqual(loaded);
  });
});
