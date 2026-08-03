// New for step 2 (spec-dock-step-2.md, Part A) — not a port.
//
// Hosts T3's real sidebar CONTENT as an ordinary dock panel. Per the spec's
// prior investigation (treated as known-good, spot-checked below rather than
// re-derived):
//
// - Neither `Sidebar.tsx` (v1) nor `SidebarV2.tsx` contains viewport-relative
//   positioning — that lives entirely in `components/ui/sidebar.tsx`'s
//   `<Sidebar>` wrapper (`fixed inset-y-0 … h-svh`) and `<SidebarRail>`. So
//   this panel does NOT render `<Sidebar>` — it hosts the resolved sidebar
//   content directly, inside dockview's own panel host div (already
//   `height:100%; width:100%` per reactContentRenderer.tsx), and lets
//   dockview own sizing/visibility.
// - Both content components' top-level return is a bare `<>...</>` fragment
//   (a header + scrollable body as flex siblings), which only lays out
//   correctly under a `display:flex; flex-direction:column; height:100%`
//   parent — normally supplied by `<Sidebar>`'s own inner wrapper
//   (`data-slot="sidebar-inner"`, `flex h-full w-full flex-col bg-sidebar
//   surface-grain`). Replicated here directly (spot-checked: neither
//   Sidebar.tsx nor SidebarV2.tsx references any `group-data-[...]` selector
//   that `<Sidebar>`'s own wrapper divs would have supplied — bare hosting
//   doesn't silently break either one's internal styling). `bg-sidebar
//   surface-grain` are carried over too, purely for "same pixels, today" —
//   without them the panel's background would just show through to
//   whatever's behind it instead of the sidebar's own tone.
// - The `data-sidebar`/`data-slot="sidebar-inner"` markers are kept for the
//   one other consumer found (`~/hooks/useTheme.ts`'s
//   `resolveBrowserChromeSurface`, a `[data-slot='sidebar-inner']` fallback
//   selector) — moot in practice on thread routes, since that function
//   checks `[data-slot='sidebar-inset']` (the main content area, still
//   present) first and always finds it, but free to preserve.
// - Deliberately NOT `border-r border-sidebar-border`: the dock's own group
//   chrome (`dockviewTheme.css`'s `.dv-groupview` border) already draws the
//   separator between this panel and its neighbour — adding a second one
//   here would double it.
import { useThreadSidebarComponent } from "~/hooks/useThreadSidebarComponent";

/**
 * Which of T3's two live sidebars this panel hosts: WHICHEVER
 * `useThreadSidebarComponent()` resolves — the same flag `AppSidebarLayout`
 * already reads, via the shared hook `AppSidebarLayout.tsx` was itself
 * rewritten to use (spec-dock-step-2.md, owner correction — the earlier
 * draft of this file hardcoded `SidebarV2` and reasoned "decide one, do not
 * host both"; the owner overruled that: both sidebars stay live, neither
 * gets deleted or picked-once, the dock hosts whichever the flag currently
 * selects). No `forceV1` passed — the dock never mounts on `/settings*`,
 * which is the only context where that override applies.
 */
export function SidebarPanel() {
  const ThreadSidebarComponent = useThreadSidebarComponent();

  return (
    <div
      className="flex h-full w-full flex-col bg-sidebar text-sidebar-foreground surface-grain"
      data-sidebar="sidebar"
      data-slot="sidebar-inner"
    >
      <ThreadSidebarComponent />
    </div>
  );
}
