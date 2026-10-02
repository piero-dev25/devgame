// Structural proof, not a render test — apps/web has no DOM environment
// configured (task #74), so nothing here mounts a component. Plain
// data-structure checks against `createPanelRegistry`/`createPresetRegistry`'s
// real, non-React state — genuinely executed, not typechecked-only.
//
// Every panel component is mocked out, same precedent
// `TerminalDockPanel.test.tsx` already set for the identical problem: a
// real import of `ChatDock.tsx` transitively pulls in `DiffDockPanel` ->
// `@pierre/diffs`'s Web Worker module (`?worker` import touches `self` at
// module scope), which throws in this Node-based test environment before a
// single assertion runs. None of that is what this test is ABOUT — it
// exercises `chatDockPanelRegistry`/`chatDockPresetRegistry`, plain
// non-React state, so replacing every panel's component with a trivial
// stand-in changes nothing about what's being proven.
//
// FIGMA/NOTION DELETED (owner ruling, 2026-08-04, verbatim): "figma and
// notion was all wrong, it just opens a web page... delete figma and notion
// tabs and related code." Wrong at the concept level — an embedded browser
// rendering figma.com was never what "Figma as a tab" meant — not a bug in
// the #78/#79 hardening this file used to assert the hold for. The panel,
// its registration, and the hold assertion are gone with it.
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("./ChatPanel", () => ({
  ChatPanel: () => null,
  ThreadRouteContext: { Provider: ({ children }: { children: unknown }) => children },
}));
vi.mock("./SidebarPanel", () => ({ SidebarPanel: () => null }));
vi.mock("./DiffDockPanel", () => ({ default: () => null }));
vi.mock("./FilesDockPanel", () => ({ default: () => null }));
vi.mock("./TerminalDockPanel", () => ({ default: () => null }));
vi.mock("./BrowserDockPanel", () => ({ default: () => null }));
vi.mock("../projectWorkspace/WorkspacePanel", () => ({ default: () => null }));

const { chatDockPanelRegistry, chatDockPresetRegistry } = await import("./ChatDock");
const {
  BROWSER_PANEL_ID,
  CHAT_PANEL_ID,
  DIFF_PANEL_ID,
  FILES_PANEL_ID,
  TERMINAL_PANEL_ID,
  WORKSPACE_PANEL_ID,
} = await import("./chatDockHandle");
const { migrateLoadedLayout } = await import("./lib/layoutMigration");

function defaultTree() {
  const [preset] = chatDockPresetRegistry.list();
  return preset!.build();
}

/** The default layout as saved before the Workspace panel existed. */
function layoutSavedBeforeWorkspace() {
  const tree = structuredClone(defaultTree());
  const { [WORKSPACE_PANEL_ID]: _removed, ...panels } = tree.panels;
  const root = tree.grid.root as { data: Array<{ data: { views?: string[] } }> };
  root.data = root.data.filter((leaf) => !leaf.data.views?.includes(WORKSPACE_PANEL_ID));
  return { ...tree, panels };
}

describe("ChatDock panel registration", () => {
  it("leaves the four thread-scoped panels registered and in the default preset (no regression)", () => {
    for (const id of [DIFF_PANEL_ID, FILES_PANEL_ID, TERMINAL_PANEL_ID, BROWSER_PANEL_ID]) {
      expect(chatDockPanelRegistry.get(id)).toBeDefined();
    }
    const [preset] = chatDockPresetRegistry.list();
    const tree = preset!.build();
    for (const id of [DIFF_PANEL_ID, FILES_PANEL_ID, TERMINAL_PANEL_ID, BROWSER_PANEL_ID]) {
      expect(Object.keys(tree.panels)).toContain(id);
    }
  });
});

describe("ChatDock Workspace panel", () => {
  it("is registered as a closeable singleton and placed right after Chat in the default preset", () => {
    const definition = chatDockPanelRegistry.get(WORKSPACE_PANEL_ID);
    expect(definition?.singleton).toBe(true);
    expect(definition?.closeable).not.toBe(false);
    const root = defaultTree().grid.root as { data: Array<{ data: { views: string[] } }> };
    const columns = root.data.map((leaf) => leaf.data.views);
    const chatIndex = columns.findIndex((views) => views.includes(CHAT_PANEL_ID));
    expect(columns[chatIndex + 1]).toEqual([WORKSPACE_PANEL_ID]);
  });

  it("is grafted into a layout saved before it existed, keeping every saved panel", () => {
    const saved = layoutSavedBeforeWorkspace();
    const result = migrateLoadedLayout({
      loaded: saved,
      knownPanelIds: Object.keys(saved.panels),
      panelRegistry: chatDockPanelRegistry,
      defaultTree: defaultTree(),
    });
    expect(result.addedPanelIds).toEqual([WORKSPACE_PANEL_ID]);
    expect(result.unplaceablePanelIds).toEqual([]);
    expect(Object.keys(result.tree.panels).toSorted()).toEqual(
      Object.keys(defaultTree().panels).toSorted(),
    );
  });

  it("stays in a reloaded layout that has it, and stays closed in one where the user closed it", () => {
    const withWorkspace = defaultTree();
    const kept = migrateLoadedLayout({
      loaded: withWorkspace,
      knownPanelIds: Object.keys(withWorkspace.panels),
      panelRegistry: chatDockPanelRegistry,
      defaultTree: defaultTree(),
    });
    expect(Object.keys(kept.tree.panels)).toContain(WORKSPACE_PANEL_ID);

    const closed = layoutSavedBeforeWorkspace();
    const stillClosed = migrateLoadedLayout({
      loaded: closed,
      knownPanelIds: [...Object.keys(closed.panels), WORKSPACE_PANEL_ID],
      panelRegistry: chatDockPanelRegistry,
      defaultTree: defaultTree(),
    });
    expect(stillClosed.addedPanelIds).toEqual([]);
    expect(Object.keys(stillClosed.tree.panels)).not.toContain(WORKSPACE_PANEL_ID);
  });
});
