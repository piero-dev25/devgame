/**
 * Which authenticated routes render inside `AppSidebarLayout` (upstream's
 * fixed, resizable sidebar) instead of the DevGame dock.
 *
 * Thread routes (`/`, `/draft/$draftId`, `/$environmentId/$threadId`) are
 * dock routes: `_chat.tsx` provides a bare `SidebarProvider` and the thread
 * sidebar is a dock panel. Pages with no dock still need upstream's sidebar
 * host: settings, the usage page, and the pull-request list (a `_chat` child
 * that `_chat.tsx` then leaves to `AppSidebarLayout`).
 *
 * One predicate for `__root.tsx` and `_chat.tsx`, so the two cannot disagree
 * about who owns the sidebar (and its Mod+B toggle) on a given page.
 */
export function routeUsesAppSidebarLayout(pathname: string): boolean {
  return (
    pathname === "/settings" ||
    pathname.startsWith("/settings/") ||
    pathname === "/usage" ||
    pathname === "/pull-requests"
  );
}
