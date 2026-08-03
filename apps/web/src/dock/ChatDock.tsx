// New for step 1 (spec-dock-step-1.md) — not a port. This is the piece the
// spec describes as "make the implementation decisions yourself": the
// route-facing entry point that wires the ported layout engine
// (DockviewLayout.tsx + lib/**) to this fork's real ChatView, with exactly
// the two panels step 1 asks for.
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Orientation, type SerializedDockview } from "dockview";
import { LayoutDashboard, MessageCircle } from "lucide-react";
import { useMemo } from "react";

import type { ThreadSyncPhase } from "~/threadSync";

import { ChatPanel, ThreadRouteContext } from "./ChatPanel";
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

const CHAT_PANEL_ID = "chat";
const PLACEHOLDER_PANEL_ID = "placeholder";
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
 */
const CHAT_DOCK_WORKSPACE_ID = "chat-dock";
const CHAT_DOCK_WORKSPACE_NAME = "Chat";

/**
 * Registered once, at module scope — not per-render, not per-route-mount.
 * Neither panel's `component` closes over per-render values (ChatPanel
 * reads `ThreadRouteContext` instead — see ChatPanel.tsx for why), so
 * nothing here needs to be rebuilt when the route's thread changes.
 * `createPanelRegistry()`/`createPresetRegistry()` throw on a duplicate
 * `register()` call, which module-scope construction naturally avoids (this
 * module's top level runs exactly once per module instance, same as any
 * other singleton in this codebase) without needing a memo guard.
 */
export const chatDockPanelRegistry: PanelRegistry = createPanelRegistry();

chatDockPanelRegistry.register({
  id: CHAT_PANEL_ID,
  title: "Chat",
  icon: MessageCircle,
  component: ChatPanel,
  defaultLocation: "centre",
  // Design constraint: "Register the chat panel as a singleton. ChatView
  // depends on module-level Zustand stores; two instances would share
  // composer state." Nothing in step 1's UI can actually open a second
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
 * Step 1's only preset: chat on the left, the placeholder beside it on the
 * right, split by a draggable vertical sash. No measured mock exists for
 * this fork yet (unlike source's coreCombat.ts, which cites pixel-sampled
 * dimensions) — `CONTAINER_WIDTH`/`CONTAINER_HEIGHT`/`CHAT_WIDTH` below are
 * nominal proportions (roughly a 2:1 chat:placeholder split), not measured
 * numbers. Dockview stretches this initial tree to fit whatever the actual
 * container size is, so only the RATIO matters, not the absolute pixels.
 *
 * Both panels get the no-close tab component: step 1 has no "+"/catalog UI
 * to reopen a closed panel from, only the tab context menu's "Add tab" (any
 * panel not currently open, by id) — leaving both panels closeable would let
 * a QA pass or a stray click on the single chat tab's × leave the dock
 * chat-less with no in-UI way back short of a full reset. Matches the
 * source presets' own convention: default-preset panels never show close.
 */
function buildChatDockPreset(): SerializedDockview {
  const CONTAINER_WIDTH = 1200;
  const CONTAINER_HEIGHT = 800;
  const CHAT_WIDTH = 800;
  const PLACEHOLDER_WIDTH = CONTAINER_WIDTH - CHAT_WIDTH;

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
 * registered under `CHAT_DOCK_PRESET_ID` above. Step 1 has exactly one
 * preset, so the "unregistered preset id" branch `buildPresetSafely` guards
 * against can't actually happen here (`presetId` below is always
 * `CHAT_DOCK_PRESET_ID`, which is always registered) — this is satisfying
 * `DockviewLayout`'s required-prop contract honestly rather than leaving a
 * gap, not a path step 1's own UI can reach.
 */
const chatDockFallbackPreset: LayoutPresetFactory = buildChatDockPreset;

export interface ChatDockProps {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  threadSyncPhase?: ThreadSyncPhase | null;
  // `| undefined` spelled out explicitly (`exactOptionalPropertyTypes`) —
  // see DockviewLayout.tsx's matching `className` prop, which this passes
  // straight through to.
  className?: string | undefined;
}

/**
 * The dock this fork's thread route mounts (spec's "Mount point"). Provides
 * `ThreadRouteContext` from the route's own params/hooks — never from
 * dockview panel params — and renders the ported `DockviewLayout` with
 * step 1's fixed panel/preset registries above.
 *
 * `workspaceId`/`presetId` are constants, not derived from `threadId`: per
 * the design constraint "Route is the source of truth... the dock does not
 * remount" (acceptance check 3), switching threads must NOT tear down and
 * recreate the dockview instance — `DockviewLayout`'s own mount effect only
 * re-runs when `workspaceId`/`presetId` change identity, so keeping both
 * constant across every thread is what keeps the splitter in place across a
 * thread switch. Only the `ThreadRouteContext` value changes, which
 * `ChatPanel` picks up on its next render without remounting itself either
 * (same component identity — see ChatPanel.tsx).
 */
export function ChatDock({
  environmentId,
  threadId,
  threadSyncPhase = null,
  className,
}: ChatDockProps) {
  const contextValue = useMemo(
    () => ({ environmentId, threadId, threadSyncPhase }),
    [environmentId, threadId, threadSyncPhase],
  );

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
