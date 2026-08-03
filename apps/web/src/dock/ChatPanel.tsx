// Step 1 (spec-dock-step-1.md) — not a port. Wires this fork's real
// `ChatView` into a dockview panel.
// Extended for step 2 (spec-dock-step-2.md, Part B): the draft route
// (`_chat.draft.$draftId.tsx`) now shares this same panel/component instead
// of rendering `ChatView` directly, so `ThreadRouteContextValue` is a
// discriminated union on `routeKind` — mirroring `ChatViewProps`'s own union
// (`ChatView.tsx:465-485`) exactly, per the spec: "the chat panel needs the
// same union rather than a second component."
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { createContext, useContext } from "react";

import ChatView from "~/components/ChatView";
import type { DraftId } from "~/composerDraftStore";
import type { ThreadSyncPhase } from "~/threadSync";

import type { PanelProps } from "./lib/types";

export type ThreadRouteContextValue =
  | {
      routeKind: "server";
      environmentId: EnvironmentId;
      threadId: ThreadId;
      threadSyncPhase: ThreadSyncPhase | null;
    }
  | {
      routeKind: "draft";
      environmentId: EnvironmentId;
      threadId: ThreadId;
      draftId: DraftId;
    };

/**
 * How `ChatPanel` below satisfies the spec's design constraint: "`ChatPanel`
 * must read thread identity from the ROUTE, never from dockview panel
 * params, and no `threadId` may be written into the persisted layout."
 *
 * A React context, provided by `ChatDock` from props the route hands it
 * (see `_chat.$environmentId.$threadId.tsx` and, since step 2,
 * `_chat.draft.$draftId.tsx`), rather than a closure captured at
 * panel-registration time. That choice isn't cosmetic: this panel's
 * `component` reference lives in a registry built ONCE at module scope in
 * `ChatDock.tsx` — so its function identity never changes across a thread
 * switch OR a draft-to-server promotion, and React reconciles it as the
 * same component instance (matching how the routes rendered `<ChatView>`
 * directly before this port, with no `key`). If the component itself
 * closed over `environmentId`/`threadId` instead, a fresh closure would be
 * a fresh component identity every navigation, forcing an unnecessary full
 * remount of `ChatView`. Context sidesteps that: same component, same
 * instance, just a different value flowing down.
 *
 * `ChatPanel`'s `params`/`updateParams` (from `PanelProps`) are unused on
 * purpose — nothing here ever calls `updateParams`, which is what keeps
 * thread/draft identity out of the persisted layout entirely, not just out
 * of convention.
 */
export const ThreadRouteContext = createContext<ThreadRouteContextValue | null>(null);

function useThreadRouteContext(): ThreadRouteContextValue {
  const value = useContext(ThreadRouteContext);
  if (!value) {
    throw new Error("ChatPanel rendered outside a ThreadRouteContext.Provider — see ChatDock.tsx");
  }
  return value;
}

/**
 * The dock panel's chat content. Stable module-scope component (registered
 * once, in ChatDock.tsx) — see `ThreadRouteContext`'s doc comment above for
 * why that matters, and ChatDock.tsx's own doc comment for how the SAME
 * panel/workspace/preset identity across a draft's promotion to a real
 * thread is what keeps the dock's arrangement from resetting at that
 * moment (spec's acceptance check 4).
 *
 * `reserveTitleBarControlInset={false}`: `ChatView`'s header normally
 * reserves space for Electron's native window-control inset because it
 * doubles as the OS title bar when rendered full-page. Inside a dock panel
 * it is no longer the title bar — the real title bar is above the whole
 * dock, outside this panel — so that reserved space must be turned off or
 * the header shows a dead gap (or, if `SidebarInset`/the route also reserves
 * its own inset above the dock, two stacked title-bar-shaped rows). Step 2
 * Part C re-checked this live with the dock's tab strip now actually above
 * it (step 1 wired the prop but never watched for the double-row failure
 * mode it exists to prevent) — see the step-2 report for what was observed.
 *
 * BUG FOUND WHILE VERIFYING PART B, not asked for by the spec but load-bearing
 * for it: `ChatView`'s own root (`ChatView.tsx`'s `ChatViewContent`) is
 * `relative flex min-h-0 min-w-0 flex-1 overflow-hidden` — a flex ITEM that
 * only stretches to fill available height if its DOM parent is itself
 * `display:flex`. Before this port that parent was always `SidebarInset`
 * (`<main class="... flex w-full flex-1 flex-col ...">`). Inside a dock
 * panel, `ChatView`'s direct DOM parent is `reactContentRenderer.tsx`'s
 * panel-content host div, which is a plain block element
 * (`height:100%;width:100%;overflow:auto`, no `display:flex`) — so
 * `flex-1`/`min-h-0` on ChatView's root silently do nothing there.
 *
 * This is invisible for a thread with real messages: the composer there is
 * positioned `absolute inset-x-0 bottom-0` (ChatView.tsx:5863), which only
 * needs its positioned ancestor's BOTTOM edge — well-defined even if that
 * ancestor's height collapsed to its natural content size. It breaks the
 * empty-draft "hero" screen specifically (`isDraftHeroState`,
 * ChatView.tsx:5856-5872): that composer is centered via `absolute inset-0
 * flex items-center`, which needs the ancestor's actual HEIGHT to center
 * against. With `MessagesTimeline` rendering nothing for a hero thread
 * (`hideEmptyPlaceholder={isDraftHeroState}`), that ancestor's unstretched,
 * content-driven height collapsed to only a few px — so "centering" landed
 * the composer block right at the panel's top edge, and the ~90px-tall
 * `DraftHeroHeadline` sitting `absolute bottom-full` above it (by design —
 * it belongs above the composer) rendered almost entirely off the top of
 * the panel. Confirmed live: a fresh draft's "Choose a project"/"What
 * should we build" headline and composer were present in the DOM
 * (`getBoundingClientRect().top` around -60px) but not on screen.
 *
 * Fixed here, not in `reactContentRenderer.tsx`: that file is shared by
 * every panel (sidebar, placeholder, chat), already E2E-verified in step 1,
 * and the sidebar/placeholder panels size themselves independently of their
 * host's `display` value (they set their own `h-full flex flex-col`, which
 * only needs a definite HEIGHT on the parent, not a flex one) — so widening
 * the fix to that shared file would touch working code for no benefit.
 * Restoring the exact flex context `SidebarInset` used to provide, ONLY
 * around `ChatView`, is the smaller, more targeted fix.
 */
export function ChatPanel(_props: PanelProps) {
  const value = useThreadRouteContext();

  if (value.routeKind === "draft") {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <ChatView
          environmentId={value.environmentId}
          threadId={value.threadId}
          routeKind="draft"
          draftId={value.draftId}
          // Matches `_chat.draft.$draftId.tsx`'s pre-port render exactly — the
          // draft route always forced this, unconditionally, not something
          // this port should silently drop.
          forceExpandedMobileComposer
          reserveTitleBarControlInset={false}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ChatView
        environmentId={value.environmentId}
        threadId={value.threadId}
        routeKind="server"
        threadSyncPhase={value.threadSyncPhase}
        reserveTitleBarControlInset={false}
      />
    </div>
  );
}
