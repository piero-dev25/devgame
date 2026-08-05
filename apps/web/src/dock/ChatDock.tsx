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
// default preset became the real Files panel (live git status).
//
// Fix round after the "app bricks in 3 clicks" critique: the step-1/step-2
// placeholder panel itself was REMOVED (finding #7 — see its own removal
// comment further down).
//
// DELETED — spec-surfaces-as-dock-panels.md, Part A: our Files panel itself
// is gone. A fresh critic proved it wrong on the same screen T3's own file
// tree and diff surface were correct: ours listed a file that did not exist
// and reported changes to a file identical to HEAD, with no refresh control
// and no way to know it was stale. T3's own surfaces are strictly better at
// the thing ours existed to do, so ours is deleted rather than fixed — the
// goal's own definition of a win.
//
// PROMOTED — spec-surfaces-as-dock-panels.md, Part B, first slice: T3's own
// Diff surface (`RightPanelTabs`'s `diff` kind, previously rendered inline
// by `ChatView`'s own right panel) is now a real dock panel — `DIFF_PANEL_ID`
// below. `RightPanelTabs`/`DiffPanel` themselves are NOT touched — the
// spec's rule that we delete our code, never theirs, applies here exactly
// as it did to Files. Files, Terminal and Browser are real future work
// (each needs more than Diff did — see `DiffDockPanel.tsx`'s own doc
// comment on why Diff went first), not started here.
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { DraftId } from "~/composerDraftStore";
import { THREAD_SIDEBAR_DEFAULT_WIDTH } from "~/components/threadSidebarWidth";
import { SIDEBAR_PANEL_ID } from "~/dockActiveSelectionStore";
import type { ThreadSyncPhase } from "~/threadSync";
import { Orientation, type SerializedDockview } from "dockview";
import { FileDiff, Files, Globe2, MessageCircle, PanelLeft, TerminalSquare } from "lucide-react";
import { useEffect, useRef } from "react";

import {
  BROWSER_PANEL_ID,
  DIFF_PANEL_ID,
  FILES_PANEL_ID,
  registerChatDockHandle,
  TERMINAL_PANEL_ID,
} from "./chatDockHandle";
import BrowserDockPanel from "./BrowserDockPanel";
import { ChatPanel, ThreadRouteContext, type ThreadRouteContextValue } from "./ChatPanel";
import DiffDockPanel from "./DiffDockPanel";
import { DockviewLayout, type DockviewLayoutHandle } from "./DockviewLayout";
import FilesDockPanel from "./FilesDockPanel";
import TerminalDockPanel from "./TerminalDockPanel";
import {
  createPanelRegistry,
  createPresetRegistry,
  type LayoutPresetFactory,
  type PanelRegistry,
  type PresetRegistry,
} from "./lib/index";
import { TAB_COMPONENT_NO_CLOSE } from "./lib/tabComponents";
import { SidebarPanel } from "./SidebarPanel";

const CHAT_PANEL_ID = "chat";
const SIDEBAR_GROUP_ID = "group-sidebar";
const CHAT_GROUP_ID = "group-chat";
const DIFF_GROUP_ID = "group-diff";
const FILES_GROUP_ID = "group-files";
const TERMINAL_GROUP_ID = "group-terminal";
const BROWSER_GROUP_ID = "group-browser";

