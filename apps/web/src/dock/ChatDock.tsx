// Step 1 (spec-dock-step-1.md) — not a port. This is the piece the spec
// describes as "make the implementation decisions yourself": the
// route-facing entry point that wires the ported layout engine
// (DockviewLayout.tsx + lib/**) to this fork's real ChatView.
//
// Extended for step 2 (spec-dock-step-2.md):
//  - Part A registers a third panel — T3's own sidebar — and the default
//    preset becomes a three-column split (sidebar | chat | placeholder).
//  - Part B makes `ChatDockProps` a discriminated union on `routeKind`
//    (mirroring `ChatViewProps`/`ThreadRouteContextValue`), so the SAME
//    `ChatDock` mounts on both the server-thread and draft routes.
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { DraftId } from "~/composerDraftStore";
import { THREAD_SIDEBAR_DEFAULT_WIDTH } from "~/components/threadSidebarWidth";
import type { ThreadSyncPhase } from "~/threadSync";
import { Orientation, type SerializedDockview } from "dockview";
import { LayoutDashboard, MessageCircle, PanelLeft } from "lucide-react";

import { ChatPanel, ThreadRouteContext, type ThreadRouteContextValue } from "./ChatPanel";
import { DockviewLayout } from "./DockviewLayout";
import {
  createPanelRegistry,
  createPresetRegistry,
  type LayoutPresetFactory,
  type PanelRegistry,
  type PresetRegistry,
} from "./lib/index";
import { TAB_COMPONENT_NO_CLOSE } from "./lib/tabComponents";
import { PlaceholderPanel } from "./PlaceholderPanel";
import { SidebarPanel } from "./SidebarPanel";

const SIDEBAR_PANEL_ID = "sidebar";
const CHAT_PANEL_ID = "chat";
const PLACEHOLDER_PANEL_ID = "placeholder";
const SIDEBAR_GROUP_ID = "group-sidebar";
const CHAT_GROUP_ID = "group-chat";
const PLACEHOLDER_GROUP_ID = "group-placeholder";

const CHAT_DOCK_PRESET_ID = "chat-dock-default";
/**
 * Persisted-layout key (spec's acceptance check 2 reads this back out of
 * `localStorage`). Deliberately NOT keyed by thread: the same dock instance
 * is reused across every thread on this route (see the design constraint
 * below), so its saved split must be one shared layout, not one per thread
 * — the same "workspace" DockviewLayoutProps already models, just with
 * exactly one workspace for now.
 *
 * Bumped from step 1's `"chat-dock"` to `"chat-dock-v2"`: a layout saved
 * under the old id references only 2 panels (`chat`, `placeholder`) — the
 * newly-registered `sidebar` panel simply isn't in that saved grid, so
 * dockview would restore the old 2-panel arrangement verbatim and the
 * sidebar would silently not appear (recoverable via the tab context menu's
 * "Add tab", or a reset, but not automatic). This dev machine already has
 * exactly such a layout persisted — see
 * docs/workbench/dock-step-1-e2e-evidence.md's check 2 — so reusing the old
 * key would make step 2 land invisibly regressed on the very machine used to
 * verify it. No migration is asked for by this spec; a fresh workspace id
 * is the honest way to land the new default cleanly everywhere.
 */
const CHAT_DOCK_WORKSPACE_ID = "chat-dock-v2";
const CHAT_DOCK_WORKSPACE_NAME = "Chat";

/**
 * Registered once, at module scope — not per-render, not per-route-mount.
 * No panel's `component` closes over per-render values (each reads
 * `ThreadRouteContext`/`SidebarProvider`'s own context instead), so nothing
 * here needs to be rebuilt when the route's thread changes.
 * `createPanelRegistry()`/`createPresetRegistry()` throw on a duplicate
 * `register()` call, which module-scope construction naturally avoids (this
 * module's top level runs exactly once per module instance, same as any
 * other singleton in this codebase) without needing a memo guard.
 */
export const chatDockPanelRegistry: PanelRegistry = createPanelRegistry();

/**
 * Part A: T3's sidebar as an ordinary dock panel.
 *
 * Hosts `SidebarV2`, not `Sidebar` (v1) — the spec is explicit: "decide
 * which one the dock panel hosts and say why. Do not try to host both."
 * `useSidebarV2Enabled()` (`~/hooks/useSettings.ts`) resolves v2 as the
 * default "for nightly and dev" build stages absent an explicit user
 * override, and this fork's `APP_STAGE_LABEL` is a dev/nightly stage — the
 * same "dev/nightly default" language the spec itself uses to describe v2.
 * A single hard-coded choice (rather than replicating `AppSidebarLayout`'s
 * live `sidebarV2Enabled` switch inside this panel) is what "do not try to
 * host both" is asking for: one panel, one component, no runtime branch
 * duplicating a decision `AppSidebarLayout` already owns for `/settings`.
 * If a user has explicitly opted into v1 via Settings → Beta, the docked
 * sidebar will show v2 anyway while `/settings` still shows v1 — a real,
 * visible gap, documented here rather than silently accepted.
 *
 * `singleton: true`: `SidebarV2.tsx:2778` hardcodes
 * `id="sidebar-thread-search-results"`, which a second instance would
 * collide on.
 */
