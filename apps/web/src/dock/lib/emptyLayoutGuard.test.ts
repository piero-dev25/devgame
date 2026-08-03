import { Orientation, type SerializedDockview } from "dockview";
import { describe, expect, it } from "vite-plus/test";

import { isEmptyDockviewTree } from "./emptyLayoutGuard";
import { migrateLoadedLayout } from "./layoutMigration";
import { createPanelRegistry } from "./panelRegistry";

describe("isEmptyDockviewTree — fix round, finding #1 (app bricks in 3 clicks)", () => {
  it("is true for the EXACT tree the bug produces — root.data: [], panels: {}", () => {
    const bricked: SerializedDockview = {
      grid: {
        orientation: Orientation.HORIZONTAL,
        width: 1023,
        height: 800,
        root: { type: "branch", data: [], size: 1023 },
      },
      panels: {},
    };
    expect(isEmptyDockviewTree(bricked)).toBe(true);
  });

  it("is false for a normal three-panel layout", () => {
    const normal: SerializedDockview = {
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
              size: 544,
              data: { id: "group-chat", views: ["chat"], activeView: "chat" },
            },
          ],
        },
      },
      panels: { chat: { id: "chat", contentComponent: "chat", title: "Chat" } },
    };
    expect(isEmptyDockviewTree(normal)).toBe(false);
  });

  it("is false for a single remaining panel — only ZERO panels counts as bricked", () => {
    const oneLeft: SerializedDockview = {
      grid: {
        orientation: Orientation.HORIZONTAL,
        width: 544,
        height: 800,
        root: {
          type: "leaf",
          size: 544,
          data: { id: "group-chat", views: ["chat"], activeView: "chat" },
        },
      },
      panels: { chat: { id: "chat", contentComponent: "chat", title: "Chat" } },
    };
    expect(isEmptyDockviewTree(oneLeft)).toBe(false);
  });

  it("is true when `panels` is entirely absent from the tree, not just empty", () => {
    const noPanelsKey = {
      grid: {
        orientation: Orientation.HORIZONTAL,
        width: 100,
        height: 100,
        root: { type: "branch", data: [], size: 100 },
      },
    } as unknown as SerializedDockview;
    expect(isEmptyDockviewTree(noPanelsKey)).toBe(true);
  });
});

describe("the full load pipeline — an empty persisted layout never survives a load (proof bar, finding #1)", () => {
  // The exact realistic case: the user closed every panel deliberately
  // (sidebar/chat/files all recorded in knownPanelIds — the catalog hasn't
  // grown since this was saved), so migrateLoadedLayout correctly refuses
  // to re-add ANY of them (see layoutMigration.ts — that's finding #1's own
  // "closed on purpose" rule, working as designed). The tree stays empty
  // after migration. This is DockviewLayout.tsx's real load-time sequence —
  // `migrateLoadedLayout` then `isEmptyDockviewTree` — run back to back,
  // proving the COMBINATION refuses to survive, not just the predicate in
  // isolation.
  it("stays refused after migration when the catalog has not grown since save", () => {
    const registry = createPanelRegistry();
    for (const id of ["sidebar", "chat", "files"]) {
      registry.register({ id, title: id, icon: () => null, component: () => null } as never);
    }
    const bricked: SerializedDockview = {
      grid: {
        orientation: Orientation.HORIZONTAL,
        width: 1023,
        height: 800,
        root: { type: "branch", data: [], size: 1023 },
      },
      panels: {},
    };
    const defaultTree: SerializedDockview = {
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
    };

    const migration = migrateLoadedLayout({
      loaded: bricked,
      knownPanelIds: ["sidebar", "chat", "files"], // all three deliberately closed, not new
      panelRegistry: registry,
      defaultTree,
    });

    // Never a valid state to RESTORE — this is the load-path check
    // DockviewLayout.tsx runs on migration's own output, exactly as coded.
    expect(isEmptyDockviewTree(migration.tree)).toBe(true);
  });

  // The OTHER real shape: a file saved before knownPanelIds existed at all
  // (undefined baseline). Here migrateLoadedLayout's own "no baseline
  // recorded" fallback treats every registered panel as newly-registered
  // relative to the empty grid, and — since they're all placeable in the
  // flat default tree — grafts them all back in on its own. Recorded here
  // because it is a real, different way the SAME bug never reaches a blank
  // screen: migration itself heals it before the empty-check ever needs to.
  it("self-heals via migration alone when no baseline was ever recorded", () => {
    const registry = createPanelRegistry();
    for (const id of ["sidebar", "chat", "files"]) {
      registry.register({ id, title: id, icon: () => null, component: () => null } as never);
    }
    const bricked: SerializedDockview = {
      grid: {
        orientation: Orientation.HORIZONTAL,
        width: 1023,
        height: 800,
        root: { type: "branch", data: [], size: 1023 },
      },
      panels: {},
    };
    const defaultTree: SerializedDockview = {
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
    };

    const migration = migrateLoadedLayout({
      loaded: bricked,
      knownPanelIds: undefined,
      panelRegistry: registry,
      defaultTree,
    });

    expect(isEmptyDockviewTree(migration.tree)).toBe(false);
    expect(migration.addedPanelIds.slice().sort()).toEqual(["chat", "files", "sidebar"]);
  });
});
