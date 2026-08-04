// Structural proof, not a render test — apps/web has no DOM environment
// configured (task #74), so nothing here mounts a component. This asserts
// the two facts task #55's registration work actually claims: the
// Figma/Notion panel IS in the panel catalog (reachable via "Add tab" —
// see `tabContextMenu.ts`'s `registry.list()`-driven "addable" menu), and
// it is deliberately NOT part of the default preset's initial tree. Both
// are plain data-structure checks against `createPanelRegistry`/
// `createPresetRegistry`'s real, non-React state — genuinely executed, not
// typechecked-only, and would fail for real if either fact stopped being
// true (e.g. a future edit accidentally added the panel to
// `buildChatDockPreset()`, or the registration block itself was removed).
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
vi.mock("./ThirdPartySourceDockPanel", () => ({ default: () => null }));

const { chatDockPanelRegistry, chatDockPresetRegistry, THIRD_PARTY_SOURCE_PANEL_ID } =
  await import("./ChatDock");
const { BROWSER_PANEL_ID, DIFF_PANEL_ID, FILES_PANEL_ID, TERMINAL_PANEL_ID } =
  await import("./chatDockHandle");

describe("ChatDock panel registration", () => {
  it("registers Figma/Notion in the panel catalog, reachable via Add tab", () => {
    const definition = chatDockPanelRegistry.get(THIRD_PARTY_SOURCE_PANEL_ID);
    expect(definition).toBeDefined();
    expect(definition?.title).toBe("Figma / Notion");
    expect(definition?.singleton).toBe(true);
  });

  it("does not add Figma/Notion to the default preset's initial panels", () => {
    const [preset] = chatDockPresetRegistry.list();
    expect(preset).toBeDefined();
    const tree = preset!.build();
    expect(Object.keys(tree.panels)).not.toContain(THIRD_PARTY_SOURCE_PANEL_ID);
  });

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
