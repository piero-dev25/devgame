import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import {
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";

import { isCommandPaletteOpen } from "../commandPaletteBus";
import { isElectron } from "../env";
import {
  getChatDockSidebarVisible,
  subscribeChatDockSidebarVisible,
  toggleChatDockSidebarVisibility,
} from "../dock/chatDockHandle";
import { useDesktopFullscreenState } from "../hooks/useDesktopFullscreenState";
import { useClientSettings, useLegacySidebarEnabled } from "../hooks/useSettings";
import { openCommandPalette } from "../commandPaletteBus";
import { useProjects } from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import { selectProjectGroupingSettings } from "../logicalProject";
import { buildSidebarProjectSnapshots } from "../sidebarProjectGrouping";
import { dispatchPreviewAction } from "../components/preview/previewActionBus";
import { SidebarChromeHeader } from "../components/sidebar/SidebarChrome";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { startNewThreadFromContext } from "../lib/chatThreadActions";
import { isMacPlatform } from "../lib/utils";
import { isPreviewFocused } from "../lib/previewFocus";
import { isTerminalFocused } from "../lib/terminalFocus";
import { resolveShortcutCommand } from "../keybindings";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { isPreviewSupportedInRuntime } from "../previewStateStore";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { SidebarProvider } from "~/components/ui/sidebar";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { resolveWorkspaceChromeInsetStyle } from "~/workspaceChromeInset";

function ChatRouteGlobalShortcuts() {
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  const selectedThreadKeysSize = useThreadSelectionStore((state) => state.selectedThreadKeys.size);
  const { activeDraftThread, activeThread, defaultProjectRef, handleNewThread, routeThreadRef } =
    useHandleNewThread();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const legacySidebarEnabled = useLegacySidebarEnabled();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const projects = useProjects();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projectGroupCount = useMemo(
    () =>
      buildSidebarProjectSnapshots({
        projects,
        settings: projectGroupingSettings,
        primaryEnvironmentId,
        resolveEnvironmentLabel: () => null,
      }).length,
    [primaryEnvironmentId, projectGroupingSettings, projects],
  );
  const terminalOpen = useTerminalUiStateStore((state) =>
    routeThreadRef
      ? selectThreadTerminalUiState(state.terminalUiStateByThreadKey, routeThreadRef).terminalOpen
      : false,
  );
  // Task #53: used to read `rightPanelStore` ("preview" was one of its
  // surface kinds); now that Browser is its own dock panel, open/closed
  // lives inside dockview's own layout state, not synchronously reachable
  // here. Hard-coded `false`, not reconstructed — grep-verified against
  // packages/contracts and apps/web/src that no keybinding "when" clause
  // anywhere in this repo actually references `previewOpen` (only
  // `previewFocus` is), so this was already dead context data before this
  // migration. See CommandPalette.tsx's matching fix for the same finding.
  const previewOpen = false;
  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen,
          previewFocus: isPreviewFocused(),
          previewOpen,
        },
      });

      if (isCommandPaletteOpen()) {
        return;
      }

      if (event.key === "Escape" && selectedThreadKeysSize > 0) {
        event.preventDefault();
        clearSelection();
        return;
      }

      if (command === "chat.newLocal") {
        event.preventDefault();
        event.stopPropagation();
        void startNewThreadFromContext({
          activeDraftThread,
          activeThread: activeThread ?? undefined,
          defaultProjectRef,
          handleNewThread,
        });
        return;
      }

      if (command === "chat.new") {
        event.preventDefault();
        event.stopPropagation();
        // The default sidebar routes creation through the command palette
        // whenever there is a real choice to make; the legacy sidebar (and
        // single-project setups) keep the immediate contextual create.
        if (!legacySidebarEnabled && projectGroupCount > 1) {
          openCommandPalette({ open: "new-thread-in" });
          return;
        }
        void startNewThreadFromContext({
          activeDraftThread,
          activeThread: activeThread ?? undefined,
          defaultProjectRef,
          handleNewThread,
        });
        return;
      }

      if (command === "preview.toggle") {
        event.preventDefault();
        event.stopPropagation();
        if (!routeThreadRef) return;
        if (!isPreviewSupportedInRuntime()) {
          toastManager.add(
            stackedThreadToast({
              type: "info",
              title: "Preview is desktop-only",
              description: "Open DevGame in the desktop app to use the in-app preview.",
            }),
          );
          return;
        }
        dispatchPreviewAction("toggle-panel");
        return;
      }

      // The remaining preview commands only fire when the panel is the
      // currently-focused tenant. The `when: previewFocus` rule already
      // gates this, but defend against the keybinding being misconfigured.
      if (
        command === "preview.refresh" ||
        command === "preview.focusUrl" ||
        command === "preview.zoomIn" ||
        command === "preview.zoomOut" ||
        command === "preview.resetZoom"
      ) {
        event.preventDefault();
        event.stopPropagation();
        const action =
          command === "preview.refresh"
            ? "refresh"
            : command === "preview.focusUrl"
              ? "focus-url"
              : command === "preview.zoomIn"
                ? "zoom-in"
                : command === "preview.zoomOut"
                  ? "zoom-out"
                  : "reset-zoom";
        dispatchPreviewAction(action);
      }
    };

    window.addEventListener("keydown", onWindowKeyDown);
    return () => {
      window.removeEventListener("keydown", onWindowKeyDown);
    };
  }, [
    activeDraftThread,
    activeThread,
    clearSelection,
    handleNewThread,
    keybindings,
    defaultProjectRef,
    previewOpen,
    projectGroupCount,
    routeThreadRef,
    selectedThreadKeysSize,
    legacySidebarEnabled,
    terminalOpen,
  ]);

  // dock-chrome-strip.md, Section C: `sidebar.toggle` (Mod+B,
  // keybindings.ts:22) was previously handled only inside
  // `AppSidebarLayout.tsx`'s `SidebarControl`, so it was already dead on
  // thread routes (no `SidebarControl` renders there). This gives it a
  // real target here — the SAME dock-side toggle the strip's own button
  // calls (`toggleChatDockSidebarVisibility`, chatDockHandle.ts) — NOT
  // `useSidebar().toggleSidebar()`: critique m13 forbids touching
  // `SidebarProvider`'s own open state from this toggle (its
  // `COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS` consumers key off it; wiring
  // both would half-wire two different sidebar concepts into one control).
  // A SEPARATE effect/listener from the one above, in the CAPTURE phase —
  // mirroring `AppSidebarLayout.tsx`'s `SidebarControl` keydown handler
  // exactly — so Mod+B reaches this before a focused composer/editor
  // consumes it for rich-text formatting; the bubble-phase listener above
  // does not have that guarantee and is not touched here.
  useEffect(() => {
    const onWindowKeyDownCapture = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("[data-keybinding-capture]")
      ) {
        return;
      }
      if (resolveShortcutCommand(event, keybindings) !== "sidebar.toggle") return;

      event.preventDefault();
      event.stopPropagation();
      toggleChatDockSidebarVisibility();
    };

    window.addEventListener("keydown", onWindowKeyDownCapture, true);
    return () => window.removeEventListener("keydown", onWindowKeyDownCapture, true);
  }, [keybindings]);

  return null;
}

