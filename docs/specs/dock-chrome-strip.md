# Spec — hoist the chrome row above the dock (rev 2, post-critique)

Repo: `~/Projects/t3code-fork`, branch `workbench/upstream-20260806`. Owner
(2026-08-10, two screenshots, RELEASE BLOCKER — "we need to solve those two
problems before we post"): (1) stock T3's top row groups traffic lights +
sidebar toggle + logo cleanly; DevGame's dock tabs own the window top and
the traffic lights overlap the "Sidebar" dock tab. (2) The window cannot be
dragged from empty top-strip areas. (3) "When I'm not actually
restructuring a tab, then we don't need to show the different layouts
preview like we have right now" — the mechanism: grabbing "empty" strip
space starts a dockview GROUP DRAG (`.dv-void-container` is a drag source,
drop target, and click-to-activate — voidContainer.js:22-71, `cursor:grab`
dockview.css:3419-3421), which renders the drop-target overlays.

Rev 2 incorporates a fresh-critic review (2 blockers, 7 majors, 5 minors —
all adopted, including its simpler shape). Implementer: the shell grep is
aliased to ugrep and can silently skip directories; verify absences with
/usr/bin/grep.

## Root cause (verified)

- Thread routes bypass `AppSidebarLayout` (`__root.tsx:140-146` wraps only
  `/settings*`); `_chat.tsx:208` renders `SidebarProvider
className="h-dvh! min-h-0!"` with NO `--workspace-controls-left` style
  override; dockview's 36px tab strip is the window's literal top edge
  under macOS `hiddenInset` traffic lights (DesktopWindow.ts:192-211).
- `SidebarChromeHeader` (SidebarChrome.tsx:27-70) is ALREADY the row the
  owner wants — 52px via `--workspace-topbar-height`, `.drag-region` when
  Electron (:47), brand offset past the traffic lights (:78) — but it
  renders INSIDE the sidebar content, below the tab strip, at TWO mount
  points: `Sidebar.tsx:3026` and `LegacySidebar.tsx:3586`.
  (`AppSidebarLayout.tsx:211` is a third, separate instance for the
  settings nav — untouched.)
- A blanket `app-region: drag` on dockview's void space is FORBIDDEN — it
  is dockview's own group-drag/drop surface (the trap above). Record this
  as a comment in dockviewTheme.css.

## Design — one move: hoist the row to the route layer

The change is a HOIST, not a build: `SidebarChromeHeader` moves from the
two sidebar content files to the `_chat.tsx` layout, inside the
`SidebarProvider` (a hard constraint: `--workspace-titlebar-content-left`
is scoped to `[data-slot="sidebar-wrapper"]` — index.css:129-133 — the
brand's traffic-light offset resolves ONLY inside the provider). The truly
new work is the sidebar toggle's target (B1/M10 below).

### A. The strip mount (`_chat.tsx`)

- `SidebarProvider` at `_chat.tsx:208` gains `flex-col` (its base wrapper
  is a flex ROW — ui/sidebar.tsx:158-165 — a child strip would otherwise
  become a left column; critique M4) and the mac inset style: extract
  AppSidebarLayout's inline mapping (:148-153) into a PURE resolver
  `resolveWorkspaceChromeInsetStyle({isMacDesktop, isFullscreen})` (unit-
  tested red-first, asserted byte-equal to AppSidebarLayout's current
  values) plus a small hook owning the `desktopBridge.
onWindowFullscreenStateChange` subscription (preload.ts:120 — global,
  reusable). AppSidebarLayout consumes the same helper (no behavior
  change there).
- Render the strip as the provider's first child, ABOVE `<Outlet/>` — so
  it covers ALL `_chat` children: the thread route (including its
  loading/empty states, which today render NO dock — critique M6), the
  index route, and draft routes. `_chat.index.tsx`'s hosted-static shape
  (:144-160, its own header with no drag-region) must not double-stack:
  verify and dedupe its header against the strip (smallest change wins;
  state what shipped).
- Gate: the strip renders when `isElectron` (it self-sizes on
  Windows/Linux: `.wco` redefines `--workspace-topbar-height` to
  `env(titlebar-area-height, 52px)` — index.css:135-136); ONLY the 90px
  mac inset gates on `isElectron && isMacPlatform` (critique m11). Give
  the strip right-edge padding via `--workspace-native-controls-inset`
  (index.css:141-144) so Windows overlay buttons don't collide. Non-
  Electron web build: strip absent — today's behavior exactly.
- Contents: `SidebarBrand` (as today via SidebarChromeHeader) + the
  sidebar toggle (below). The whole row keeps `.drag-region` (existing
  class; its interactive-children carve-out at index.css:1482-1488 keeps
  the toggle clickable). Problem (2)'s fix: the entire top edge is
  draggable except controls.
- Layout math (critique M3 — a proven overflow, not a "verify"): the dock
  root's `h-full` (DockviewLayout.tsx:1214) inside the route's
  `overflow-hidden` SidebarInset would clip 52px off the BOTTOM (the
  composer's edge). Change the dock root class to `min-h-0 flex-1` on
  this path — an explicit class change, not a tailwind-merge accident.

### B. The dedupe (critique B2 — smaller than rev 1 proposed)

- DELETE the `<SidebarChromeHeader …/>` line from BOTH `Sidebar.tsx:3026`
  AND `LegacySidebar.tsx:3586` (the legacy sidebar is user-reachable via
  Settings → Legacy features and would otherwise keep the duplicate),
  each with a dated supersession comment pointing at the strip. NO prop,
  NO wrapper — the "legacy AppSidebarLayout path" for these two files is
  dead code at HEAD (AppSidebarLayout.tsx:215 is the `!isOnSettings` arm,
  unreachable). `AppSidebarLayout.tsx:211`'s own instance stays.

### C. The sidebar toggle (critique B1 + M10 — the genuinely new work)

- The toggle must HIDE, not close: `toggleChatDockPanel`'s close path
  (openPanel.ts:71) ignores `closeable: false`, and the Sidebar panel's
  `closeable: false` is load-bearing (ChatDock.tsx:180-185 — the thread
  prev/next and Cmd+1..9 window keydown listeners live only while the
  panel is mounted: Sidebar.tsx:2962, LegacySidebar.tsx:3452); a
  positionless re-open would land the sidebar as a TAB next to Chat
  (openPanel.ts:29-37 + activeGroup=CHAT, ChatDock.tsx:452). Implement a
  dock-side HIDE/SHOW for the sidebar GROUP (dockview group visibility /
  size-to-zero — find the cleanest supported dockview-core@7.0.4 API;
  the panel stays MOUNTED throughout, listeners survive, and the column
  returns to its own slot on show). Record in a comment why close/reopen
  is forbidden here (cite ChatDock.tsx:180-185).
- `SidebarControl`/`SidebarTrigger` cannot be reused verbatim
  (SidebarControl is `fixed`-positioned; SidebarTrigger hardcodes
  `useSidebar().toggleSidebar` — ui/sidebar.tsx:320-333). Refactor them
  to accept `onToggle`/`pressed` props (small, real refactor). The strip
  button AND the `sidebar.toggle` keybinding (Mod+B,
  keybindings.ts:22 — currently handled only inside AppSidebarLayout, so
  ALREADY dead on thread routes) both point at the SAME dock-side toggle.
  Do NOT touch SidebarProvider open state on thread routes (critique m13:
  `COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS` consumers key off it;
  half-wiring two sidebar concepts is the trap — record this in a
  comment).

### D. Cleanups riding along

- Inner panel headers LOSE the now-misleading `drag-region` class:
  `ChatView.tsx:6314` and `DiffPanelShell.tsx:16` keep their height and
  content, lose the class (critique M7 — with the strip above, their drag
  claim is redundant; the visible chrome stack strip 52 + tabs 36 +
  panel topbar 52 is ACCEPTED for now as the cost of the dock being a
  first-class feature, stated here so the owner adjudicates it seeing the
  build; `RightPanelTabs.tsx:304`'s conditional stays — it renders in
  non-dock contexts).
- Delete the dead `electron-drag-region` div (PreviewPanelShell.tsx:57 —
  zero-height, class defined nowhere; critique m12).
- dockviewTheme.css gains the void-space-trap comment (why app-region
  never goes on dockview elements).
- Note in the commit message: the strip likely closes #127 as a side
  effect (DockControlsCluster's absolute top-right corner moves out of
  the Windows WCO area once the dock starts lower — critique m11).

## Tests

- Pure: `resolveWorkspaceChromeInsetStyle` red-first against
  AppSidebarLayout's current inline values (mac / non-mac / fullscreen).
- Render (renderToStaticMarkup): the strip's presentational content
  renders with `.drag-region` + brand; Sidebar/LegacySidebar content no
  longer contains the interior chrome header (anchored absence). Budget
  warning (critique m15): `SidebarBrand` uses a router `<Link>` and
  `SidebarTrigger` needs provider context, with no in-repo router-mock
  precedent — test a presentational sub-component or add the mock; do
  not fight renderToStaticMarkup with hooks.
- Fullscreen listener wiring is UNTESTABLE in this harness (useEffect
  never runs) — owner-eye acceptance item, stated plainly.
- Full web suite green; typecheck exit 0.

## Acceptance (packaged build, commit named)

1. Visual: traffic lights sit in the clean strip with toggle + brand — no
   dock tab under them (owner-eye + driver accessibility excerpt).
2. Window drag (owner-eye): grabbing anywhere on the strip moves the
   window; grabbing a tab still drags the TAB.
3. Toggle: strip button and Mod+B both hide/show the sidebar column; after
   hide+show the sidebar is back in its own LEFT slot (not a tab next to
   Chat); thread prev/next + Cmd+1..9 still work AFTER a hide/show cycle
   (the listeners survived).
4. THE OWNER'S GESTURE, re-run at the new position (critique M8): grab the
   void space beside the Browser tab (now 52px lower) — record what
   happens (group drag with overlays is dockview's intended affordance,
   kept by this spec) so the owner adjudicates the residue explicitly.
5. macOS fullscreen (owner-eye): traffic lights auto-hide and the strip's
   90px inset drops.
6. Dock functionality unchanged: tabs still move between groups; floating
   groups stay below the strip (critique m14 verified no risk).
