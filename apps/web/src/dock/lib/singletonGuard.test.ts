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

  // The "other direction" sanity checks the team lead asked for: a guard
  // that blocks too much is as bad as one that blocks nothing.
  describe("the inverse — proving the guard does not overreach", () => {
    it("lets a non-singleton panel legitimately appear THREE times, none flagged", () => {
      // Real precedent for this: catalog.tsx's `session` entry is
      // explicitly NOT singleton (owner ruling — multi-agent side-by-side
      // sessions), so this isn't a hypothetical shape.
      const registry = registryWith(stubDefinition({ id: "session", singleton: false }));
      const duplicates = computeDuplicateSingletonPanelIds(
        [
          { panelId: "session-1", componentId: "session" },
          { panelId: "session-2", componentId: "session" },
          { panelId: "session-3", componentId: "session" },
        ],
        registry,
      );
      expect(duplicates.has("session-1")).toBe(false);
      expect(duplicates.has("session-2")).toBe(false);
      expect(duplicates.has("session-3")).toBe(false);
      expect(duplicates.size).toBe(0);
    });

    it("never suppresses the FIRST instance when a stale/restored layout references a singleton panel id twice", () => {
      // The exact real-world trigger this guard exists for: a hand-edited
      // or corrupted persisted layout whose grid references the same
      // singleton `contentComponent` under two different panel ids. The
      // panel that was ALREADY legitimately open (first in registration
      // order) must keep rendering its real content — only the newly
      // materializing second one gets blocked.
      const registry = registryWith(stubDefinition({ id: "chat", singleton: true }));
      const duplicates = computeDuplicateSingletonPanelIds(
        [
          { panelId: "chat", componentId: "chat" }, // legitimately open first
          { panelId: "chat-from-stale-layout", componentId: "chat" }, // the intruder
        ],
        registry,
      );
      expect(duplicates.has("chat")).toBe(false);
      expect(duplicates.has("chat-from-stale-layout")).toBe(true);
      expect(duplicates.size).toBe(1);
    });

    it("does not let a singleton duplicate spill over and block an unrelated non-singleton panel", () => {
      const registry = registryWith(
        stubDefinition({ id: "chat", singleton: true }),
        stubDefinition({ id: "session", singleton: false }),
      );
      const duplicates = computeDuplicateSingletonPanelIds(
        [
          { panelId: "chat", componentId: "chat" },
          { panelId: "chat-2", componentId: "chat" }, // the one real duplicate
          { panelId: "session-1", componentId: "session" },
          { panelId: "session-2", componentId: "session" },
        ],
        registry,
      );
      expect(duplicates.has("chat-2")).toBe(true);
      expect(duplicates.has("session-1")).toBe(false);
      expect(duplicates.has("session-2")).toBe(false);
      expect(duplicates.size).toBe(1);
    });
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
