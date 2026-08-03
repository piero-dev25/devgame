// Ported verbatim (extension stripped) from gamedev-workbench's
// app/web/src/lib/layout/presets.ts.
import type { LayoutPreset, LayoutPresetFactory } from "./types";

export interface PresetRegistry {
  register(preset: LayoutPreset): void;
  /** Builds a fresh dock tree for `id` — never a shared mutable object. */
  build(id: string): ReturnType<LayoutPreset["build"]>;
  list(): LayoutPreset[];
}

/**
 * Default dock presets live as data, not code branches: each workspace picks
 * a preset id, and this registry turns that id into a fresh
 * `SerializedDockview` tree via `DockviewApi.fromJSON`. Building fresh every
 * call (rather than caching one shared tree) means handing the result to two
 * different workspaces never lets one's edits bleed into the other's
 * default.
 */
export function createPresetRegistry(): PresetRegistry {
  const byId = new Map<string, LayoutPreset>();

  return {
    register(preset) {
      if (byId.has(preset.id)) {
        throw new Error(`Preset id "${preset.id}" is already registered`);
      }
      byId.set(preset.id, preset);
    },
    build(id) {
      const preset = byId.get(id);
      if (!preset) {
        throw new Error(`Preset "${id}" is not registered`);
      }
      return preset.build();
    },
    list() {
      return [...byId.values()];
    },
  };
}

export interface BuildPresetSafelyResult {
  tree: ReturnType<LayoutPresetFactory>;
  /** True when `presetId` wasn't registered and `fallback` was used instead. */
  usedFallback: boolean;
}

/**
 * A workspace whose preset id isn't registered must still open on SOMETHING
 * rather than crash — the same "never crash on a bad layout" principle a
 * corrupted persisted layout gets, applied to an unregistered preset id
 * instead.
 *
 * `fallback` is a plain `LayoutPresetFactory`, not a second id looked up
 * through `registry` — a factory reference is always callable, so there's no
 * id left for the fallback path itself to fail to find.
 */
export function buildPresetSafely(
  registry: PresetRegistry,
  presetId: string,
  fallback: LayoutPresetFactory,
): BuildPresetSafelyResult {
  try {
    return { tree: registry.build(presetId), usedFallback: false };
  } catch {
    return { tree: fallback(), usedFallback: true };
  }
}
