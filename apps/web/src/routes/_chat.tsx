import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useMemo, useSyncExternalStore } from "react";

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
 * dock-chrome-strip.md, Section A: the hoisted chrome row — problem (1)/(2)
 * from the owner's report (traffic lights overlapping a dock tab; no
 * draggable top-strip area). Renders `SidebarChromeHeader` (brand, as
 * today) with the strip-specific ALWAYS-visible sidebar toggle wired to the
 * dock-side hide/show (Section C), instead of the header's default
 * mobile-only/`SidebarProvider`-toggling trigger.
 */
function WorkspaceChromeStrip() {
  const sidebarVisible = useSyncExternalStore(
    subscribeChatDockSidebarVisible,
    getChatDockSidebarVisible,
  );

  return (
    // `wco:pr-[...]` (Windows/Linux WCO overlay buttons, index.css:135-144):
    // the strip's own right-edge padding so those native controls don't
    // collide with strip content. The `wco` custom variant (`windowControlsOverlay.ts`)
    // only ever toggles `.wco` on `<html>` when `navigator.windowControlsOverlay`
    // reports visible — a real browser API that is simply never true on mac
    // (which uses `hiddenInset`, not `titleBarOverlay` — DesktopWindow.ts's
    // `getWindowTitleBarOptions`), so this is unconditional here rather than
    // gated on platform in JS; the CSS variant already does that gating.
    // Separate from the mac-only 90px inset, which
    // `resolveWorkspaceChromeInsetStyle` applies via `--workspace-controls-left`
    // on the provider itself (critique m11: the 90px reservation is mac-only,
    // this padding is the non-mac half).
    <div className="wco:pr-[var(--workspace-native-controls-inset)]">
      <SidebarChromeHeader
        isElectron
        sidebarToggle={{ onToggle: toggleChatDockSidebarVisibility, pressed: sidebarVisible }}
      />
    </div>
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
 * dock-chrome-strip.md, Section A: `SidebarProvider` gains `flex-col` — its
 * base wrapper is a flex ROW (ui/sidebar.tsx's `SidebarProvider`), so
 * without this the strip below would become a left COLUMN instead of a top
 * row (critique M4) — plus the mac inset style, computed the same way
 * `AppSidebarLayout` does (`resolveWorkspaceChromeInsetStyle`, shared, no
 * behavior drift between the two). The strip itself renders as the
 * provider's FIRST child, above `<Outlet/>`, so it covers every `_chat`
 * child route — thread, index (including its loading/empty states,
 * critique M6), and draft — gated on `isElectron` alone (it self-sizes on
 * Windows/Linux via `.wco`'s `--workspace-topbar-height` override,
 * index.css:135-144); only the 90px mac inset additionally gates on
 * `isMacosDesktop` (critique m11). Web/non-Electron: strip absent, today's
 * behavior exactly.
 */
function ChatRouteLayout() {
  const isMacosDesktop = isElectron && isMacPlatform(navigator.platform);
  const isWindowFullscreen = useDesktopFullscreenState(isMacosDesktop);
  const chromeInsetStyle = resolveWorkspaceChromeInsetStyle({
    isMacDesktop: isMacosDesktop,
    isFullscreen: isWindowFullscreen,
  });

  return (
    <SidebarProvider className="h-dvh! min-h-0! flex-col" defaultOpen style={chromeInsetStyle}>
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