/**
 * The corner cell's positioning/sizing SHELL, pulled out into its own
 * named, exported component for the same reason `DockviewLayout.tsx`'s
 * `DockControlsCluster` and `SidebarChrome.tsx`'s `SidebarChromeToggle`
 * were: `WorkspaceChromeStrip` below cannot render under this repo's
 * `renderToStaticMarkup`-only harness — verified empirically (not assumed
 * from the old comment this file's `dock-chrome-strip.md` doc used to
 * carry): its own `useSyncExternalStore` call throws without a
 * `getServerSnapshot` third argument, and even past that,
 * `SidebarChromeHeader` unconditionally renders `SidebarBrand`'s router
 * `<Link>`, which throws with no `RouterProvider` ancestor (the same
 * limitation `SidebarChromeHeader.test.tsx` already documents). This shell
 * carries no Link and no router-dependent hook — `useSyncExternalStore`
 * lives on `WorkspaceChromeStrip`, one level up — so
 * `WorkspaceChromeCornerShell.test.tsx` can still render it directly (with
 * a stand-in child) under `renderToStaticMarkup` (React skips `useEffect`
 * entirely there, so the measurement effect below never runs in that test —
 * harmless, not a crash) and prove the structure survived the strip ->
 * corner change, including that the OLD full-width strip's own
 * accommodations (`wco:pr-[...]`) are genuinely gone, not just visually
 * invisible. See `WorkspaceChromeStrip`'s own doc comment below for the
 * full design reasoning behind what this shell measures.
 *
 * docs/specs/unified-topband.md, Section B, fix round 2 (owner mock,
 * "kills the guessed 220px"): CONTENT-DRIVEN width, not a fixed
 * `--workspace-corner-width` read. `w-fit` — the shell sizes to its own
 * children (toggle + gap + brand + the trailing `pr-5` gap baked into
 * `SidebarChromeHeader`'s own padding, so the MEASURED width already
 * includes the "clear trailing gap before the first tab" the owner asked
 * for, with no separate addition needed here). A `ResizeObserver` on the
 * shell's own element re-measures on every content change (environment
 * label toggling the pill, font load, etc.) and writes the result onto
 * `--workspace-corner-width` on the nearest `[data-slot="sidebar-wrapper"]`
 * ancestor — `SidebarProvider`'s own DOM node, the SAME element
 * `resolveWorkspaceChromeInsetStyle`'s `chromeInsetStyle` is already
 * applied to (`ChatRouteLayout` below), found via `closest()` rather than a
 * new `forwardRef` plumbed through `SidebarProvider` — smaller change,
 * stays entirely inside this file. `DockviewLayout.tsx`'s
 * `applyTopBandLayout` needs no change: it already re-reads
 * `--workspace-corner-width` live via `getComputedStyle` on every
 * apply, and CSS custom properties cascade from `SidebarProvider` down to
 * its `container` descendant same as any other inherited value.
 *
 * NO FEEDBACK LOOP (asserted, not just claimed): the shell's OWN width is
 * `w-fit` — content-sized, independent of `--workspace-corner-width`, which
 * this effect only ever WRITES, never reads for layout. Its children
 * (`SidebarChromeToggle`: fixed `size-[--workspace-titlebar-control-size]`;
 * `SidebarBrand`: `w-fit`, sized by its own text) are equally independent
 * of that variable. Downstream, `applyTopBandLayout` consumes the written
 * value only to set `padding-left` on the corner-OWNER GROUP's tab strip
 * (a sibling subtree entirely outside this shell) — that padding changes
 * the tab strip's CONTENT area, not `group.element`'s own outer
 * `boundingBox` (dockview's splitview owns that size), so it does not
 * retrigger DockviewLayout.tsx's own per-group `ResizeObserver` either.
 * Every step in the chain terminates without looping back to a
 * `--workspace-corner-width` write.
 */