chatDockPanelRegistry.register({
  id: SIDEBAR_PANEL_ID,
  title: "Sidebar",
  icon: PanelLeft,
  component: SidebarPanel,
  defaultLocation: "left",
  singleton: true,
});

chatDockPanelRegistry.register({
  id: CHAT_PANEL_ID,
  title: "Chat",
  icon: MessageCircle,
  component: ChatPanel,
  defaultLocation: "centre",
  // Design constraint: "Register the chat panel as a singleton. ChatView
  // depends on module-level Zustand stores; two instances would share
  // composer state." Nothing in this dock's UI can actually open a second
  // "chat" panel instance (tabContextMenu.ts's "Add tab" already filters out
  // any id that's already open, by id — there's no separate "new instance"
  // affordance), so this flag is currently just honest self-documentation
  // for whichever future UI reads it, matching how the source catalog uses
  // it (see catalog.tsx's `session` entry, which flips it the other way for
  // its own different reason).
  singleton: true,
});

chatDockPanelRegistry.register({
  id: PLACEHOLDER_PANEL_ID,
  title: "Panel",
  icon: LayoutDashboard,
  component: PlaceholderPanel,
  defaultLocation: "right",
});

/**
 * The default preset: sidebar on the left, chat next to it, the step-1
 * placeholder further right — "same pixels, today" per spec's Part A, with
 * the sidebar's initial width seeded from `THREAD_SIDEBAR_DEFAULT_WIDTH`
 * (`~/components/threadSidebarWidth.ts`, 256px), the SAME constant
 * `AppSidebarLayout`'s fixed sidebar already defaults to — not a re-guessed
 * number. No measured mock exists for the chat:placeholder split (unchanged
 * from step 1, just with the sidebar's width carved out of what was
 * previously chat's share); dockview stretches this initial tree to fit the
 * real container, so only the RATIOS matter, not the absolute pixels.
 *
 * All three panels get the no-close tab component, for the same reason step
 * 1 gave the first two: no "+"/catalog UI exists yet to reopen a closed
 * panel from, only the tab context menu's "Add tab" for panels not
 * currently open. For the sidebar specifically this is load-bearing, not
 * just convenient — see SidebarPanel.tsx/this file's registration comment
 * on why a panel that can never unmount is what keeps the sidebar's window
 * keydown listeners (thread prev/next, Cmd+1..9) alive.
 */
function buildChatDockPreset(): SerializedDockview {
  const CONTAINER_HEIGHT = 800;
  const SIDEBAR_WIDTH = THREAD_SIDEBAR_DEFAULT_WIDTH;
  const CHAT_WIDTH = 544;
  const PLACEHOLDER_WIDTH = 400;
  const CONTAINER_WIDTH = SIDEBAR_WIDTH + CHAT_WIDTH + PLACEHOLDER_WIDTH;

  return {
    grid: {
      orientation: Orientation.HORIZONTAL,
      width: CONTAINER_WIDTH,
      height: CONTAINER_HEIGHT,
      root: {
        type: "branch",
        size: CONTAINER_WIDTH,
        data: [
          {
            type: "leaf",
            size: SIDEBAR_WIDTH,
            data: { id: SIDEBAR_GROUP_ID, views: [SIDEBAR_PANEL_ID], activeView: SIDEBAR_PANEL_ID },
          },
          {
            type: "leaf",
            size: CHAT_WIDTH,
            data: { id: CHAT_GROUP_ID, views: [CHAT_PANEL_ID], activeView: CHAT_PANEL_ID },
          },
          {
            type: "leaf",
            size: PLACEHOLDER_WIDTH,
            data: {
              id: PLACEHOLDER_GROUP_ID,
              views: [PLACEHOLDER_PANEL_ID],
              activeView: PLACEHOLDER_PANEL_ID,
            },
          },
        ],
      },
    },
    panels: {
      [SIDEBAR_PANEL_ID]: {
        id: SIDEBAR_PANEL_ID,
        contentComponent: SIDEBAR_PANEL_ID,
        title: "Sidebar",
        tabComponent: TAB_COMPONENT_NO_CLOSE,
      },
      [CHAT_PANEL_ID]: {
        id: CHAT_PANEL_ID,
        contentComponent: CHAT_PANEL_ID,
        title: "Chat",
        tabComponent: TAB_COMPONENT_NO_CLOSE,
      },
      [PLACEHOLDER_PANEL_ID]: {
        id: PLACEHOLDER_PANEL_ID,
        contentComponent: PLACEHOLDER_PANEL_ID,
        title: "Panel",
        tabComponent: TAB_COMPONENT_NO_CLOSE,
      },
    },
    activeGroup: CHAT_GROUP_ID,
  };
}

