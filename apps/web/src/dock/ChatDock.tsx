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
//
// Extended again for spec-files-panel.md: the placeholder's slot in the
// default preset is now the real Files panel (live git status). See
// FilesPanel.tsx for what the real data can and cannot honestly represent.
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { DraftId } from "~/composerDraftStore";
import { THREAD_SIDEBAR_DEFAULT_WIDTH } from "~/components/threadSidebarWidth";
import type { ThreadSyncPhase } from "~/threadSync";
import { Orientation, type SerializedDockview } from "dockview";
import { Files, LayoutDashboard, MessageCircle, PanelLeft } from "lucide-react";

import { ChatPanel, ThreadRouteContext, type ThreadRouteContextValue } from "./ChatPanel";
import { DockviewLayout } from "./DockviewLayout";
import { FilesPanel } from "./FilesPanel";
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
const FILES_PANEL_ID = "files";
const SIDEBAR_GROUP_ID = "group-sidebar";
const CHAT_GROUP_ID = "group-chat";
const FILES_GROUP_ID = "group-files";

const CHAT_DOCK_PRESET_ID = "chat-dock-default";
/**
 * Persisted-layout key (spec's acceptance check 2 reads this back out of
 * `localStorage`). Deliberately NOT keyed by thread: the same dock instance
 * is reused across every thread on this route (see the design constraint
 * below), so its saved split must be one shared layout, not one per thread
 * — the same "workspace" DockviewLayoutProps already models, just with
 * exactly one workspace for now.
 *
 * STABLE FROM HERE ON — fix round after 7606dff45, reversing the precedent
 * step 1/2 set. This key was bumped twice (`"chat-dock"` →
 * `"chat-dock-v2"` when the sidebar panel shipped, → `"chat-dock-v3"` when
 * Files did): each bump doesn't migrate anything, it just points
 * `storage.load` at a brand-new, empty key, so the workspace's saved
 * arrangement is silently replaced by the default preset the next time
 * anyone opens it. The owner's own dragged arrangement was sitting in the
 * orphaned `"chat-dock-v2"` key, thrown away the moment Files shipped — a
 * real user-visible regression, not a hypothetical one, and the exact class
 * of bug `DockviewLayout.tsx`'s save-failure notice exists to PREVENT
 * (never lose a saved arrangement silently) reintroduced through a
 * different door.
 *
 * `DockviewLayout.tsx`'s `loadInitialLayout` now migrates a saved layout
 * forward via `lib/layoutMigration.ts`'s `migrateLoadedLayout` instead: a
 * newly registered panel gets grafted into the EXISTING saved arrangement
 * at its default-preset position, and every panel the saved layout already
 * had stays exactly where the user put it. That makes bumping this key
 * unnecessary going forward — the whole reason it existed was "a new panel
 * won't show up in an old saved layout," and that's no longer true.
 * `"chat-dock-v2"` was picked as the value to settle on (not a fresh
 * `"chat-dock-v3"` or back to `"chat-dock"`) because it's the real key the
 * owner's actual customized arrangement already lives under — reusing it
 * means the very next load migrates that real arrangement forward instead
 * of needing anyone to have foreseen this fix before it existed. The
 * genuinely dead `"chat-dock"` (v1) key, and `"chat-dock-v3"` in case any
 * environment wrote to it during the (brief) window it was live, are purged
 * via `staleWorkspaceIds` below rather than left to accumulate forever.
 */