export function WorkspaceChromeCornerShell({ children }: { children: ReactNode }) {
  const shellRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const shellElement = shellRef.current;
    if (!shellElement) return undefined;
    const providerElement = shellElement.closest<HTMLElement>('[data-slot="sidebar-wrapper"]');
    if (!providerElement) return undefined;

    const applyMeasuredWidth = () => {
      const measuredWidth = shellElement.getBoundingClientRect().width;
      // `0` means not-yet-laid-out (or genuinely empty) — leave whatever
      // `--workspace-corner-width` currently holds (the 220px CSS fallback,
      // or a previous real measurement) rather than overwriting it with a
      // meaningless value.
      if (measuredWidth > 0) {
        providerElement.style.setProperty("--workspace-corner-width", `${measuredWidth}px`);
      }
    };

    applyMeasuredWidth();
    const resizeObserver = new ResizeObserver(applyMeasuredWidth);
    resizeObserver.observe(shellElement);
    return () => resizeObserver.disconnect();
  }, []);

  return (
    <div
      ref={shellRef}
      className="absolute top-0 left-0 z-20 w-fit"
      style={{ "--workspace-topbar-height": "36px" } as CSSProperties}
    >
      {children}
    </div>
  );
}

/**
 * docs/specs/unified-topband.md, Section B (rev 4 — SUPERSEDES the
 * full-width row this component originally rendered, shipped in
 * ffafc3728): the corner cell, not a strip. Owner iteration: ONE top band —
 * traffic lights + brand + the dock's own tab strips in the same row, with
 * the dock's tabs starting right where this cell ends rather than sitting
 * in a second row underneath it. Empty band space (inside the dock, to the
 * right of this cell) now drags the window via dockviewTheme.css's
 * band-scoped `app-region` rule + DockviewLayout.tsx's `data-dv-topband`
 * stamping — this cell no longer owns the window's ENTIRE draggable area
 * the way the old full-width strip did, only its own fixed-width slice
 * (still real: `SidebarChromeHeader`'s own `drag-region` class, unchanged).
 *
 * `absolute top-0 left-0` + a fixed `--workspace-corner-width` (index.css,
 * also read live by DockviewLayout.tsx's `applyTopBandLayout` so the dock's
 * own tab-strip clearance never drifts out of sync with this cell's actual
 * width) OVERLAYS the dock instead of pushing it down a row — see
 * `ChatRouteLayout` below for the provider-side half of this (the strip ROW
 * is dropped; the dock returns to full height).
 *
 * `--workspace-topbar-height` is overridden to 36px, a literal duplicate of
 * dockviewTheme.css's `--dv-tabs-and-actions-container-height` (NOT a
 * `var()` reference to it: dockview stamps that custom property on its OWN
 * root, a DOM subtree this cell sits OUTSIDE of as a sibling of `<Outlet/>`,
 * not a descendant — CSS custom properties cascade down the real DOM tree,
 * not across siblings, so referencing it here would resolve to nothing).
 * `SidebarChromeHeader`'s own `h-[var(--workspace-topbar-height)]` already
 * reads this override with no further change needed there — the GLOBAL
 * `--workspace-topbar-height` token (index.css, 52px) is untouched, since
 * ChatView's panel-internal topbar, RightPanelTabs, settings and more still
 * consume it (critique M3 — changing it globally was explicitly forbidden).
 *
 * `wco:pr-[...]` (the old right-edge padding clearing Windows/Linux's WCO
 * overlay buttons) is GONE, not carried over: that padding existed only
 * because the OLD strip spanned the window's full width and its own right
 * edge collided with those buttons. This cell is fixed-width at the LEFT
 * edge only and never reaches that far right in the new geometry.
 */