const CHAT_DOCK_PRESET_ID = "chat-dock-default";
/**
 * Persisted-layout key (spec's acceptance check 2 reads this back out of
 * `localStorage`). Deliberately NOT keyed by thread: the same dock instance
 * is reused across every thread on this route (see the design constraint
 * below), so its saved split must be one shared layout, not one per thread
 * — the same "workspace" DockviewLayoutProps already models, just with
 * exactly one workspace for now.
 *
 * READ THIS BEFORE ASSUMING "shared" COVERS SELECTION TOO (task #108): the
 * `SerializedDockview` this key stores bundles two genuinely different kinds
 * of state, and "one shared layout, not one per thread" above is a claim
 * about ONLY the first one:
 *  - Layout STRUCTURE — panel positions, sizes, splits — correctly global.
 *    Nobody wants their column widths resetting on every thread switch.
 *  - dockview's own `activeGroup`/per-group `activeView` — which tab is
 *    front-most — travels in this SAME blob, but should NOT be global: it
 *    used to be, and that was the bug (#108's "outer tab selection leaks
 *    across chats" — switch threads, whichever tab you last clicked stays
 *    clicked, everywhere). `dockActiveSelectionStore.ts` (keyed by
 *    `activationKey` below, via `DockviewLayout.tsx`'s
 *    `restoreActivePanelForKey`) now gives selection its own per-thread
 *    answer instead of inheriting this key's shared scope. If you're adding
 *    new dockview-level state here, ask which of these two categories it
 *    belongs to before assuming this comment's "shared" applies to it.
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

// The step-1/step-2 scratch panel (registered here, previously) is REMOVED
// as of the fix round after the "app bricks in 3 clicks" critique, finding
// #7: it shipped as the ONLY "Add tab" entry in a fresh workspace's default
// state, and its own copy told the user to "drag the splitter to resize it
// against the chat panel" — a splitter that does not exist in the exact
// state ("Add tab" opening it as a new grouped tab, not a fresh split) the
// user actually reaches it from. Removed rather than fixed: nothing else in
// this catalog depended on it, and there was no real content to preserve —
// the "empty tab to exercise the dock's own machinery" use case it existed
// for is still available generically (any panel can be dragged/tabbed
// around), so losing this ONE specific placeholder loses nothing real.

// The Files panel that briefly lived HERE (spec-files-panel.md's "the first
// panel reading this fork's REAL data") is DELETED —
// spec-surfaces-as-dock-panels.md, Part A. See the top-of-file doc comment
// for why: T3's own file tree and diff surface were proven correct where
// ours lied, on the same screen, at the same moment. Nothing replaces THIS
// registration — the third column below is Diff (T3's OWN surface), not a
// revival of ours.

/**
 * Part B, first slice: T3's own Diff surface as an ordinary dock panel.
 * `DiffDockPanel.tsx` is a thin wrapper — see its own doc comment for why it
 * exists and what it derives that a dock panel has no ChatView to hand it.
 *
 * `singleton: true`: same reasoning as Files had — a read-only diff view of
 * one thread's changes has no case for two simultaneous instances the way
 * multi-agent `session` panels do.
 *
 * `closeable: true` (the default — no `closeable: false` here, unlike
 * sidebar/chat above): nothing depends on this panel staying mounted the
 * way the sidebar's window keydown listeners do, so there is no reason to
 * take away the user's ability to close it. Matches what Files was before
 * it was deleted.
 */
chatDockPanelRegistry.register({
  id: DIFF_PANEL_ID,
  title: "Diff",
  icon: FileDiff,
  component: DiffDockPanel,
  defaultLocation: "right",
  singleton: true,
});

/**
 * Part B, second slice (task #61): T3's own Files surface as an ordinary
 * dock panel. `FilesDockPanel.tsx` is a thicker wrapper than Diff's — see
 * its own doc comment for the three decisions that made it so (files+file
 * move together, a dedicated store for "which file is open," the minimal
 * multi-file tab strip preserved from `RightPanelTabs`).
 *
 * `singleton: true`: same reasoning as Diff — one thread's file browser has
 * no case for two simultaneous instances.
 *
 * `closeable: true` (the default, no override): same reasoning as Diff —
 * nothing depends on this panel staying mounted, so no reason to take away
 * the ability to close it.
 */
chatDockPanelRegistry.register({
  id: FILES_PANEL_ID,
  title: "Files",
  icon: Files,
  component: FilesDockPanel,
  defaultLocation: "right",
  singleton: true,
});

/**
 * Part B, third slice (task #53): T3's own Terminal surface as an ordinary
 * dock panel. `TerminalDockPanel.tsx` is closer to Files' shape than Diff's
 * — see its own doc comment for the session-lifecycle reasoning that makes
 * it so.
 *
 * `singleton: true`: same reasoning as Diff/Files — one thread's terminal
 * workspace (itself capable of holding several groups/splits internally,
 * via `TerminalDockPanel`'s own tab strip) has no case for two simultaneous
 * PANEL instances.
 *
 * `closeable: true` (the default, no override): same reasoning as Diff/
 * Files — nothing depends on this panel staying mounted, and closing it no
 * longer ends any session (see `terminalDockStore.ts`'s own doc comment for
 * why that's a deliberate, precedent-matching change from the old
 * right-panel tab's close behaviour).
 */
