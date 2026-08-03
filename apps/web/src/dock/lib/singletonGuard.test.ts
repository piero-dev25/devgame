import { describe, expect, it } from "vite-plus/test";

import { createPanelRegistry, type PanelRegistry } from "./panelRegistry";
import { computeDuplicateSingletonPanelIds } from "./singletonGuard";
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

describe("computeDuplicateSingletonPanelIds", () => {
  it("reports no duplicates when a singleton panel has exactly one instance", () => {
    const registry = registryWith(stubDefinition({ id: "chat", singleton: true }));
    const duplicates = computeDuplicateSingletonPanelIds(
      [{ panelId: "chat", componentId: "chat" }],
      registry,
    );
    expect(duplicates.size).toBe(0);
  });

  it("reports every instance after the first as a duplicate for a singleton panel", () => {
    const registry = registryWith(stubDefinition({ id: "chat", singleton: true }));
    const duplicates = computeDuplicateSingletonPanelIds(
      [
        { panelId: "chat", componentId: "chat" },
        { panelId: "chat-2", componentId: "chat" },
        { panelId: "chat-3", componentId: "chat" },
      ],
      registry,
    );
    // The FIRST instance (registration order) is never a duplicate of itself.
    expect(duplicates.has("chat")).toBe(false);
    expect(duplicates.has("chat-2")).toBe(true);
    expect(duplicates.has("chat-3")).toBe(true);
    expect(duplicates.size).toBe(2);
  });

  it("does not flag two instances of a non-singleton panel", () => {
    const registry = registryWith(stubDefinition({ id: "session", singleton: false }));
    const duplicates = computeDuplicateSingletonPanelIds(
      [
        { panelId: "session-1", componentId: "session" },
        { panelId: "session-2", componentId: "session" },
      ],
      registry,
    );
    expect(duplicates.size).toBe(0);
  });

  it("does not flag two DIFFERENT singleton panels open at once", () => {
    const registry = registryWith(
      stubDefinition({ id: "chat", singleton: true }),
      stubDefinition({ id: "sidebar", singleton: true }),
    );
    const duplicates = computeDuplicateSingletonPanelIds(
      [
        { panelId: "chat", componentId: "chat" },
        { panelId: "sidebar", componentId: "sidebar" },
      ],
      registry,
    );
    expect(duplicates.size).toBe(0);
  });

  it("ignores an entry whose componentId isn't in the registry (unknown/quarantined panel)", () => {
    const registry = registryWith(stubDefinition({ id: "chat", singleton: true }));
    const duplicates = computeDuplicateSingletonPanelIds(
      [
        { panelId: "chat", componentId: "chat" },
        { panelId: "ghost", componentId: "not-registered" },
      ],
      registry,
    );
    expect(duplicates.size).toBe(0);
  });
});