export function WorkspaceChromeStrip() {
  const sidebarVisible = useSyncExternalStore(
    subscribeChatDockSidebarVisible,
    getChatDockSidebarVisible,
  );

  return (
    <WorkspaceChromeCornerShell>
      <SidebarChromeHeader
        isElectron
        sidebarToggle={{ onToggle: toggleChatDockSidebarVisibility, pressed: sidebarVisible }}
      />
    </WorkspaceChromeCornerShell>
  );
}

/**
 * Step 2 (spec-dock-step-2.md, Part A): every thread route under this
 * pathless layout (`/`, `/draft/$draftId`, `/$environmentId/$threadId`) now
 * hosts T3's real sidebar as a dock panel (SidebarPanel.tsx) instead of
 * through `AppSidebarLayout`'s fixed `<Sidebar>` — see `__root.tsx`'s
 * `RootRouteView` for the settings-vs-thread-routes branch this replaces.
 * `SidebarProvider` is still required here: `SidebarV2`'s content calls
 * `useSidebar()` (for `{isMobile, setOpenMobile}`), which throws outside
 * one, and React context is not DOM-position-dependent — a panel rendered
 * through `createPortal` from deep inside dockview still resolves this
 * provider correctly as long as it's an ancestor in the REACT tree, which it
 * is here (confirms the spec's own claim rather than assuming it).
 *
 * Deliberately NOT `AppSidebarLayout` itself: that also renders a fixed,
 * viewport-locked `<Sidebar>` + `<SidebarRail>` (drag-to-resize) +
 * `<SidebarControl>` (a collapse/expand toggle) — all three exist to manage
 * a FIXED sidebar's open/collapsed state and pixel width, a concept dockview
 * now owns instead (the sidebar panel can be dragged, resized against its
 * neighbours, or floated, but per the design constraint it can never be
 * closed — see SidebarPanel.tsx). Rendering that machinery alongside a
 * docked copy of the same content would be actively wrong, not just
 * redundant. `className="h-dvh! min-h-0!"` matches the override
 * `AppSidebarLayout` already applies to its own `SidebarProvider`, for the
 * same reason: `SidebarProvider`'s default `min-h-svh` could let content
 * grow the wrapper taller than the viewport, which conflicts with the
 * dock's own `h-svh min-h-0 overflow-hidden` height chain (see
 * `_chat.$environmentId.$threadId.tsx`'s `SidebarInset`) — a definite,
 * non-growing height is what keeps dockview from collapsing to zero height,
 * per spec-dock-step-1.md's mount-point warning.
 *
 * docs/specs/unified-topband.md, Section B (SUPERSEDES the ffafc3728
 * strip-row wiring this comment used to describe): `SidebarProvider` keeps
 * `flex-col` (its base wrapper is a flex ROW, ui/sidebar.tsx) — no longer
 * because a strip needs to be a top row (the corner cell is
 * `position: absolute`, out of flow, indifferent to the container's flex
 * direction), but because `<Outlet/>` is still this provider's one
 * meaningful flex child and a stray flex-ROW would let it shrink to
 * content width instead of filling the viewport. NEW: `relative` — the
 * corner cell's `absolute top-0 left-0` needs a positioned ancestor to
 * anchor against, and `SidebarProvider`'s own base wrapper
 * (`group/sidebar-wrapper flex min-h-svh w-full`, ui/sidebar.tsx) declares
 * none. Also plus the mac inset style, computed the same way
 * `AppSidebarLayout` does (`resolveWorkspaceChromeInsetStyle`, shared, no
 * behavior drift between the two). The corner cell renders as the
 * provider's FIRST child so it paints above `<Outlet/>` (z-20, `WorkspaceChromeStrip`'s
 * own className) — it covers every `_chat` child route the exact same way
 * the old strip did (thread, index including its loading/empty states,
 * critique M6, and draft), gated on `isElectron` alone; only the 90px mac
 * inset additionally gates on `isMacosDesktop` (critique m11). Web/
 * non-Electron: corner absent, today's behavior exactly. The strip ROW
 * itself is gone — `<Outlet/>` (and therefore the dock inside it) no
 * longer shares vertical flex space with anything above it, returning the
 * dock to full height (acceptance check 1: dock bottom edge == viewport
 * bottom edge).
 */
function ChatRouteLayout() {
  const isMacosDesktop = isElectron && isMacPlatform(navigator.platform);
  const isWindowFullscreen = useDesktopFullscreenState(isMacosDesktop);
  const chromeInsetStyle = resolveWorkspaceChromeInsetStyle({
    isMacDesktop: isMacosDesktop,
    isFullscreen: isWindowFullscreen,
  });

  return (
    <SidebarProvider
      className="h-dvh! min-h-0! relative flex-col"
      defaultOpen
      style={chromeInsetStyle}
    >
      {isElectron ? <WorkspaceChromeStrip /> : null}
      <ChatRouteGlobalShortcuts />
      <Outlet />
    </SidebarProvider>
  );
}

export const Route = createFileRoute("/_chat")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: ChatRouteLayout,
});
