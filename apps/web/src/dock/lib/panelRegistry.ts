// Ported verbatim (mechanical sweep only — extension stripped, per
// spec-dock-step-1.md's "this fork's tsconfig doesn't set
// allowImportingTsExtensions") from gamedev-workbench's
// app/web/src/lib/layout/panelRegistry.ts.
import type { PanelDefinition } from "./types";

export interface PanelRegistry {
  /** Registers a catalog entry. Throws if `id` is already registered. */
  register(definition: PanelDefinition): void;
  get(id: string): PanelDefinition | undefined;
  /** Every registered id, in registration order. */
  ids(): string[];
  /** The full id set — what dockview's panel factory treats as "known". */
  knownIds(): ReadonlySet<string>;
  /**
   * Step-1 review "ALSO" note: the `filter` param is currently dead — the
   * one caller today (`tabContextMenu.ts`'s "addable" list) calls this with
   * no filter. Kept deliberately rather than trimmed: it's the natural shape
   * for a future "add panel" picker that groups candidates by column
   * (left/centre/right/bottom) instead of one flat list, which this dock's
   * panel count doesn't yet justify building. Not dead code to clean up —
   * forward-looking scaffolding to leave alone until that picker exists.
   */
  list(filter?: { defaultLocation?: PanelDefinition["defaultLocation"] }): PanelDefinition[];
}

/**
 * The panel catalog: panels register by id into one registry, and the
 * registry is what dockview's panel factory instantiates from. Adding a
 * panel type is a registry entry plus a component — never a change to the
 * layout engine. A factory rather than a module-level singleton so tests
 * (and, if ever needed, multiple catalogs) don't share state.
 */
export function createPanelRegistry(): PanelRegistry {
  const byId = new Map<string, PanelDefinition>();

  return {
    register(definition) {
      if (byId.has(definition.id)) {
        throw new Error(`Panel id "${definition.id}" is already registered`);
      }
      byId.set(definition.id, definition);
    },
    get(id) {
      return byId.get(id);
    },
    ids() {
      return [...byId.keys()];
    },
    knownIds() {
      return new Set(byId.keys());
    },
    list(filter) {
      const all = [...byId.values()];
      if (!filter?.defaultLocation) return all;
      return all.filter((def) => def.defaultLocation === filter.defaultLocation);
    },
  };
}
