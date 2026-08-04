import type { DockviewApi, DockviewGroupPanel, IDockviewPanel } from "dockview";
import { describe, expect, it, vi } from "vite-plus/test";

import { createPanelRegistry, type PanelRegistry } from "./lib/panelRegistry";
import { TAB_COMPONENT_NO_CLOSE } from "./lib/tabComponents";
import type { PanelDefinition } from "./lib/types";
import { buildTabContextMenuItems } from "./tabContextMenu";

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

function fakePanel(id: string): IDockviewPanel {
  return { id } as unknown as IDockviewPanel;
}

function fakeGroup(isMaximized = false): DockviewGroupPanel {
  return {
    api: { isMaximized: () => isMaximized, exitMaximized: () => {} },
  } as unknown as DockviewGroupPanel;
}

function fakeApi(
  overrides: {
    getPanel?: (id: string) => unknown;
    addPanel?: (options: unknown) => void;
    maximizeGroup?: (panel: IDockviewPanel) => void;
  } = {},
): DockviewApi {
  return {
    getPanel: overrides.getPanel ?? (() => undefined),
    addPanel: overrides.addPanel ?? (() => {}),
    maximizeGroup: overrides.maximizeGroup ?? (() => {}),
  } as unknown as DockviewApi;
}

/** `ContextMenuItem` is `BuiltInContextMenuItem | ContextMenuItemConfig` —
 * `"close"` is the literal built-in string dockview recognizes; everything
 * else this file pushes is a `{label, action}` object. */
function hasCloseItem(items: ReturnType<typeof buildTabContextMenuItems>): boolean {
  return items.includes("close");
}

function findAddTabAction(
  items: ReturnType<typeof buildTabContextMenuItems>,
  title: string,
): (() => void) | undefined {
  const item = items.find(
    (candidate) => typeof candidate === "object" && candidate.label === `Add tab: ${title}`,
  );
  return item && typeof item === "object" ? item.action : undefined;
}

function findMaximizeAction(
  items: ReturnType<typeof buildTabContextMenuItems>,
): (() => void) | undefined {
  const item = items.find(
    (candidate) =>
      typeof candidate === "object" && (candidate.label === "Maximize" || candidate.label === "Restore"),
  );
  return item && typeof item === "object" ? item.action : undefined;
}

describe("buildTabContextMenuItems — finding #2: a no-close tab must have no close item", () => {
  it('omits "close" from the menu for a panel registered with closeable: false', () => {
    const registry = registryWith(stubDefinition({ id: "sidebar", closeable: false }));
    const items = buildTabContextMenuItems({
      panel: fakePanel("sidebar"),
      group: fakeGroup(),
      api: fakeApi(),
      registry,
    });
    expect(hasCloseItem(items)).toBe(false);
  });

  it('includes "close" for an ordinary closeable panel', () => {
    const registry = registryWith(stubDefinition({ id: "files" }));
    const items = buildTabContextMenuItems({
      panel: fakePanel("files"),
      group: fakeGroup(),
      api: fakeApi(),
      registry,
    });
    expect(hasCloseItem(items)).toBe(true);
  });

  it('includes "close" for a panel not found in the registry at all (unknown/quarantined) — refusing to close something unidentifiable would be worse', () => {
    const registry = registryWith(stubDefinition({ id: "files" }));
    const items = buildTabContextMenuItems({
      panel: fakePanel("ghost-panel"),
      group: fakeGroup(),
      api: fakeApi(),
      registry,
    });
    expect(hasCloseItem(items)).toBe(true);
  });
});