export const chatDockPresetRegistry: PresetRegistry = createPresetRegistry();
chatDockPresetRegistry.register({
  id: CHAT_DOCK_PRESET_ID,
  label: "Default",
  build: buildChatDockPreset,
});

/**
 * `DockviewLayoutProps.fallbackPreset` — reuses the very factory just
 * registered under `CHAT_DOCK_PRESET_ID` above. This dock has exactly one
 * preset, so the "unregistered preset id" branch `buildPresetSafely` guards
 * against can't actually happen here (`presetId` below is always
 * `CHAT_DOCK_PRESET_ID`, which is always registered) — this is satisfying
 * `DockviewLayout`'s required-prop contract honestly rather than leaving a
 * gap, not a path this dock's own UI can reach.
 */
const chatDockFallbackPreset: LayoutPresetFactory = buildChatDockPreset;

/**
 * Part B: the same union `ChatViewProps`/`ThreadRouteContextValue` use, so
 * one `ChatDock` serves both the server-thread route and the draft route —
 * see ChatPanel.tsx for the "why one component" reasoning, which applies
 * here identically.
 */
export type ChatDockRouteProps =
  | {
      routeKind: "server";
      environmentId: EnvironmentId;
      threadId: ThreadId;
      threadSyncPhase?: ThreadSyncPhase | null;
    }
  | {
      routeKind: "draft";
      environmentId: EnvironmentId;
      threadId: ThreadId;
      draftId: DraftId;
    };

export type ChatDockProps = ChatDockRouteProps & {
  // `| undefined` spelled out explicitly (`exactOptionalPropertyTypes`) —
  // see DockviewLayout.tsx's matching `className` prop, which this passes
  // straight through to.
  className?: string | undefined;
};

/**
 * The dock both thread routes mount (spec's "Mount point", extended by step
 * 2 Part B to the draft route). Provides `ThreadRouteContext` from the
 * route's own params/hooks — never from dockview panel params — and renders
 * the ported `DockviewLayout` with this dock's fixed panel/preset
 * registries above.
 *
 * `workspaceId`/`presetId` are constants, not derived from `threadId` OR
 * `routeKind`: per the design constraint "Route is the source of truth...
 * the dock does not remount" (acceptance check 3), switching threads must
 * NOT tear down and recreate the dockview instance — `DockviewLayout`'s own
 * mount effect only re-runs when `workspaceId`/`presetId` change identity,
 * so keeping both constant across every thread (and across `routeKind`) is
 * what keeps the splitter in place across a thread switch.
 *
 * Step 2 Part B's promotion case is the same mechanism working across an
 * unavoidable React-level unmount: a draft promoting to a real thread
 * navigates from `/_chat/draft/$draftId` to `/_chat/$environmentId/$threadId`
 * — two different file routes, so `<Outlet/>` swaps component TYPES at that
 * position and React tears down the draft route's whole tree (this
 * `ChatDock` included) and mounts the server route's fresh one. There is no
 * way to avoid that unmount without hoisting the dock above where the two
 * routes diverge, which is a materially bigger change than this step asks
 * for. What survives it is the PERSISTED layout: because `workspaceId`
 * never varies with `routeKind`, `DockviewLayout`'s synchronous
 * flush-on-unmount (see its own module doc) writes the draft instance's
 * current arrangement to the same `localStorage` key the fresh server
 * instance reads from on its very next mount — so the dockview-core
 * instance itself is genuinely destroyed and recreated, but the
 * arrangement it recreates is byte-identical to what was there a moment
 * before. That is "a dock identity stable across the promotion."
 */
export function ChatDock(props: ChatDockProps) {
  const { className } = props;
  // Not memoized: step 1 memoized this object, but constructing a
  // 3-4-field plain object is cheap enough that the memo bought nothing
  // beyond a slightly harder-to-read deps array once a second `routeKind`
  // variant was added. A changed identity here only causes `ChatPanel` (a
  // thin props-forwarder) to re-render, not any dockview/persistence work —
  // see `DockviewLayout`'s own mount effect, which depends on
  // `workspaceId`/`presetId` alone, never on this context value.
  const contextValue: ThreadRouteContextValue =
    props.routeKind === "draft"
      ? {
          routeKind: "draft",
          environmentId: props.environmentId,
          threadId: props.threadId,
          draftId: props.draftId,
        }
      : {
          routeKind: "server",
          environmentId: props.environmentId,
          threadId: props.threadId,
          threadSyncPhase: props.threadSyncPhase ?? null,
        };

  return (
    <ThreadRouteContext.Provider value={contextValue}>
      <DockviewLayout
        workspaceId={CHAT_DOCK_WORKSPACE_ID}
        workspaceName={CHAT_DOCK_WORKSPACE_NAME}
        presetId={CHAT_DOCK_PRESET_ID}
        panelRegistry={chatDockPanelRegistry}
        presetRegistry={chatDockPresetRegistry}
        fallbackPreset={chatDockFallbackPreset}
        className={className}
      />
    </ThreadRouteContext.Provider>
  );
}
