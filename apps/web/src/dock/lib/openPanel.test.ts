import type { DockviewApi, IDockviewPanel } from "dockview";
import { describe, expect, it } from "vite-plus/test";

import { createPanelRegistry, type PanelRegistry } from "./panelRegistry";
import { openPanelInDock, togglePanelInDock } from "./openPanel";
import { TAB_COMPONENT_NO_CLOSE } from "./tabComponents";
import type { PanelDefinition } from "./types";

function stubDefinition(overrides: Partial<PanelDefinition> & { id: string }): PanelDefinition {
  return {
    title: overrides.id,
    icon: () => null,
    component: () => null,
    ...overrides,
  } as PanelDefinition;
}

function registryWith(...definitions: PanelDefinition[]): PanelRegistry {
  const registry = createPanelRegistry();
  for (const definition of definitions) registry.register(definition);
  return registry;
}

function fakePanel(id: string, onSetActive?: () => void, onClose?: () => void): IDockviewPanel {
  return {
    id,
    api: { setActive: () => onSetActive?.(), close: () => onClose?.() },
  } as unknown as IDockviewPanel;
}

function fakeApi(overrides: {
  getPanel?: (id: string) => IDockviewPanel | undefined;
  addPanel?: (options: unknown) => void;
}): DockviewApi {
  return {
    getPanel: overrides.getPanel ?? (() => undefined),
    addPanel: overrides.addPanel ?? (() => {}),
  } as unknown as DockviewApi;
}

describe("openPanelInDock — already open anywhere in the layout", () => {
  it("activates the existing panel instead of adding a second one", () => {
    const registry = registryWith(stubDefinition({ id: "diff", title: "Diff" }));
    let addPanelCalls = 0;
    let activated = false;
    const api = fakeApi({
      getPanel: (id) => (id === "diff" ? fakePanel("diff", () => (activated = true)) : undefined),
      addPanel: () => addPanelCalls++,
    });

    openPanelInDock("diff", { api, panelRegistry: registry });

    expect(addPanelCalls).toBe(0);
    expect(activated).toBe(true);
  });
});

describe("openPanelInDock — not open yet, but registered", () => {
  it("adds the panel with its registered title, then activates it", () => {
    const registry = registryWith(stubDefinition({ id: "diff", title: "Diff" }));
    let addPanelOptions: Record<string, unknown> | undefined;
    let activated = false;
    // First getPanel call (the initial check) sees nothing open; every call
    // AFTER addPanel runs (both the setActive lookup here, and the fixture's
    // own re-query) reflects the panel now existing — same shape
    // tabContextMenu.test.ts's fakeApi uses for "not open -> addable".
    let added = false;
    const api = fakeApi({
      getPanel: (id) => {
        if (id !== "diff") return undefined;
        return added ? fakePanel("diff", () => (activated = true)) : undefined;
      },
      addPanel: (options) => {
        addPanelOptions = options as Record<string, unknown>;
        added = true;
      },
    });

    openPanelInDock("diff", { api, panelRegistry: registry });

    expect(addPanelOptions).toMatchObject({ id: "diff", component: "diff", title: "Diff" });
    expect(activated).toBe(true);
  });

  it("passes tabComponent: TAB_COMPONENT_NO_CLOSE for a closeable: false panel", () => {
    const registry = registryWith(
      stubDefinition({ id: "sidebar", title: "Sidebar", closeable: false }),
    );
    let addPanelOptions: Record<string, unknown> | undefined;
    const api = fakeApi({
      getPanel: () => undefined,
      addPanel: (options) => {
        addPanelOptions = options as Record<string, unknown>;
      },
    });

    openPanelInDock("sidebar", { api, panelRegistry: registry });

    expect(addPanelOptions?.tabComponent).toBe(TAB_COMPONENT_NO_CLOSE);
  });

  it("does NOT pass tabComponent for an ordinary closeable panel — the real default applies via DockviewLayout's own defaultTabComponent", () => {
    const registry = registryWith(stubDefinition({ id: "diff", title: "Diff" }));
    let addPanelOptions: Record<string, unknown> | undefined;
    const api = fakeApi({
      getPanel: () => undefined,
      addPanel: (options) => {
        addPanelOptions = options as Record<string, unknown>;
      },
    });

    openPanelInDock("diff", { api, panelRegistry: registry });

    expect(Object.hasOwn(addPanelOptions ?? {}, "tabComponent")).toBe(false);
  });
});

