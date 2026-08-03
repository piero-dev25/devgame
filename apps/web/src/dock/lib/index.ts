// Barrel export for the ported layout engine (spec-dock-step-1.md).
//
// Trimmed relative to gamedev-workbench's app/web/src/lib/layout/index.ts:
// no `panelIds.ts` (ICM-specific panel id constants — nothing here needs
// them, step 1 defines its own two panel ids directly in ChatDock.tsx), no
// `presets/coreCombat.ts` / `presets/narrative.ts` (pixel geometry measured
// against a mock that doesn't exist in this fork — this is the second of
// the spec's "two couplings to cut"), no `createDefaultPresetRegistry`
// (would only exist to pre-register those two presets), and no
// `serverStorage.ts` (PUTs against that app's own `/api/workspace/layout`
// route — see storage.ts's module doc for why step 1 stays on
// `localStorage` instead).
export {
  computeFloatingConstraints,
  syncFloatingConstraints,
  type FloatingConstraints,
} from "./constraints";
export { createPanelRegistry, type PanelRegistry } from "./panelRegistry";
export {
  buildPresetSafely,
  createPresetRegistry,
  type BuildPresetSafelyResult,
  type PresetRegistry,
} from "./presets";
export {
  buildLayoutFile,
  findUnknownPanelIds,
  parseLayoutFile,
  parseLayoutValue,
  type ParseLayoutFailureReason,
  type ParseLayoutResult,
} from "./serialization";
export {
  buildLayoutFilename,
  createLocalStorageLayoutStorage,
  type LayoutStorage,
  type LoadLayoutResult,
} from "./storage";
export { TAB_COMPONENT_NO_CLOSE, TAB_COMPONENT_WITH_CLOSE } from "./tabComponents";
export {
  LAYOUT_SCHEMA_VERSION,
  type LayoutFile,
  type LayoutPreset,
  type LayoutPresetFactory,
  type PanelDefinition,
  type PanelProps,
} from "./types";