describe("buildTabContextMenuItems — finding #3: a re-added panel must retain its tabComponent", () => {
  it('passes tabComponent: TAB_COMPONENT_NO_CLOSE when re-adding a closeable: false panel via "Add tab"', () => {
    const registry = registryWith(
      stubDefinition({ id: "sidebar", title: "Sidebar", closeable: false }),
    );
    let addPanelOptions: Record<string, unknown> | undefined;
    const items = buildTabContextMenuItems({
      panel: fakePanel("chat"),
      group: fakeGroup(),
      api: fakeApi({
        getPanel: (id) => (id === "sidebar" ? undefined : { id }), // sidebar not open -> addable
        addPanel: (options) => {
          addPanelOptions = options as Record<string, unknown>;
        },
      }),
      registry,
    });
    const action = findAddTabAction(items, "Sidebar");
    expect(action).toBeDefined();
    action?.();
    expect(addPanelOptions?.tabComponent).toBe(TAB_COMPONENT_NO_CLOSE);
  });

  it('does NOT pass tabComponent for an ordinary closeable panel re-added via "Add tab" — the real default (WITH_CLOSE) applies via DockviewLayout\'s own defaultTabComponent, not a re-guessed value here', () => {
    const registry = registryWith(stubDefinition({ id: "files", title: "Files" }));
    let addPanelOptions: Record<string, unknown> | undefined;
    const items = buildTabContextMenuItems({
      panel: fakePanel("chat"),
      group: fakeGroup(),
      api: fakeApi({
        getPanel: (id) => (id === "files" ? undefined : { id }),
        addPanel: (options) => {
          addPanelOptions = options as Record<string, unknown>;
        },
      }),
      registry,
    });
    const action = findAddTabAction(items, "Files");
    expect(action).toBeDefined();
    action?.();
    expect(Object.hasOwn(addPanelOptions ?? {}, "tabComponent")).toBe(false);
  });
});

// #89/#92 (independent audit, mutation-tested, 2026-08-04): `maximizeGroup`
// maximizes the panel's GROUP as a whole — it does not also make `panel`
// itself the active tab within that group. This ordering (`setActive()`
// BEFORE `api.maximizeGroup(panel)`, see the "Finding #6" comment above)
// IS the fix for right-clicking Chat's tab and getting Files maximized
// instead, because Files happened to be the group's active tab already.
// Nothing pinned it: deleting the `setActive()` call, or swapping the two
// lines' order, survived the whole suite.
describe("buildTabContextMenuItems — finding #6: Maximize activates the right-clicked panel first", () => {
  it("calls panel.api.setActive() BEFORE api.maximizeGroup(panel) — order, not just occurrence", () => {
    const calls: string[] = [];
    const setActive = vi.fn(() => calls.push("setActive"));
    const maximizeGroup = vi.fn(() => calls.push("maximizeGroup"));
    const panel = { id: "chat", api: { setActive } } as unknown as IDockviewPanel;
    const registry = registryWith(stubDefinition({ id: "chat" }));

    const items = buildTabContextMenuItems({
      panel,
      group: fakeGroup(false),
      api: fakeApi({ maximizeGroup }),
      registry,
    });

    const action = findMaximizeAction(items);
    expect(action).toBeDefined();
    action?.();

    expect(setActive).toHaveBeenCalledOnce();
    expect(maximizeGroup).toHaveBeenCalledExactlyOnceWith(panel);
    // The effect that actually matters: setActive must run FIRST. Calling
    // maximizeGroup(panel) before setActive() would still "call both", but
    // would maximize the group around whichever OTHER tab was already
    // active — silently reproducing finding #6.
    expect(calls).toEqual(["setActive", "maximizeGroup"]);
  });

  it("does NOT call setActive or maximizeGroup when the group is already maximized (the item reads 'Restore' and exits instead)", () => {
    const setActive = vi.fn();
    const maximizeGroup = vi.fn();
    const panel = { id: "chat", api: { setActive } } as unknown as IDockviewPanel;
    const registry = registryWith(stubDefinition({ id: "chat" }));

    const items = buildTabContextMenuItems({
      panel,
      group: fakeGroup(true),
      api: fakeApi({ maximizeGroup }),
      registry,
    });

    const action = findMaximizeAction(items);
    expect(action).toBeDefined();
    action?.();

    expect(setActive).not.toHaveBeenCalled();
    expect(maximizeGroup).not.toHaveBeenCalled();
  });
});