chatDockPanelRegistry.register({
  id: TERMINAL_PANEL_ID,
  title: "Terminal",
  icon: TerminalSquare,
  component: TerminalDockPanel,
  defaultLocation: "right",
  singleton: true,
});

/**
 * Part B, fourth and final slice (task #53): T3's own Browser (preview)
 * surface as an ordinary dock panel. `BrowserDockPanel.tsx` needs no new
 * store — see its own doc comment for why `previewStateStore.ts` already
 * carried everything this panel reads.
 *
 * `singleton: true`: same reasoning as the other three — one thread's
 * browser workspace (itself capable of holding several tabs via
 * `BrowserDockPanel`'s own tab strip) has no case for two simultaneous
 * PANEL instances.
 *
 * `closeable: true` (the default, no override): same reasoning as the
 * other three — closing the panel is a view action, never destructive (see
 * `BrowserDockPanel.tsx`'s own module doc on desktop-only degradation for
 * the one place this panel DOES need to behave differently depending on
 * runtime).
 */
chatDockPanelRegistry.register({
  id: BROWSER_PANEL_ID,
  title: "Browser",
  icon: Globe2,
  component: BrowserDockPanel,
  defaultLocation: "right",
  singleton: true,
});

/**
 * The default preset: sidebar on the left, chat next to it, Diff, Files,
 * Terminal and Browser further right — the same third-column slot Files
 * occupied before Part A deleted our own version of it, now occupied by
 * T3's own Diff, Files, Terminal AND Browser surfaces instead of a
 * re-filled stand-in. This preset now covers every surface
 * spec-surfaces-as-dock-panels.md set out to promote.
 *
 * Sidebar's initial width is seeded from `THREAD_SIDEBAR_DEFAULT_WIDTH`
 * (`~/components/threadSidebarWidth.ts`, 256px), the SAME constant
 * `AppSidebarLayout`'s fixed sidebar already defaults to — not a re-guessed
 * number. No measured mock exists for the chat:diff:files split — dockview
 * stretches this initial tree to fit the real container, so only the
 * RATIOS matter, not the absolute pixels.
 *
 * Sidebar and chat get the no-close tab component, for the same reason step
 * 1 gave them both: no "+"/catalog UI exists yet to reopen a closed panel
 * from, only the tab context menu's "Add tab" for panels not currently
 * open. For the sidebar specifically this is load-bearing, not just
 * convenient — see SidebarPanel.tsx/this file's registration comment on why
 * a panel that can never unmount is what keeps the sidebar's window keydown
 * listeners (thread prev/next, Cmd+1..9) alive. Diff and Files are NOT
 * no-close — see their own registration comments above for why that's
 * deliberate.
 *
 * `presetPanelEntry` below reads `closeable` off the REGISTRY rather than
 * this function choosing `tabComponent` independently — fix round after the
 * "app bricks in 3 clicks" critique: two places deciding the same fact
 * (this preset builder, and `tabContextMenu.ts`'s close-gate/re-add) is
 * exactly how "no-close" silently stopped meaning anything. Now there is
 * one place (`PanelDefinition.closeable`, set at registration above), and
 * every caller reads it.
 *
 * Diff and Files are each their own SEPARATE leaf in this flat branch (own
 * `views: [id]` array, length 1) — a SEPARATE PANEL IN A ROW, not tabbed
 * into chat's group or into each other. That's not just this function's
 * choice: `lib/layoutMigration.ts`'s `locatePanelInFlatBranch` only
 * recognizes a leaf as a newly-registered panel's home when
 * `views.length === 1` — grafting either into an existing TABBED group here
 * would make it unrecognizable to migration (reported as unplaceable) for
 * every user who saved a layout before this shipped. The "separate row"
 * rule enforces itself structurally; it isn't something a future edit here
 * could quietly break without migration noticing.
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
  const CHAT_WIDTH = 640;
  const DIFF_WIDTH = 400;
  const FILES_WIDTH = 400;
  const TERMINAL_WIDTH = 400;
  const BROWSER_WIDTH = 400;
  const CONTAINER_WIDTH =
    SIDEBAR_WIDTH + CHAT_WIDTH + DIFF_WIDTH + FILES_WIDTH + TERMINAL_WIDTH + BROWSER_WIDTH;

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
            size: DIFF_WIDTH,
            data: { id: DIFF_GROUP_ID, views: [DIFF_PANEL_ID], activeView: DIFF_PANEL_ID },
          },
          {
            type: "leaf",
            size: FILES_WIDTH,
            data: { id: FILES_GROUP_ID, views: [FILES_PANEL_ID], activeView: FILES_PANEL_ID },
          },
          {
            type: "leaf",
            size: TERMINAL_WIDTH,
            data: {
              id: TERMINAL_GROUP_ID,
              views: [TERMINAL_PANEL_ID],
              activeView: TERMINAL_PANEL_ID,
            },
          },
          {
            type: "leaf",
            size: BROWSER_WIDTH,
            data: {
              id: BROWSER_GROUP_ID,
              views: [BROWSER_PANEL_ID],
              activeView: BROWSER_PANEL_ID,
            },
          },
        ],
      },
    },
    panels: {
      [SIDEBAR_PANEL_ID]: presetPanelEntry(SIDEBAR_PANEL_ID, "Sidebar"),
      [CHAT_PANEL_ID]: presetPanelEntry(CHAT_PANEL_ID, "Chat"),
      [DIFF_PANEL_ID]: presetPanelEntry(DIFF_PANEL_ID, "Diff"),
      [FILES_PANEL_ID]: presetPanelEntry(FILES_PANEL_ID, "Files"),
      [TERMINAL_PANEL_ID]: presetPanelEntry(TERMINAL_PANEL_ID, "Terminal"),
      [BROWSER_PANEL_ID]: presetPanelEntry(BROWSER_PANEL_ID, "Browser"),
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
  // spec-surfaces-as-dock-panels.md, Part B: registers this dock instance's
  // `DockviewLayoutHandle` into `chatDockHandle.ts`'s module-scope slot, so
  // code OUTSIDE the dock (ChatView's `addDiffSurface`/`onOpenTurnDiff`) can
  // open a panel by id without a ref drilled through `ChatPanel` (a circular
  // import — ChatView is a DESCENDANT of this component, not a sibling; see
  // chatDockHandle.ts's own doc comment). Set on mount, CLEARED on unmount —
  // a stale handle pointing at a disposed dock is worse than a null one.
  // Only one `ChatDock` is ever live at a time (`workspaceId`/`presetId` are
  // module-scope constants, same "exactly one dock" precedent as
  // `chatDockPanelRegistry` above), so there is no multi-instance case to
  // reconcile here.
  const dockviewLayoutRef = useRef<DockviewLayoutHandle>(null);
  useEffect(() => {
    registerChatDockHandle(dockviewLayoutRef.current);
    return () => registerChatDockHandle(null);
  }, []);
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
        ref={dockviewLayoutRef}
        workspaceId={CHAT_DOCK_WORKSPACE_ID}
        workspaceName={CHAT_DOCK_WORKSPACE_NAME}
        presetId={CHAT_DOCK_PRESET_ID}
        panelRegistry={chatDockPanelRegistry}
        presetRegistry={chatDockPresetRegistry}
        fallbackPreset={chatDockFallbackPreset}
        staleWorkspaceIds={CHAT_DOCK_STALE_WORKSPACE_IDS}
        // Fix round, finding #5 ("selecting a thread does not show you the
        // thread"): a plain string built from primitive props, not an
        // object — no memoization needed, React's deps-array comparison
        // already works correctly on a primitive's VALUE. Covers both
        // routes identically: a click on an existing thread AND "New
        // thread" (a draft's own threadId) both change this string, both
        // must bring Chat forward the same way — team-lead's report named
        // both as regressions, not just the server-thread case.
        activationKey={`${props.environmentId}:${props.threadId}`}
        activateOnChangeId={CHAT_PANEL_ID}
        className={className}
      />
    </ThreadRouteContext.Provider>
  );
}
