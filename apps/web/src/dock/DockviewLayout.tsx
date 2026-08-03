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

import { cn } from "~/lib/utils";

import {
  buildLayoutFile,
  buildLayoutFilename,
  buildPresetSafely,
  createLocalStorageLayoutStorage,
  findUnknownPanelIds,
  parseLayoutFile,
  syncFloatingConstraints,
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
      className,
    },
    forwardedRef,
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const apiRef = useRef<DockviewApi | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
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
        const file = buildLayoutFile({ preset: presetId, dockviewJson: api.toJSON() });
        void storage.save(workspaceId, file).then(reportSaveResult);
      },
      [storage, workspaceId, presetId, reportSaveResult],
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
            api.fromJSON(loaded.file.dockview);
            const unknown = findUnknownPanelIds(loaded.file.dockview, panelRegistry.knownIds());
            setNotice(
              unknown.length > 0
                ? `This workspace's saved layout references a panel type no longer in the catalog (${unknown.join(", ")}). Shown as a quarantine card — close it or reset to remove it.`
                : null,
            );
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
        layoutChangeSub?.dispose();
        mutateLayoutSub?.dispose();
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
          // replacement, so it persists and lifts any standing block.
          autoSaveBlockedRef.current = false;
          void storage.save(workspaceId, decision.file).then(reportSaveResult);
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

    useImperativeHandle(
      forwardedRef,
      () => ({
        reset: handleReset,
        exportLayout: handleExport,
        importLayoutFile: handleImportFile,
      }),
      [handleReset, handleExport, handleImportFile],
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
      <div className={cn("flex h-full min-h-0 flex-col", className)}>
        {notice ? <LayoutNotice message={notice} onDismiss={() => setNotice(null)} /> : null}
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
