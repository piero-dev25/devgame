// Ported from gamedev-workbench's
// app/web/src/components/layout/DockviewLayout.tsx (spec-dock-step-1.md).
//
// Two couplings cut on the way in (spec's "Two couplings to cut" section):
//  1. `createDefaultPanelRegistry` (source: `./catalog.tsx`) — that catalog
//     drags in `AgentSessionProvider`, `WorkspaceDataProvider`,
//     `ConnectionsPanel` and every fixture from an app this fork doesn't
//     have. `panelRegistry` is now a REQUIRED prop instead of an optional
//     one defaulting to that catalog.
//  2. `buildCoreCombatPreset` (source: `./lib/presets/coreCombat.ts`) —
//     pixel geometry measured against a mock that doesn't exist here, used
//     as the hard-coded fallback when a preset id isn't registered.
//     `fallbackPreset` is now a REQUIRED prop instead of that hard-coded
//     import. `presetRegistry` is likewise required, not defaulted to
//     `createDefaultPresetRegistry()` (which only existed to pre-register
//     that same coupled preset plus a sibling "narrative" one).
//
// Everything else — the dockview wiring, the persistence/notice/recovery
// state machine — is unchanged from source; see its own comments (dated
// findings from that app's review passes) for why each piece of that
// machinery exists. Mechanical sweep applied throughout: relative imports
// have their `.ts`/`.tsx` extensions stripped (this fork's tsconfig doesn't
// set `allowImportingTsExtensions`), and `cn` comes from `~/lib/utils`
// instead of the source's `lib/cn.ts` (identical `(...inputs) =>
// twMerge(...)` signature, so every call site below is unchanged).
import { createDockview, type DockviewApi, type DockviewTheme } from "dockview";
import "dockview/dist/styles/dockview.css";
import { Minimize2, RotateCcw } from "lucide-react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";

import { Button } from "~/components/ui/button";
import { selectActivePanelForKey, useDockActiveSelectionStore } from "~/dockActiveSelectionStore";
import { cn } from "~/lib/utils";

import {
  applyMaximizedGroupAccessibility,
  buildLayoutFile,
  buildLayoutFilename,
  buildPresetSafely,
  createLocalStorageLayoutStorage,
  findUnknownPanelIds,
  isEmptyDockviewTree,
  migrateLoadedLayout,
  openPanelInDock,
  parseLayoutFile,
  restoreActivePanelForKey,
  syncFloatingConstraints,
  togglePanelInDock,
  type LayoutPresetFactory,
  type LayoutStorage,
  type LoadLayoutResult,
  type PresetRegistry,
} from "./lib/index";
import { decideImportedLayoutAction } from "./lib/importDecision";
import type { PanelRegistry } from "./lib/panelRegistry";
import { computeDuplicateSingletonPanelIds } from "./lib/singletonGuard";
import { TAB_COMPONENT_NO_CLOSE, TAB_COMPONENT_WITH_CLOSE } from "./lib/tabComponents";
import "./dockviewTheme.css";
import { LayoutNotice } from "./LayoutNotice";
import { PanelErrorBoundary } from "./PanelErrorBoundary";
import { createPanelPortalStore, type PanelPortalEntry } from "./panelPortalStore";
import { QuarantinePanel } from "./QuarantinePanel";
import { createReactContentRenderer } from "./reactContentRenderer";
import { createReactTabRenderer } from "./reactTabRenderer";
import { SingletonBlockedPanel } from "./SingletonBlockedPanel";
import { buildTabContextMenuItems } from "./tabContextMenu";

const WORKBENCH_THEME: DockviewTheme = {
  name: "workbench",
  className: "dockview-theme-workbench",
  colorScheme: "dark",
  gap: 1,
  dndOverlayMounting: "relative",
  dndPanelOverlay: "content",
  dndTabIndicator: "line",
  // We hand-draw the active-tab underline ourselves in dockviewTheme.css
  // using the measured accent, rather than dockview's per-group colour
  // system (paired with `tabGroupAccent: 'off'` below).
  tabGroupIndicator: "none",
};

/** A debounce short enough that a reload right after a drag still sees the latest arrangement. */
const PERSIST_DEBOUNCE_MS = 250;

/**
 * STABILITY CONTRACT (fix-round finding #4 — this used to live only in an
 * inline comment on the mount effect below, where the next caller wiring a
 * second dock would not read it before getting bitten): `panelRegistry`,
 * `presetRegistry`, `storage`, and `fallbackPreset` must be referentially
 * STABLE for the lifetime of one mount. The internal mount effect only
 * re-runs when `workspaceId`/`presetId` change identity — it deliberately
 * does NOT watch these four (see the effect's own
 * `eslint-disable-next-line react-hooks/exhaustive-deps`). A caller that
 * rebuilds any of them on every render will NOT get a fresh dockview
 * instance from that change alone; only a `workspaceId`/`presetId` change
 * tears down and recreates the dock. `ChatDock.tsx` satisfies this by
 * building all four exactly once, at module scope, before any component
 * that uses them ever renders — that pattern, not per-render construction,
 * is what any future second dock should copy.
 */
