// Ported from gamedev-workbench's app/web/src/lib/layout/types.ts (step 1 —
// docs/workbench/spec-dock-step-1.md). Generic layout-engine types; no
// coupling to that app's data model.
//
// PORT FIX: the source imports `SerializedDockview` from "dockview-core"
// directly. That resolves there only because that repo's package manager
// happens to hoist dockview-core to a location plain Node resolution can
// reach — this fork's pnpm install is strict (verified: `dockview-core`
// does NOT resolve from apps/web, only `dockview` does). `dockview`'s own
// `index.d.ts` is `export * from 'dockview-core'` (see reactContentRenderer.tsx's
// doc comment), so importing the same type from "dockview" instead is
// identical in every way that matters here and actually resolves.
import type { SerializedDockview } from "dockview";

/**
 * The schema version written to every persisted layout. Bumped only when the
 * on-disk shape changes in a way old files can't be read as-is — see
 * `parseLayoutFile`'s version-mismatch path in `serialization.ts`.
 */
export const LAYOUT_SCHEMA_VERSION = 1;

/**
 * On-disk shape of a persisted layout. `dockview` is treated as an OPAQUE
 * blob — the exact, unmodified result of `DockviewApi.toJSON()` — and is the
 * single source of truth on restore (`DockviewApi.fromJSON(file.dockview)`).
 *
 * `floating` mirrors `dockview.floatingGroups` at save time for a
 * human-legible on-disk shape; it is never read back on restore, so it can't
 * diverge from the opaque blob and become a second source of truth.
 */
export interface LayoutFile {
  version: number;
  preset: string;
  dockview: SerializedDockview;
  floating: NonNullable<SerializedDockview["floatingGroups"]>;
  savedAt: string;
  /**
   * Fix round after 7606dff45 — every panel id the catalog knew about at
   * save time. This is what `lib/layoutMigration.ts`'s `migrateLoadedLayout`
   * uses to tell "newly registered since this was saved, migrate it in"
   * apart from "was already known and the user closed it on purpose, leave
   * it closed" — a distinction the grid/panels data alone can't make, since
   * both cases look identical (the panel is simply absent from both).
   *
   * Optional, NOT because it's unimportant, but because every layout saved
   * before this field existed doesn't have it — see `migrateLoadedLayout`'s
   * own doc for the fallback rule that applies when it's absent. Not a
   * `LAYOUT_SCHEMA_VERSION` bump: an old file without this field is still
   * fully readable as-is, just with a less precise migration baseline —
   * that's a smaller claim than "this build can't read this file at all,"
   * which is the only thing a version bump is for.
   */
  knownPanelIds?: string[];
}

/**
 * A catalog entry. `component` renders panel content; the panel registry is
 * what dockview's panel factory looks up by id.
 */
export interface PanelDefinition<P extends object = Record<string, unknown>> {
  id: string;
  title: string;
  /** A lucide-react icon component, rendered at a fixed small size in tabs. */
  icon: React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
  component: React.ComponentType<PanelProps<P>>;
  // "left" added for step 2 (spec-dock-step-2.md): the source union had no
  // slot for a genuinely left-docked panel because nothing in that app's
  // catalog was ever left-docked. Purely informational metadata today —
  // nothing reads `defaultLocation` except `PanelRegistry.list()`'s unused
  // filter param — but mislabeling the sidebar "centre" to avoid a one-line
  // type edit would be worse than extending the union honestly.
  defaultLocation?: "centre" | "right" | "bottom" | "left";
  /** Honoured ONLY while the panel's group is floating — never while docked. */
  minWidth?: number;
  minHeight?: number;
  /** Only one instance of this panel may exist per workspace layout. */
  singleton?: boolean;
  /**
   * Fix round after the "app bricks in 3 clicks" critique: whether THIS
   * panel type may ever be closed. Defaults to `true` (closeable) when
   * omitted — most panels have no reason to refuse it.
   *
   * Previously "no-close" was expressed only as a literal `tabComponent:
   * TAB_COMPONENT_NO_CLOSE` string on a PRESET's panel entry — which hid the
   * × visually but did nothing else: `tabContextMenu.ts`'s right-click menu
   * pushed `"close"` unconditionally regardless of it (closing the sidebar
   * that way silently killed T3's Cmd+1..9 shortcuts), and re-adding a
   * closed panel via "Add tab" called `api.addPanel()` with no
   * `tabComponent` at all, silently downgrading a permanently-protected
   * panel to closeable on every round trip. Two independent bugs, same root
   * cause: "closeable" was a per-INSTANCE dockview string nobody but the
   * preset builder ever set, instead of a property of the panel TYPE itself.
   *
   * This field is now the single source of truth, read by all three call
   * sites that used to each decide independently: `buildChatDockPreset()`
   * (ChatDock.tsx, for the initial default layout), `tabContextMenu.ts`'s
   * close-item gate, and its `addPanel()` re-add call.
   */
  closeable?: boolean;
}

export interface PanelProps<P extends object = Record<string, unknown>> {
  params: P;
  /**
   * Writes back into THIS panel instance's params. Deliberately a narrow
   * callback rather than dockview's panel api: a panel component must not need
   * to know what dock library it is inside — that is the whole point of the
   * catalog seam.
   *
   * Params are serialized into the persisted layout, so this is also how
   * per-panel state survives a reload. Step 1's chat panel deliberately never
   * calls this with thread identity — see ChatPanel.tsx.
   *
   * Optional because panels rendered outside a dock (tests, dev harnesses)
   * have nothing to write back to.
   *
   * `| undefined` spelled out explicitly, not just `?:` — this fork's
   * tsconfig.base.json sets `exactOptionalPropertyTypes: true` (the source
   * repo's does not), which treats an explicitly-`undefined`-valued prop as
   * a type error unless the property type says so itself.
   * `reactContentRenderer.tsx` does exactly that (`api?.updateParameters ?
   * ... : undefined`), so this has to be spelled out.
   */
  updateParams?: ((next: P) => void) | undefined;
}

/** A function that builds a fresh default dock tree for one workspace kind. */
export type LayoutPresetFactory = () => SerializedDockview;

export interface LayoutPreset {
  id: string;
  label: string;
  build: LayoutPresetFactory;
}
