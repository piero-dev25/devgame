import type { DockviewApi, IDockviewPanel } from "dockview";
import { describe, expect, it } from "vite-plus/test";

import { createPanelRegistry, type PanelRegistry } from "./panelRegistry";
import {
  isPanelGroupVisible,
  openPanelInDock,
  subscribePanelGroupVisibility,
  togglePanelGroupVisibility,
  togglePanelInDock,
} from "./openPanel";
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

/**
 * A fake `DockviewGroupPanelApi`, matching dockview-core@7.0.4's real shape
 * closely enough for `togglePanelGroupVisibility`/`isPanelGroupVisible`/
 * `subscribePanelGroupVisibility` to exercise: `setVisible` flips `isVisible`
 * AND fires every registered `onDidVisibilityChange` listener (the real
 * `PanelApiImpl` does both — see `dockview-core`'s `_onDidVisibilityChange`
 * emitter), so a test can assert the mirrored-state side effect these
 * functions exist to produce, not just the call shape.
 */
function fakeGroupPanel(id: string, initialVisible = true): IDockviewPanel {
  let isVisible = initialVisible;
  const listeners = new Set<(event: { isVisible: boolean }) => void>();
  const groupApi = {
    get isVisible() {
      return isVisible;
    },
    setVisible: (next: boolean) => {
      isVisible = next;
      listeners.forEach((listener) => listener({ isVisible }));
    },
    onDidVisibilityChange: (listener: (event: { isVisible: boolean }) => void) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };
  return {
    id,
    group: { api: groupApi },
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

// dock-chrome-strip.md, Section C: the sidebar GROUP hide/show. Unlike
// togglePanelInDock above, this must NEVER call IDockviewPanel.api.close() —
// these tests assert the group-level setVisible/isVisible surface instead,
// and that the panel object itself is never touched (no close, no setActive
// — a visibility toggle is not an activation).
describe("isPanelGroupVisible", () => {
  it("reads the panel's group's live isVisible", () => {
    const api = fakeApi({
      getPanel: (id) => (id === "sidebar" ? fakeGroupPanel("sidebar", true) : undefined),
    });
    expect(isPanelGroupVisible("sidebar", { api })).toBe(true);

    const hiddenApi = fakeApi({
      getPanel: (id) => (id === "sidebar" ? fakeGroupPanel("sidebar", false) : undefined),
    });
    expect(isPanelGroupVisible("sidebar", { api: hiddenApi })).toBe(false);
  });

  it("defaults to true (visible) when the panel isn't open — matching the sidebar's closeable:false, always-open contract", () => {
    const api = fakeApi({ getPanel: () => undefined });
    expect(isPanelGroupVisible("sidebar", { api })).toBe(true);
  });
});

describe("togglePanelGroupVisibility", () => {
  it("flips the group's own isVisible via setVisible — the size-to-zero/restore primitive, not panel close", () => {
    const panel = fakeGroupPanel("sidebar", true);
    const api = fakeApi({ getPanel: (id) => (id === "sidebar" ? panel : undefined) });

    togglePanelGroupVisibility("sidebar", { api });
    expect(panel.group.api.isVisible).toBe(false);

    togglePanelGroupVisibility("sidebar", { api });
    expect(panel.group.api.isVisible).toBe(true);
  });

  it("no-ops silently when the panel isn't open", () => {
    const api = fakeApi({ getPanel: () => undefined });
    expect(() => togglePanelGroupVisibility("sidebar", { api })).not.toThrow();
  });
});

describe("subscribePanelGroupVisibility", () => {
  it("notifies the listener with the group's live isVisible on every change", () => {
    const panel = fakeGroupPanel("sidebar", true);
    const api = fakeApi({ getPanel: (id) => (id === "sidebar" ? panel : undefined) });
    const seen: boolean[] = [];

    subscribePanelGroupVisibility("sidebar", (isVisible) => seen.push(isVisible), { api });
    panel.group.api.setVisible(false);
    panel.group.api.setVisible(true);

    expect(seen).toEqual([false, true]);
  });

  it("the returned unsubscribe stops further notifications", () => {
    const panel = fakeGroupPanel("sidebar", true);
    const api = fakeApi({ getPanel: (id) => (id === "sidebar" ? panel : undefined) });
    const seen: boolean[] = [];

    const unsubscribe = subscribePanelGroupVisibility(
      "sidebar",
      (isVisible) => seen.push(isVisible),
      {
        api,
      },
    );
    unsubscribe();
    panel.group.api.setVisible(false);

    expect(seen).toEqual([]);
  });

  it("returns a harmless no-op unsubscribe when the panel isn't open", () => {
    const api = fakeApi({ getPanel: () => undefined });
    const unsubscribe = subscribePanelGroupVisibility("sidebar", () => {}, { api });
    expect(() => unsubscribe()).not.toThrow();
  });
});