export interface DockviewLayoutProps {
  /** Identifies the saved layout — layouts are saved PER WORKSPACE. */
  workspaceId: string;
  /** Used to name exported layout files. */
  workspaceName: string;
  /** Which registered preset (from `presetRegistry`) this workspace opens with by default. */
  presetId: string;
  panelRegistry: PanelRegistry;
  presetRegistry: PresetRegistry;
  /**
   * Built when `presetId` isn't registered in `presetRegistry` — see
   * `buildPresetSafely` (lib/presets.ts). Required rather than defaulted:
   * this component is now a generic layout engine with no house preset of
   * its own, so every caller must say explicitly what "never crash on a
   * bad layout" falls back to.
   */
  fallbackPreset: LayoutPresetFactory;
  storage?: LayoutStorage;
  /**
   * Fix round after 7606dff45: workspace ids this caller has permanently
   * retired (e.g. a previous `workspaceId` from before this dock started
   * migrating layouts instead of bumping the key) and no longer reads from.
   * Cleared from `storage` once, best-effort, on mount — `storage.clear()`
   * on an already-absent key is a harmless no-op, so this is safe to pass
   * the same list on every render/mount without tracking whether cleanup
   * already ran. Generic on this component (not hardcoded to any one
   * caller's history) so any consumer can retire a key the same way.
   */
  staleWorkspaceIds?: string[];
  /**
   * Fix round, finding #5 ("selecting a thread does not show you the
   * thread"): with one dock instance persisted across every route
   * (deliberately — see ChatDock.tsx's own doc on why it never remounts on
   * a thread switch), whatever tab happened to be active before a
   * navigation stays active after it. Clicking a thread in the sidebar with
   * some OTHER panel active leaves the visible content exactly what it was
   * — no composer, no transcript, no hint that chat is one click away. A
   * straight regression against plain T3, where selecting a thread always
   * shows you the thread.
   *
   * When `activationKey`'s IDENTITY changes, the panel named by
   * `activateOnChangeId` (if currently open) is brought to the front of its
   * group via `panel.api.setActive()` — WITHOUT tearing down or reloading
   * anything else, unlike `workspaceId`/`presetId`, which do. Both optional
   * together: omit both to opt out of this entirely (a future second dock
   * with no equivalent "which thing is the user looking at" concept has no
   * reason to force anything active on its own).
   *
   * Task #108 EXTENSION: `activateOnChangeId` is now a FALLBACK, not the
   * unconditional target — whenever `activationKey` also has its own
   * remembered selection (`dockActiveSelectionStore.ts`, keyed by
   * `String(activationKey)`) AND that panel is still open, THAT wins
   * instead. `activateOnChangeId` still fires exactly as this comment
   * originally described for any key with no remembered selection yet (a
   * thread visited for the first time), so finding #5's guarantee is
   * unchanged for that case. See `restoreActivePanelForKey`
   * (`lib/restoreActivePanel.ts`) for the actual precedence logic.
   */
  activationKey?: string | number;
  activateOnChangeId?: string;
  // `| undefined` spelled out explicitly — this fork's tsconfig.base.json
  // sets `exactOptionalPropertyTypes: true` (the source repo's does not),
  // and ChatDock.tsx passes this straight through from its own optional
  // `className` prop, which is `string | undefined` after destructuring.
  className?: string | undefined;
}

/**
 * Imperative actions a composing parent can trigger from OUTSIDE this
 * component. A parent holds a `ref` to this component to wire these into
 * its own chrome (a toolbar, a "..." menu — this component renders none of
 * that itself).
 *
 * Step-1 review "ALSO" note: this fork has no workspace-header-equivalent
 * chrome yet (unlike the source app's `WorkspaceHeader`), so nothing in
 * PRODUCT UI currently holds a `ref` here and calls these three. Kept as
 * real, typed, implemented API surface rather than wired-up-or-deleted —
 * `importLayoutFile`'s own core decision logic (what to do with a parsed
 * file, unmount-aware) is unit-tested directly via `lib/importDecision.ts`
 * (this repo has no jsdom/mounted-component test infra to drive the ref
 * itself end-to-end; see that file's test for what IS covered). Wiring an
 * actual "..." menu that holds this ref is a UI task for a later step, not
 * this fix round.
 */
export interface DockviewLayoutHandle {
  reset(): void;
  exportLayout(): void;
  importLayoutFile(file: File): void;
  /**
   * spec-surfaces-as-dock-panels.md, Part B: opens a panel by its registered
   * id, for callers OUTSIDE the dock (see `chatDockHandle.ts`) that need
   * "make this panel visible" without caring whether it's already open.
   * Get-or-add-then-setActive: if the panel is already live anywhere in this
   * layout, just activates it; otherwise adds it (mirroring
   * `tabContextMenu.ts`'s "Add tab" — same `api.addPanel()` shape, same
   * `closeable` handling) and THEN activates it. No-ops, silently, for an id
   * that isn't in `panelRegistry` at all — nothing to add, nothing to
   * activate.
   */
  openPanel(id: string): void;
  /**
   * spec-surfaces-as-dock-panels.md, Part B, review fix after #56: a GENUINE
   * toggle, unlike `openPanel` above (deliberately open-only, so a caller
   * that just wants "make sure this is visible" — e.g. clicking a turn's
   * diff button twice — never has its second click close the thing it's
   * looking at). This is for a caller that means toggle, like a keyboard
   * shortcut named after toggling: already open anywhere -> closes it
   * (`IDockviewPanel.api.close()`, dockview's own close primitive, the same
   * one the tab's × button already uses); not open -> defers to the same
   * open-then-activate behaviour as `openPanel`. No-ops, silently, for an id
   * that isn't in `panelRegistry` at all, same as `openPanel`.
   */
  togglePanel(id: string): void;
}

/**
 * Renders one live dock panel's content, reached through the portal store.
 * `PanelErrorBoundary` wraps ALL THREE branches (the real component, the
 * `QuarantinePanel` fallback, and — fix-round finding #1 — the
 * `SingletonBlockedPanel` fallback), not just the found-in-registry branch —
 * a throw in any arm quarantines to this panel's own tab rather than
 * escaping to wherever this component itself is mounted (which has no
 * boundary of its own above it).
 *
 * `isDuplicateSingleton` is computed once per render, over every live entry,
 * by `computeDuplicateSingletonPanelIds` (lib/singletonGuard.ts) — see that
 * file for why this is the enforcement point rather than only
 * `tabContextMenu.ts`'s "addable" filter.
 */
