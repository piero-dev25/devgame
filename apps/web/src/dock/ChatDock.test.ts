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

const { chatDockPanelRegistry, chatDockPresetRegistry } = await import("./ChatDock");
const { BROWSER_PANEL_ID, DIFF_PANEL_ID, FILES_PANEL_ID, TERMINAL_PANEL_ID } =
  await import("./chatDockHandle");

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