describe("openPanelInDock — unknown panel id", () => {
  it("no-ops silently: nothing added, nothing activated", () => {
    const registry = registryWith(stubDefinition({ id: "diff", title: "Diff" }));
    let addPanelCalls = 0;
    const api = fakeApi({
      getPanel: () => undefined,
      addPanel: () => addPanelCalls++,
    });

    expect(() => openPanelInDock("ghost-panel", { api, panelRegistry: registry })).not.toThrow();
    expect(addPanelCalls).toBe(0);
  });
});

// Review fix after #56: onToggleDiff (ChatView.tsx's Cmd/Ctrl+D handler,
// bound to the diff.toggle command) briefly called openPanelInDock, which
// regressed the shortcut from a genuine toggle to open-only. These prove
// BOTH directions of togglePanelInDock, the fix.
describe("togglePanelInDock — not open yet", () => {
  it("opens it (delegates to openPanelInDock's add-then-activate), same as openPanelInDock alone", () => {
    const registry = registryWith(stubDefinition({ id: "diff", title: "Diff" }));
    let addPanelOptions: Record<string, unknown> | undefined;
    let activated = false;
    let added = false;
    const api = fakeApi({
      getPanel: (id) => {
        if (id !== "diff") return undefined;
        return added ? fakePanel("diff", () => (activated = true)) : undefined;
      },
      addPanel: (options) => {
        addPanelOptions = options as Record<string, unknown>;
        added = true;
      },
    });

    togglePanelInDock("diff", { api, panelRegistry: registry });

    expect(addPanelOptions).toMatchObject({ id: "diff", component: "diff", title: "Diff" });
    expect(activated).toBe(true);
  });
});

describe("togglePanelInDock — already open", () => {
  it("closes it via IDockviewPanel.api.close(), the same primitive the tab's × button uses", () => {
    const registry = registryWith(stubDefinition({ id: "diff", title: "Diff" }));
    let closed = false;
    let addPanelCalls = 0;
    const api = fakeApi({
      getPanel: (id) =>
        id === "diff" ? fakePanel("diff", undefined, () => (closed = true)) : undefined,
      addPanel: () => addPanelCalls++,
    });

    togglePanelInDock("diff", { api, panelRegistry: registry });

    expect(closed).toBe(true);
    expect(addPanelCalls).toBe(0);
  });

  it("does not also activate or re-add the panel it just closed", () => {
    const registry = registryWith(stubDefinition({ id: "diff", title: "Diff" }));
    let activated = false;
    let addPanelCalls = 0;
    const api = fakeApi({
      getPanel: (id) => (id === "diff" ? fakePanel("diff", () => (activated = true)) : undefined),
      addPanel: () => addPanelCalls++,
    });

    togglePanelInDock("diff", { api, panelRegistry: registry });

    expect(activated).toBe(false);
    expect(addPanelCalls).toBe(0);
  });
});

describe("togglePanelInDock — unknown panel id", () => {
  it("no-ops silently: nothing added, nothing closed", () => {
    const registry = registryWith(stubDefinition({ id: "diff", title: "Diff" }));
    let addPanelCalls = 0;
    const api = fakeApi({
      getPanel: () => undefined,
      addPanel: () => addPanelCalls++,
    });

    expect(() => togglePanelInDock("ghost-panel", { api, panelRegistry: registry })).not.toThrow();
    expect(addPanelCalls).toBe(0);
  });
});