function PanelPortalContent({
  entry,
  registry,
  isDuplicateSingleton,
}: {
  entry: PanelPortalEntry;
  registry: PanelRegistry;
  isDuplicateSingleton: boolean;
}) {
  const definition = registry.get(entry.componentId);
  return (
    <PanelErrorBoundary panelTitle={definition?.title ?? entry.componentId}>
      {!definition ? (
        <QuarantinePanel componentId={entry.componentId} />
      ) : isDuplicateSingleton ? (
        <SingletonBlockedPanel title={definition.title} />
      ) : (
        <definition.component params={entry.params} updateParams={entry.updateParams} />
      )}
    </PanelErrorBoundary>
  );
}

/**
 * The dock container: mounts dockview-core, loads this workspace's saved
 * layout (or its default preset), and persists every change back out.
 * Must be given a definite height by its parent — `className="h-full
 * min-h-0"` on the wrapper the caller renders this into is the usual shape.
 */
export const DockviewLayout = forwardRef<DockviewLayoutHandle, DockviewLayoutProps>(
  function DockviewLayout(
    {
      workspaceId,
      workspaceName,
      presetId,
      panelRegistry,
      presetRegistry,
      fallbackPreset,
      storage: storageProp,
      staleWorkspaceIds,
      activationKey,
      activateOnChangeId,
      className,
    },
    forwardedRef,
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const apiRef = useRef<DockviewApi | null>(null);
    // Task #108: lets the mount effect's `onDidActivePanelChange`
    // subscription below (set up ONCE, never re-created on a thread switch —
    // see that effect's own comment) always persist to the CURRENT thread's
    // key, not whichever key was live when the dock first mounted. Kept in
    // sync by the activationKey-change effect further down, the only other
    // place `activationKey` is read.
    const activationKeyRef = useRef(activationKey);
    const [notice, setNotice] = useState<string | null>(null);
    // Task #109: which group (if any) is currently maximized — drives the
    // visible "Restore" button below. dockview's own maximize mechanism
    // (right-click a tab -> Maximize) has NO visible affordance to get back
    // out; the only documented ways are that same context menu's "Restore"
    // item or Escape (fix-round finding #6, added earlier for the identical
    // "no way out" complaint). Neither is discoverable without already
    // knowing it exists — this button is the third, visible one.
    const [maximizedGroupId, setMaximizedGroupId] = useState<string | null>(null);
    // When the saved layout was refused because it's a *newer* schema version
    // than this build understands, the automatic save must not overwrite it
    // with a current-version file the instant the user touches anything —
    // that would silently destroy data a newer build could still have read.
    // Explicit actions (reset, import) are exempt: they're a deliberate
    // choice to replace the file, not an incidental splitter nudge.
    const autoSaveBlockedRef = useRef(false);
    // Swallows exactly one automatic persist — the one caused by recovering onto
    // a fallback preset after an import we refused. See `maybePersist`.
    const suppressRecoveryPersistRef = useRef(false);
    // Fix-round finding #3: set false in the mount effect's cleanup, read by
    // every async continuation that resumes after touching `apiRef.current`
    // (currently: `handleImportFile`'s `file.text().then(...)`, and the
    // save-result reporting below) — the same "don't act on a disposed
    // DockviewApi" guard `loadInitialLayout`'s own `cancelled` flag already
    // provides for the initial load, extended to every other async gap.
    const isMountedRef = useRef(true);
    // Fix-round finding #2: gates the save-failure notice to ONCE per
    // session rather than once per debounce tick — every drag/resize
    // schedules a save, so a broken `storage.save` would otherwise re-show
    // the same notice every ~250ms. Reset to `false` the next time a save
    // SUCCEEDS, so a later, different failure after a recovery still gets
    // reported — this is a standing "already told them" flag, not a
    // one-shot-forever suppression.
    const saveFailureNoticeShownRef = useRef(false);

    const storage = useMemo(() => storageProp ?? createLocalStorageLayoutStorage(), [storageProp]);

    // Best-effort, once per mount: purge any workspace ids the caller has
    // permanently retired. Deliberately its own effect, independent of the
    // main mount effect below (which only re-runs on workspaceId/presetId
    // changes) — this has nothing to do with loading/persisting THIS
    // workspace, and `storage.clear()` on an already-gone key is a no-op, so
    // there's no correctness reason to gate it any more tightly than "ran
    // once, this mount."
    useEffect(() => {
      for (const staleId of staleWorkspaceIds ?? []) {
        void storage.clear(staleId);
      }
      // Deliberately `staleWorkspaceIds`-less deps — it's a caller-supplied
      // constant list (ChatDock.tsx builds it at module scope), and
      // re-running this on every render-identity change of that array would
      // defeat the "once per mount" intent for no benefit: clearing an
      // already-cleared key is a no-op either way.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [storage]);

    // Fix round, finding #5, EXTENDED for task #108 ("dock tab selection
    // leaks across chats"): whenever `activationKey` (that route's thread
    // identity) changes — including on this component's OWN first render,
    // which naturally no-ops harmlessly if `apiRef.current` isn't populated
    // yet (nothing has loaded to activate) — this brings the RIGHT panel to
    // the front of its group. "Right" now means: this thread's OWN
    // remembered selection (`dockActiveSelectionStore.ts`, written by the
    // mount effect's `onDidActivePanelChange` subscription below) if it has
    // one and that panel is still open; otherwise `activateOnChangeId`'s
    // panel (Chat), the original fix-round #5 behaviour, unchanged for a
    // thread with no remembered selection yet (e.g. never visited before) —
    // see `restoreActivePanelForKey`'s own doc comment for why that
    // precedence, not a flag, is what keeps #5's original guarantee true.
    //
    // Deliberately NOT part of the main mount effect below: that effect
    // intentionally does NOT re-run on a thread switch (see ChatDock.tsx's
    // own doc on why the dock must not remount when the route's thread
    // changes) — this needs the opposite behaviour, firing on EVERY thread
    // switch while touching nothing else about the live dockview instance.
    useEffect(() => {
      activationKeyRef.current = activationKey;
      const api = apiRef.current;
      if (!api || activationKey === undefined) return;
      const rememberedPanelId = selectActivePanelForKey(
        useDockActiveSelectionStore.getState().byActivationKey,
        String(activationKey),
      );
      restoreActivePanelForKey(api, {
        rememberedPanelId,
        ...(activateOnChangeId !== undefined ? { fallbackPanelId: activateOnChangeId } : {}),
      });
      // Deliberately `activateOnChangeId`-less deps — it's a caller-supplied
      // constant (ChatDock.tsx passes the same panel id every render); only
      // `activationKey`'s IDENTITY is meant to retrigger this.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activationKey]);

    // `useState`'s lazy initializer, not `useMemo(..., [])` — React documents
    // `useMemo` as a discardable performance cache it may recompute, while
    // `useState`'s initializer is guaranteed to run exactly once per mount.
    // Correctness depends on that here: every panel's `init()` closes over
    // THIS store instance (edit below), so a recomputed store would silently
    // orphan every already-registered panel.
    const [portalStore] = useState(() => createPanelPortalStore());
    // No `getServerSnapshot` third argument — this route renders client-side
    // only, so there is no hydration path that would need one.
    //
    // This subscription MUST be declared above the mount effect below: effect
    // cleanups run in declaration order, so this guarantees
    // `useSyncExternalStore`'s internal unsubscribe runs BEFORE `api.dispose()`
    // fires every panel's `dispose()`/`unregister()`.
    const panelEntries = useSyncExternalStore(portalStore.subscribe, portalStore.getSnapshot);

    // `buildPresetSafely` never throws — an unregistered `presetId` falls back
    // to `fallbackPreset` rather than crashing the workspace, the same "never
    // crash on a bad layout" principle applies to a corrupted persisted
    // layout. Returns whether the fallback was used so callers can name it in
    // the notice.
    const applyPreset = useCallback(
      (api: DockviewApi): boolean => {
        const { tree, usedFallback } = buildPresetSafely(presetRegistry, presetId, fallbackPreset);
        api.fromJSON(tree);
        return usedFallback;
      },
      [presetRegistry, presetId, fallbackPreset],
    );

    const presetFallbackNotice =
      "This workspace's own default preset isn't registered yet — opened the fallback layout instead.";

    // Fix-round finding #2: the ONE place a `SaveLayoutResult` is turned into
    // UI. Both callers of `storage.save()` below (`persist`'s own debounced/
    // explicit saves, and `handleImportFile`'s direct save after a successful
    // import) route through this so the once-per-session gating can't drift
    // between two independently-written notice strings.
    const reportSaveResult = useCallback((result: Awaited<ReturnType<LayoutStorage["save"]>>) => {
      if (!isMountedRef.current) return;
      if (result.status === "ok") {
        saveFailureNoticeShownRef.current = false;
        return;
      }
      if (saveFailureNoticeShownRef.current) return;
      saveFailureNoticeShownRef.current = true;
      setNotice(
        `This workspace's layout couldn't be saved (${result.message}). Your current arrangement is still visible, but won't survive a reload until storage is available again.`,
      );
    }, []);

    const persist = useCallback(
      (api: DockviewApi) => {
        const dockviewJson = api.toJSON();
        // Fix round, finding #1 ("app bricks in 3 clicks"): a dock with zero
        // panels is never a valid state to persist. This is the LAST-RESORT
        // guard — `scheduleSave` below already recovers the live view before
        // its debounce fires, so in the normal flow this branch never
        // actually triggers — but `persist` also gets called directly from
        // the mount effect's unmount-flush (a workspace switch mid-debounce),
        // which bypasses that recovery entirely. Skipping the save here
        // rather than trying to recover `api` is deliberate: a component
        // about to be torn down (`api.dispose()` runs right after this
        // cleanup) has nothing useful left to apply a fresh preset TO.
        if (isEmptyDockviewTree(dockviewJson)) return;
        // `knownPanelIds` stamped on EVERY save (not just after a migration)
        // — fix round after 7606dff45: this is what lets a FUTURE newly
        // registered panel be told apart from one the user closes on
        // purpose, the whole distinction `migrateLoadedLayout` depends on.
        // Every save from here on refreshes the baseline to the CURRENT
        // catalog, so it can never drift stale the way a one-time stamp
        // would.
        const file = buildLayoutFile({
          preset: presetId,
          dockviewJson,
          knownPanelIds: panelRegistry.ids(),
        });
        void storage.save(workspaceId, file).then(reportSaveResult);
      },
      [storage, workspaceId, presetId, panelRegistry, reportSaveResult],
    );

    useEffect(() => {
      const container = containerRef.current;
      if (!container) return undefined;

      // StrictMode double-invokes this effect (mount -> cleanup -> mount
      // again) against the SAME `isMountedRef` instance in dev — the
      // cleanup below sets it `false`, so it must be reset here on every
      // effect run, not just rely on `useRef(true)`'s one-time initial
      // value, or the second StrictMode mount would start out permanently
      // "unmounted" from its own guards' point of view.
      isMountedRef.current = true;

      const api = createDockview(container, {
        theme: WORKBENCH_THEME,
        tabGroupAccent: "off",
        noPanelsOverlay: "watermark",
        createComponent: (options) =>
          createReactContentRenderer(options.id, options.name, portalStore),
        // Every panel gets a close (×) control UNLESS its preset entry
        // explicitly opts out via `tabComponent: TAB_COMPONENT_NO_CLOSE` — see
        // ChatDock.tsx for why step 1's two panels both opt out.
        defaultTabComponent: TAB_COMPONENT_WITH_CLOSE,
        createTabComponent: (options) =>
          createReactTabRenderer(options.name !== TAB_COMPONENT_NO_CLOSE),
        getTabContextMenuItems: ({ panel, group }) =>
          buildTabContextMenuItems({ panel, group, api, registry: panelRegistry }),
      });
      apiRef.current = api;

      // Fix round, finding #6: a maximized group hides the sidebar, every
      // other tab, and any navigation — indistinguishable, at a glance,
      // from the finding-#1 brick. The only documented way out was
      // right-click -> Restore; Escape (the conventional exit for a
      // full-screen-ish overlay in literally every other context) did
      // nothing. `hasMaximizedGroup`/`exitMaximizedGroup` are top-level
      // `DockviewApi` methods, not per-group — one listener covers whichever
      // group is currently maximized, no group reference needed.
      const handleEscape = (event: KeyboardEvent) => {
        if (event.key === "Escape" && api.hasMaximizedGroup()) {
          api.exitMaximizedGroup();
        }
      };
      window.addEventListener("keydown", handleEscape);

      // `LayoutStorage.load` is async — a server-backed adapter's `load()`
      // reads across the network, so `cancelled` guards every side effect
      // below it against a workspace switch or unmount that lands while the
      // load is still in flight. Without it, a slow load resolving after
      // cleanup would apply a stale workspace's layout onto a `DockviewApi`
      // this effect has already disposed.
      let cancelled = false;

      // Set up ONLY after the initial load settles (below) — dockview firing
      // change events while we're still applying the loaded/default tree
      // would otherwise trigger a phantom auto-save of the very thing we
      // just loaded.
      let layoutChangeSub: ReturnType<DockviewApi["onDidLayoutChange"]> | undefined;
      let mutateLayoutSub: ReturnType<DockviewApi["onDidMutateLayout"]> | undefined;
      // Task #108: the WRITE half of per-thread selection memory — set up in
      // the same place and for the same "don't capture phantom events while
      // the loaded/default tree is still being applied" reason as the two
      // subscriptions above.
      let activePanelChangeSub: ReturnType<DockviewApi["onDidActivePanelChange"]> | undefined;
      // Task #109: drives both the visible Restore button and the
      // hidden-from-assistive-tech attributes on every non-maximized group.
      let maximizedGroupSub: ReturnType<DockviewApi["onDidMaximizedGroupChange"]> | undefined;
      let persistTimer: ReturnType<typeof setTimeout> | undefined;
      // Tracks whether a debounced save is currently outstanding — separate
      // from `persistTimer` itself, which still holds the last timer id even
      // after it has already fired (so `!== undefined` alone can't tell
      // "pending" from "already ran").
      let persistPending = false;

      // The guard every AUTOMATIC persist goes through — never bypasses an
      // explicit user action, since `handleReset`/`handleImportFile` call
      // `persist`/`storage.save` directly, not through this function.
      //
      // The second guard exists because RECOVERING from a failed import is a
      // layout change like any other, so it schedules a save — which would
      // write the fallback preset over the workspace's own saved layout, while
      // the notice on screen says in as many words "this workspace's saved
      // layout is unchanged". Recovery must not adopt what it recovered onto.
      // One-shot, not a standing block: the user's NEXT real change is theirs
      // and must still persist.
      const maybePersist = () => {
        if (autoSaveBlockedRef.current) return;
        if (suppressRecoveryPersistRef.current) {
          suppressRecoveryPersistRef.current = false;
          return;
        }
        void persist(api);
      };

      const scheduleSave = () => {
        for (const group of api.groups) syncFloatingConstraints(group, panelRegistry);
        persistPending = true;
        clearTimeout(persistTimer);
        persistTimer = setTimeout(() => {
          persistPending = false;
          // Fix round, finding #1 ("app bricks in 3 clicks"): close every
          // tab (Files, then Chat, then Sidebar) and the LIVE view goes
          // blank right now, in this tab, with nothing left to right-click
          // — no reload needed to reach it. Checked here rather than
          // synchronously inside the `onDidLayoutChange`/`onDidMutateLayout`
          // handlers themselves: this callback only runs after the debounce
          // delay, well outside dockview-core's own call stack for whatever
          // action (a close, in practice) just emptied the tree — the same
          // "let the current call stack finish" reasoning
          // reactTabRenderer.tsx's `dispose()` already uses for its
          // microtask-deferred unmount, at a coarser (but here, harmless)
          // grain.
          if (isEmptyDockviewTree(api.toJSON())) {
            const usedFallback = applyPreset(api);
            // `applyPreset`'s `api.fromJSON(...)` immediately re-fires this
            // same `onDidLayoutChange`/`onDidMutateLayout` pair with the now
            // non-empty tree, which schedules its OWN normal (non-empty)
            // save below — deliberately NOT suppressed via
            // `suppressRecoveryPersistRef`, unlike the import-refusal path:
            // there is no existing saved arrangement worth protecting from
            // this overwrite, the whole point is that storage must NOT keep
            // holding the empty tree either, or a reload lands right back
            // on the brick.
            setNotice(
              "Closing the last tab would have left this workspace with nothing open, so the default layout was reopened." +
                (usedFallback ? ` ${presetFallbackNotice}` : ""),
            );
            return;
          }
          maybePersist();
        }, PERSIST_DEBOUNCE_MS);
      };

      async function loadInitialLayout() {
        // `createLocalStorageLayoutStorage` guards its own localStorage
        // access, but `storage` is an injectable prop and a network-backed
        // adapter's `load()` could still reject. Belt-and-suspenders: any
        // throw/rejection from `load()` itself is treated exactly like
        // `{status: "empty"}`, never a crashed mount.
        let loaded: LoadLayoutResult;
        try {
          loaded = await storage.load(workspaceId);
        } catch {
          loaded = { status: "empty" };
        }
        if (cancelled) return;

        // Reset on every mount from the CURRENT load result — blocked only
        // for a version-mismatch refusal, never left stale from a previous
        // workspace/mount.
        autoSaveBlockedRef.current =
          loaded.status === "invalid" && loaded.reason === "version-mismatch";
        if (loaded.status === "ok") {
          try {
            // Fix round after 7606dff45: a saved layout predating a newly
            // registered panel used to just render as-is, missing that
            // panel entirely — `CHAT_DOCK_WORKSPACE_ID` bumps were how
            // ChatDock.tsx worked around that, which doesn't migrate
            // anything, it points `storage.load` at a brand-new empty key
            // and silently discards the whole saved arrangement. This is
            // the real fix: reconcile the loaded tree against the CURRENT
            // registry before applying it, grafting in anything newly
            // registered at its default-preset position while leaving
            // everything the user already had untouched. See
            // `lib/layoutMigration.ts`'s own module doc for the full
            // reasoning, including why "closed on purpose" is NOT
            // re-migrated back in.
            const { tree: defaultTree } = buildPresetSafely(
              presetRegistry,
              presetId,
              fallbackPreset,
            );
            const migration = migrateLoadedLayout({
              loaded: loaded.file.dockview,
              knownPanelIds: loaded.file.knownPanelIds,
              panelRegistry,
              defaultTree,
            });

            // Fix round, finding #1: belt-and-suspenders — `persist()`
            // already refuses to WRITE an empty tree (see its own comment),
            // so a file saved by a build with that guard should never
            // reach here empty. But a file written before this fix
            // existed, or restored from an export/import that skipped
            // `persist()` — reachable via `handleImportFile`, guarded
            // separately there — genuinely could still be empty. "Never a
            // valid state to persist OR restore," restored halves this
            // sentence.
            //
            // Deliberately an if/else, NOT an early `return` — this whole
            // `if (loaded.status === "ok")` block sits above the
            // `syncFloatingConstraints` loop and the
            // `onDidLayoutChange`/`onDidMutateLayout` subscription setup
            // further down this same function; a `return` here would exit
            // `loadInitialLayout` before that subscription ever gets wired,
            // silently turning off auto-save for the rest of this mount.
            if (isEmptyDockviewTree(migration.tree)) {
              const usedFallback = applyPreset(api);
              setNotice(
                `This workspace's saved layout was empty. Opened the default layout instead.` +
                  (usedFallback ? ` ${presetFallbackNotice}` : ""),
              );
            } else {
              api.fromJSON(migration.tree);

              const unknown = findUnknownPanelIds(migration.tree, panelRegistry.knownIds());
              const notices: string[] = [];
              if (unknown.length > 0) {
                notices.push(
                  `This workspace's saved layout references a panel type no longer in the catalog (${unknown.join(", ")}). Shown as a quarantine card — close it or reset to remove it.`,
                );
              }
              if (migration.unplaceablePanelIds.length > 0) {
                // The one path where migration itself can't silently
                // succeed — "say so rather than resetting" applies here
                // exactly as much as it does to a corrupted file: the new
                // panel(s) just won't be visible from THIS workspace's
                // saved arrangement until a reset, and that's worth naming
                // rather than leaving the user to wonder why a panel
                // they've heard about isn't there.
                notices.push(
                  `This workspace's saved layout couldn't be updated to include: ${migration.unplaceablePanelIds.join(", ")}. Reopen from the tab menu, or reset to get the current default layout.`,
                );
              }
              setNotice(notices.length > 0 ? notices.join(" ") : null);

              if (migration.addedPanelIds.length > 0) {
                // A successful migration IS a layout change — persist it
                // now rather than leaving the on-disk file stale until the
                // next incidental drag. Also refreshes `knownPanelIds` to
                // include the panel(s) just added, so a LATER third
                // panel's migration check has an accurate baseline rather
                // than re-deriving one from a now-outdated snapshot.
                persist(api);
              }
            }
          } catch {
            // Passed shape validation but dockview still rejected it (e.g. a
            // panel referenced by the grid isn't in `panels`) — never crash on
            // a bad layout, fall back the same as an invalid file.
            const usedFallback = applyPreset(api);
            setNotice(
              `This workspace's saved layout couldn't be applied. Opened the default layout instead.` +
                (usedFallback ? ` ${presetFallbackNotice}` : ""),
            );
          }
        } else if (loaded.status === "invalid") {
          const usedFallback = applyPreset(api);
          setNotice(
            (loaded.reason === "version-mismatch"
              ? `This workspace's saved layout was written by a different version of this app. Opened the default layout instead.`
              : `This workspace's saved layout is unreadable. Opened the default layout instead.`) +
              (usedFallback ? ` ${presetFallbackNotice}` : ""),
          );
        } else {
          const usedFallback = applyPreset(api);
          setNotice(usedFallback ? presetFallbackNotice : null);
        }

        for (const group of api.groups) syncFloatingConstraints(group, panelRegistry);

        // Two subscriptions, not one: `onDidLayoutChange` is buffered onto a
        // microtask and covers general layout changes (resize, move, add,
        // remove), but does NOT fire for `maximizeGroup`/`exitMaximizedGroup`.
        // `onDidMutateLayout` fires synchronously and DOES cover maximize (its
        // `kind` union includes `'maximize'`), so without this second
        // subscription a maximized/restored layout would never be captured by
        // auto-save at all — only incidentally, if some other change happened
        // to follow it.
        layoutChangeSub = api.onDidLayoutChange(scheduleSave);
        mutateLayoutSub = api.onDidMutateLayout(scheduleSave);
        // Task #108: records which panel is active RIGHT NOW under the
        // CURRENT thread's key — fires for every activation, whatever
        // triggered it (a genuine tab click, the initial load applying a
        // saved/default tree, or this same file's own restore call above),
        // which is exactly right: the store's only job is to reflect
        // "whatever is showing now, for whichever thread is now active,"
        // not to distinguish user-driven from programmatic. Reads
        // `activationKeyRef` (NOT the `activationKey` closure captured when
        // this effect first ran) because this subscription is never
        // recreated on a thread switch — see the activationKey-change effect
        // above, the one place that ref is kept current.
        activePanelChangeSub = api.onDidActivePanelChange(({ panel }) => {
          if (activationKeyRef.current === undefined) return;
          useDockActiveSelectionStore
            .getState()
            .setActivePanel(String(activationKeyRef.current), panel?.id ?? null);
        });
        // Task #109: both the visible "Restore" button's state AND the
        // hidden-from-assistive-tech attributes on every OTHER group are
        // driven off this one subscription — one source of truth for
        // "what's currently maximized," so the button and the a11y
        // attributes can never disagree about it.
        maximizedGroupSub = api.onDidMaximizedGroupChange(({ group, isMaximized }) => {
          const nextMaximizedGroupId = isMaximized ? group.id : null;
          setMaximizedGroupId(nextMaximizedGroupId);
          applyMaximizedGroupAccessibility(api.groups, nextMaximizedGroupId);
        });
        // A saved layout CAN load already maximized (`gridview.js`'s
        // `serialize()` includes `maximizedNode`) — `api.fromJSON()` above
        // fires `onDidMaximizedGroupChange` internally when it does, but
        // this subscription wasn't listening yet (deliberately — see this
        // block's own opening comment on why subscriptions start only after
        // load settles). Without this, a workspace that was left maximized
        // would reopen maximized with no visible Restore button and no a11y
        // attributes applied until the NEXT maximize-state change.
        const initiallyMaximized = api.groups.find((group) => group.api.isMaximized());
        setMaximizedGroupId(initiallyMaximized?.id ?? null);
        applyMaximizedGroupAccessibility(api.groups, initiallyMaximized?.id ?? null);
      }

      void loadInitialLayout();

      return () => {
        cancelled = true;
        // Set BEFORE the flush below, not after: `maybePersist()` ->
        // `persist()` attaches `.then(reportSaveResult)`, and
        // `reportSaveResult` checks this flag — so a save that resolves
        // after this cleanup runs correctly skips `setNotice` on an
        // unmounted component instead of firing it moments too late.
        isMountedRef.current = false;
        clearTimeout(persistTimer);
        if (persistPending) {
          // A workspace switch unmounts this component, so clearing the
          // debounce here would silently discard a change made just before
          // switching — exactly what "saved per workspace" is supposed to
          // prevent. Flush synchronously instead of dropping it. Still routed
          // through the auto-save guard: a version-mismatch refusal must
          // survive a switch-away just as much as a splitter nudge.
          // `storage.save` is fire-and-forget here (a real network request
          // can't be awaited from a synchronous cleanup) — it keeps running
          // after unmount; `reportSaveResult`'s `isMountedRef` check (just
          // set above) is what keeps its eventual result from acting on
          // anything, not the absence of an observer.
          maybePersist();
        }
        window.removeEventListener("keydown", handleEscape);
        layoutChangeSub?.dispose();
        mutateLayoutSub?.dispose();
        activePanelChangeSub?.dispose();
        maximizedGroupSub?.dispose();
        api.dispose();
        apiRef.current = null;
      };
      // Deliberately workspaceId/presetId-only deps — see the stability
      // contract on `DockviewLayoutProps` above for the full reasoning.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [workspaceId, presetId]);

    const handleReset = useCallback(() => {
      const api = apiRef.current;
      if (!api) return;
      const usedFallback = applyPreset(api);
      // An explicit reset is the deliberate "replace it" action a
      // version-mismatch refusal is waiting for — persist it, and lift the
      // block so this workspace's normal auto-save resumes from here on.
      autoSaveBlockedRef.current = false;
      persist(api);
      setNotice(usedFallback ? presetFallbackNotice : null);
    }, [applyPreset, persist, presetFallbackNotice]);

    const handleExport = useCallback(() => {
      const api = apiRef.current;
      if (!api) return;
      const file = buildLayoutFile({ preset: presetId, dockviewJson: api.toJSON() });
      const blob = new Blob([JSON.stringify(file, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = buildLayoutFilename(workspaceName);
      anchor.click();
      URL.revokeObjectURL(url);
    }, [presetId, workspaceName]);

    const handleImportFile = useCallback(
      (file: File) => {
        const api = apiRef.current;
        if (!api) return;
        void file.text().then((raw) => {
          // Fix-round finding #3: `api` was captured synchronously above,
          // but this continuation only resumes after the (async) file read
          // completes — if the component unmounted in between,
          // `loadInitialLayout`'s own mount effect has already disposed
          // `api`. `decideImportedLayoutAction` (lib/importDecision.ts) is
          // the same "don't touch a disposed DockviewApi" guard
          // `loadInitialLayout` gets from its `cancelled` flag, applied
          // here via `isMountedRef`. See that file's tests for the red/green
          // proof.
          const decision = decideImportedLayoutAction({
            isMounted: isMountedRef.current,
            parseResult: parseLayoutFile(raw),
          });

          if (decision.action === "ignore-unmounted") return;

          if (decision.action === "invalid") {
            setNotice(`Couldn't import ${file.name}: ${decision.message}`);
            return;
          }

          // decision.action === "apply" — a well-formed-JSON-but-dockview-invalid
          // file (e.g. a view id with no `panels` entry) throws AND clears the
          // current grid to zero groups first. Left bare, that's an unhandled
          // rejection, a torn-down dock with no notice, and — since
          // `storage.save` below never ran — a reload that silently restores
          // the old layout as if nothing happened.
          try {
            api.fromJSON(decision.file.dockview);
          } catch {
            // Order matters: arm the guard BEFORE touching the dock, because
            // applyPreset synchronously fires onDidMutateLayout, which schedules
            // the very save this suppresses. Without it the notice below is a
            // lie — the fallback preset lands on disk over the user's own saved
            // layout about 250ms later.
            suppressRecoveryPersistRef.current = true;
            applyPreset(api);
            setNotice(
              `Couldn't import ${file.name}: the file was valid JSON but dockview rejected its layout. Opened the default layout instead — this workspace's saved layout is unchanged.`,
            );
            return;
          }
          // Same reasoning as reset() — importing a file is an explicit
          // replacement, so it persists and lifts any standing block. The
          // CURRENT registry (not whatever `knownPanelIds` the imported file
          // itself carried, if any — it may have come from a different fork
          // build with a different catalog entirely) becomes the new
          // baseline: only a panel registered AFTER this import is eligible
          // for a future migration, the same "explicit replacement" contract
          // `persist()`/`handleReset()` already give a splitter drag or a
          // reset.
          autoSaveBlockedRef.current = false;
          void storage
            .save(workspaceId, { ...decision.file, knownPanelIds: panelRegistry.ids() })
            .then(reportSaveResult);
          const unknown = findUnknownPanelIds(decision.file.dockview, panelRegistry.knownIds());
          setNotice(
            unknown.length > 0
              ? `Imported ${file.name}. ${unknown.length} panel type(s) aren't in the current catalog and show as quarantine cards.`
              : null,
          );
        });
      },
      [storage, workspaceId, panelRegistry, applyPreset, reportSaveResult],
    );

    const handleOpenPanel = useCallback(
      (id: string) => {
        const api = apiRef.current;
        // "No live DockviewApi yet" is a timing issue (this ref action fired
        // before the mount effect's dockview instance exists) — silent,
        // same as every other guard in this file that checks apiRef.current
        // first. The actual get-or-add-then-setActive decision is
        // lib/openPanel.ts's `openPanelInDock` — see that file's own doc for
        // why it's extracted rather than inlined here.
        if (!api) return;
        openPanelInDock(id, { api, panelRegistry });
      },
      [panelRegistry],
    );

    const handleTogglePanel = useCallback(
      (id: string) => {
        const api = apiRef.current;
        // Same "no live DockviewApi yet" timing guard as handleOpenPanel
        // above. The actual open-vs-close decision is lib/openPanel.ts's
        // `togglePanelInDock` — see that file's own doc for why it's
        // extracted the same way.
        if (!api) return;
        togglePanelInDock(id, { api, panelRegistry });
      },
      [panelRegistry],
    );

    // Task #109: the visible counterpart to the context-menu "Restore" item
    // and Escape (fix-round finding #6) — see `maximizedGroupId`'s own
    // comment for why neither of those is discoverable on its own.
    const handleRestoreMaximized = useCallback(() => {
      apiRef.current?.exitMaximizedGroup();
    }, []);

    useImperativeHandle(
      forwardedRef,
      () => ({
        reset: handleReset,
        exportLayout: handleExport,
        importLayoutFile: handleImportFile,
        openPanel: handleOpenPanel,
        togglePanel: handleTogglePanel,
      }),
      [handleReset, handleExport, handleImportFile, handleOpenPanel, handleTogglePanel],
    );

    // Fix-round finding #1: recomputed every render — cheap (a linear scan
    // over however many panels are actually open, typically single digits)
    // and correctness-critical to recompute fresh rather than memoize
    // against `panelEntries` identity alone, since `panelRegistry` could in
    // principle change too (it's a required prop, not literally guaranteed
    // immutable by the type system even though `ChatDock.tsx` never rebuilds
    // it — see the stability contract on `DockviewLayoutProps`).
    const duplicateSingletonPanelIds = computeDuplicateSingletonPanelIds(
      panelEntries,
      panelRegistry,
    );

    return (
      <div className={cn("relative flex h-full min-h-0 flex-col", className)}>
        {notice ? <LayoutNotice message={notice} onDismiss={() => setNotice(null)} /> : null}
        {/*
          Fix round, finding #1 ("app bricks in 3 clicks"): the reachable
          recovery affordance for `DockviewLayoutHandle.reset()` — implemented
          since step 1, never attached to anything a person could actually
          click. A SIBLING of `containerRef`'s div, not a child, and
          absolutely positioned over it: it must render (and stay clickable)
          regardless of whatever dockview itself is currently showing in
          there, blank or not — the whole point is this can't itself become
          part of the brick. The empty-layout guards above make reaching a
          genuinely blank dock unlikely now, but this is deliberately
          unconditional, not shown only when things look broken: a
          defense-in-depth escape hatch for any OTHER way this workspace's
          layout could end up stuck that this fix round didn't anticipate.
        */}
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Reset workspace layout"
          title="Reset workspace layout"
          onClick={handleReset}
          className="absolute top-1.5 right-1.5 z-10 text-muted-foreground hover:text-foreground"
        >
          <RotateCcw size={14} strokeWidth={2} />
        </Button>
        {/*
          Task #109: dockview's own maximize (right-click a tab -> Maximize)
          had NO visible way back — only the same right-click menu's
          "Restore" item, or Escape (fix-round finding #6, added for the
          identical "no way out" complaint but equally undiscoverable
          without already knowing it exists). A SIBLING of `containerRef`'s
          div, same positioning approach as the Reset button above, opposite
          corner so the two can never overlap when both are visible at once.
        */}
        {maximizedGroupId !== null ? (
          <Button
            type="button"
            variant="outline"
            size="xs"
            aria-label="Restore maximized panel"
            title="Restore maximized panel"
            onClick={handleRestoreMaximized}
            className="absolute top-1.5 left-1.5 z-10"
          >
            <Minimize2 size={14} strokeWidth={2} />
            Restore
          </Button>
        ) : null}
        <div ref={containerRef} className="min-h-0 flex-1" />
        {panelEntries.map((entry) =>
          createPortal(
            <PanelPortalContent
              entry={entry}
              registry={panelRegistry}
              isDuplicateSingleton={duplicateSingletonPanelIds.has(entry.panelId)}
            />,
            entry.element,
            entry.panelId,
          ),
        )}
      </div>
    );
  },
);