const CHAT_DOCK_WORKSPACE_ID = "chat-dock-v2";
const CHAT_DOCK_STALE_WORKSPACE_IDS = ["chat-dock", "chat-dock-v3"];
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
 * OWNER CORRECTION to the original spec (spec-dock-step-2.md's "decide which
 * one the dock panel hosts... do not try to host both" was overruled): both
 * `Sidebar` (v1) and `SidebarV2` stay live, neither gets deleted or
 * hardcoded away. `SidebarPanel.tsx` hosts WHICHEVER one
 * `useThreadSidebarComponent()` resolves — the exact same flag
 * `AppSidebarLayout` reads, via a hook extracted out of `AppSidebarLayout`'s
 * own inline ternary specifically so the two call sites share one
 * component-selection decision rather than each independently forking it.
 * "Do not try to host both" is satisfied at the RENDER level (this panel
 * only ever mounts one of the two at a time, matching what
 * `AppSidebarLayout` already does for every non-settings route today) —
 * it's not "pick one forever," it's "don't render two competing sidebars
 * simultaneously."
 *
 * `singleton: true`: `SidebarV2.tsx:2778` hardcodes
 * `id="sidebar-thread-search-results"`, which a second SidebarV2 instance
 * would collide on. Applies regardless of which variant is currently
 * resolved — only one "sidebar" panel can ever be open in this dock either
 * way.
 */
chatDockPanelRegistry.register({
  id: SIDEBAR_PANEL_ID,
  title: "Sidebar",
  icon: PanelLeft,
  component: SidebarPanel,
  defaultLocation: "left",
  singleton: true,
  // Fix round after the "app bricks in 3 clicks" critique: this is now the
  // ONE place this is decided, read by buildChatDockPreset() below,
  // tabContextMenu.ts's close-item gate, and its "Add tab" re-add call.
  // Load-bearing, not decorative: SidebarPanel.tsx's window keydown
  // listeners (thread prev/next, Cmd+1..9) only exist while this panel
  // stays mounted — see this file's own comment further down.
  closeable: false,
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
  // Same reasoning as sidebar's `closeable: false` above — this is the ONE
  // dock a person actually talks to, closing it should never be one
  // right-click away with no other route back in.
  closeable: false,
});

// step-1/step-2 scratch panel. Kept REGISTERED (still reachable via the tab
// context menu's "Add tab", still a real catalog entry) but, as of
// spec-files-panel.md, no longer in the default preset — Files took its
// slot. Deliberately not deleted: nothing else in the catalog offers "an
// empty tab to put something in later," which is a real, if minor, use case
// for exercising the dock's own machinery independent of any real panel's
// behaviour, and removing a registered catalog entry is a bigger, more
// permanent decision than this spec asked for.
chatDockPanelRegistry.register({
  id: PLACEHOLDER_PANEL_ID,
  title: "Panel",
  icon: LayoutDashboard,
  component: PlaceholderPanel,
  defaultLocation: "right",
});

/**
 * The first panel reading this fork's REAL data (spec-files-panel.md) —
 * everything else in this dock is fixture- or T3-component-fed. See
 * FilesPanel.tsx's own module doc for what `VcsStatusResult.workingTree.files`
 * can and cannot honestly represent, and this step's report for what was
 * actually observed testing it against a real repo.
 *
 * `singleton: true` per the spec's default ("prefer singleton unless you can
 * argue two Files panels are useful") — a read-only status view of one
 * thread's one project has no case for a second simultaneous instance the
 * way multi-agent `session` panels do.
 *
 * Deliberately CLOSEABLE (no `tabComponent: TAB_COMPONENT_NO_CLOSE` on its
 * preset entry, unlike sidebar/chat below) — nothing depends on this panel
 * staying mounted the way the sidebar's window keydown listeners do, so
 * there's no reason to take away the user's ability to close it.
 */
chatDockPanelRegistry.register({
  id: FILES_PANEL_ID,
  title: "Files",
  icon: Files,
  component: FilesPanel,
  defaultLocation: "right",
  singleton: true,
});

/**
 * The default preset: sidebar on the left, chat next to it, Files further
 * right in the slot step 1/2's placeholder used to occupy — "same pixels,
 * today" per spec's Part A, with the sidebar's initial width seeded from
 * `THREAD_SIDEBAR_DEFAULT_WIDTH` (`~/components/threadSidebarWidth.ts`,
 * 256px), the SAME constant `AppSidebarLayout`'s fixed sidebar already
 * defaults to — not a re-guessed number. No measured mock exists for the
 * chat:files split (unchanged proportions from step 1/2's chat:placeholder
 * split); dockview stretches this initial tree to fit the real container,
 * so only the RATIOS matter, not the absolute pixels.
 *
 * Sidebar and chat get the no-close tab component, for the same reason step
 * 1 gave them both: no "+"/catalog UI exists yet to reopen a closed panel
 * from, only the tab context menu's "Add tab" for panels not currently
 * open. For the sidebar specifically this is load-bearing, not just
 * convenient — see SidebarPanel.tsx/this file's registration comment on why
 * a panel that can never unmount is what keeps the sidebar's window keydown
 * listeners (thread prev/next, Cmd+1..9) alive. Files is NOT no-close — see
 * its own registration comment above for why that's a deliberate
 * difference, not an oversight.
 *
 * `presetPanelEntry` below reads `closeable` off the REGISTRY rather than
 * this function choosing `tabComponent` independently — fix round after the
 * "app bricks in 3 clicks" critique: two places deciding the same fact
 * (this preset builder, and `tabContextMenu.ts`'s close-gate/re-add) is
 * exactly how "no-close" silently stopped meaning anything. Now there is
 * one place (`PanelDefinition.closeable`, set at registration above), and
 * every caller reads it.
 */
function presetPanelEntry(id: string, title: string): SerializedDockview["panels"][string] {
  const definition = chatDockPanelRegistry.get(id);
  return {
    id,
    contentComponent: id,
    title,
    ...(definition?.closeable === false ? { tabComponent: TAB_COMPONENT_NO_CLOSE } : {}),
  };
}

function buildChatDockPreset(): SerializedDockview {
  const CONTAINER_HEIGHT = 800;
  const SIDEBAR_WIDTH = THREAD_SIDEBAR_DEFAULT_WIDTH;
  const CHAT_WIDTH = 544;
  const FILES_WIDTH = 400;
  const CONTAINER_WIDTH = SIDEBAR_WIDTH + CHAT_WIDTH + FILES_WIDTH;

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
            size: FILES_WIDTH,
            data: {
              id: FILES_GROUP_ID,
              views: [FILES_PANEL_ID],
              activeView: FILES_PANEL_ID,
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
      [FILES_PANEL_ID]: {
        id: FILES_PANEL_ID,
        contentComponent: FILES_PANEL_ID,
        title: "Files",
        // Deliberately no `tabComponent: TAB_COMPONENT_NO_CLOSE` here — see
        // this file's Files-panel registration comment for why it stays
        // closeable, unlike sidebar/chat above.
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
        staleWorkspaceIds={CHAT_DOCK_STALE_WORKSPACE_IDS}
        className={className}
      />
    </ThreadRouteContext.Provider>
  );
}
