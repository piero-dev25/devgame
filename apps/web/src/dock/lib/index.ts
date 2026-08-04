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
  type SaveLayoutResult,
} from "./storage";
export { TAB_COMPONENT_NO_CLOSE, TAB_COMPONENT_WITH_CLOSE } from "./tabComponents";
// Fix-round additions (step-1 review): both pure, DOM-free decision
// functions — see their own files for the finding each one closes.
export { decideImportedLayoutAction, type ImportedLayoutAction } from "./importDecision";
export { computeDuplicateSingletonPanelIds } from "./singletonGuard";
// spec-surfaces-as-dock-panels.md, Part B: the core decision behind
// DockviewLayout.tsx's `openPanel`/`togglePanel` imperative handle actions,
// extracted for the same "no jsdom to drive the ref" reason as
// decideImportedLayoutAction.
export { openPanelInDock, togglePanelInDock } from "./openPanel";
// Fix round after 7606dff45: migrates a saved layout forward when the
// catalog has grown, instead of the workspaceId-bump-and-discard pattern
// that used to be the only way this dock handled that case.
export {
  migrateLoadedLayout,
  type MigrateLoadedLayoutInput,
  type MigrateLoadedLayoutResult,
} from "./layoutMigration";
// Fix round, finding #1 ("app bricks in 3 clicks"): a dockview tree with
// zero panels is never a valid state to persist or restore.
export { isEmptyDockviewTree } from "./emptyLayoutGuard";
export {
  LAYOUT_SCHEMA_VERSION,
  type LayoutFile,
  type LayoutPreset,
  type LayoutPresetFactory,
  type PanelDefinition,
  type PanelProps,
} from "./types";
