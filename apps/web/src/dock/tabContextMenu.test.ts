import type { DockviewApi, DockviewGroupPanel, IDockviewPanel } from "dockview";
import { describe, expect, it } from "vite-plus/test";

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
  return { api: { isMaximized: () => isMaximized } } as unknown as DockviewGroupPanel;
}

function fakeApi(
  overrides: {
    getPanel?: (id: string) => unknown;
    addPanel?: (options: unknown) => void;
  } = {},
): DockviewApi {
  return {
    getPanel: overrides.getPanel ?? (() => undefined),
    addPanel: overrides.addPanel ?? (() => {}),
    maximizeGroup: () => {},
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
