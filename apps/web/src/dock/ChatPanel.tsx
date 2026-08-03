// New for step 1 (spec-dock-step-1.md) — not a port. Wires this fork's real
// `ChatView` into a dockview panel.
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { createContext, useContext } from "react";

import ChatView from "~/components/ChatView";
import type { ThreadSyncPhase } from "~/threadSync";

import type { PanelProps } from "./lib/types";

export interface ThreadRouteContextValue {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  threadSyncPhase: ThreadSyncPhase | null;
}

/**
 * How `ChatPanel` below satisfies the spec's design constraint: "`ChatPanel`
 * must read thread identity from the ROUTE, never from dockview panel
 * params, and no `threadId` may be written into the persisted layout."
 *
 * A React context, provided by `ChatDock` from props the route hands it
 * (see `_chat.$environmentId.$threadId.tsx`), rather than a closure
 * captured at panel-registration time. That choice isn't cosmetic: this
 * panel's `component` reference lives in a registry built ONCE at module
 * scope in `ChatDock.tsx` — so its function identity never changes across
 * a thread switch, and React reconciles it as the same component instance
 * (matching how the route rendered `<ChatView>` directly before this port,
 * with no `key`). If the component itself closed over `environmentId`/
 * `threadId` instead, a fresh closure would be a fresh component identity
 * every navigation, forcing an unnecessary full remount of `ChatView` on
 * every thread switch. Context sidesteps that: same component, same
 * instance, just a different value flowing down.
 *
 * `ChatPanel`'s `params`/`updateParams` (from `PanelProps`) are unused on
 * purpose — nothing here ever calls `updateParams`, which is what keeps
 * `threadId` out of `layout.json`/`localStorage` entirely, not just out of
 * convention.
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
 * why that matters.
 *
 * `reserveTitleBarControlInset={false}`: `ChatView`'s header normally
 * reserves space for Electron's native window-control inset because it
 * doubles as the OS title bar when rendered full-page. Inside a dock panel
 * it is no longer the title bar — the real title bar is above the whole
 * dock, outside this panel — so that reserved space must be turned off or
 * the header shows a dead gap (or, if `SidebarInset`/the route also reserves
 * its own inset above the dock, two stacked title-bar-shaped rows).
 */
export function ChatPanel(_props: PanelProps) {
  const { environmentId, threadId, threadSyncPhase } = useThreadRouteContext();

  return (
    <ChatView
      environmentId={environmentId}
      threadId={threadId}
      routeKind="server"
      threadSyncPhase={threadSyncPhase}
      reserveTitleBarControlInset={false}
    />
  );
}
