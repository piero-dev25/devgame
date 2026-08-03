# FROZEN SPEC — Step 2: everything is a tab (sidebar included), and draft parity

Intent and acceptance, not implementation. Make the calls yourself and record
the reasoning in comments. Step 1 landed in `2865d135f` and its E2E evidence
is in `docs/workbench/dock-step-1-e2e-evidence.md` — read that first, it
records what is already proven so you do not re-litigate it.

## The owner's goal, in his words

> "i have the feeling we will implement the sidebar as something you can move
> around too (like unity hiearchy or project tabs) all these things are tabs."

Unity's model: Hierarchy, Project, Inspector, Scene, Game are all tabs; where
they sit is a layout; layouts are saved and switchable. We already have the
machinery — presets are `SerializedDockview`, so layouts are data, and
`tabContextMenu.ts` already offers "Add tab: <title>".

What is missing is that T3's sidebar is still outside the dock, pinned by
`AppSidebarLayout`. This step puts it inside as an ordinary panel.

## Part A — T3's sidebar becomes a dock panel

A prior read-only investigation established the following. Treat these as
known-good; verify cheaply if you like, but do not re-derive them.

- **The sidebar CONTENT is container-agnostic.** Neither `Sidebar.tsx` nor
  `SidebarV2.tsx` contains viewport-relative positioning. What is
  viewport-locked is the _wrapper_, `components/ui/sidebar.tsx`'s `<Sidebar>`
  (`fixed inset-y-0 … h-svh`), together with `<SidebarRail>`, which owns
  drag-to-resize (raw pointer events writing a CSS custom property) and
  cookie-backed collapse.
  **So: do not reuse that wrapper.** Host the content bare in a dock panel and
  let dockview own sizing and visibility.
- **It must stay under `SidebarProvider`.** Both content components call
  `useSidebar()` for `{isMobile, setOpenMobile}`, which throws outside the
  provider. `AppSidebarLayout` already wraps BOTH the sidebar shell and
  `{children}` in `SidebarProvider`, and React context is not
  DOM-position-dependent, so a panel rendered inside `{children}` — including
  through `createPortal` — still sees it. Confirm this holds where you mount.
- **There are TWO live sidebars.** `Sidebar.tsx` (v1, ~3638 lines) is the
  production default and is forced on `/settings*`; `SidebarV2.tsx` (~3217)
  is the dev/nightly default elsewhere, switched by `useSidebarV2Enabled()`.
  Decide which one the dock panel hosts and say why. Do not try to host both.
- **Register it as a NO-CLOSE tab** (`TAB_COMPONENT_NO_CLOSE`, as step 1 does
  for chat). This is deliberate and load-bearing: two `window` keydown
  listeners for thread prev/next and Cmd+1..9 thread-jump live _inside_ the
  sidebar content (`Sidebar.tsx:3405-3471`, `SidebarV2.tsx:2499-2536`), with
  no other registration site. A tab that cannot be closed never unmounts, so
  those shortcuts cannot silently disappear. Lifting them into an app-level
  hook is a later step; do not attempt it here.
- **Do not enable multi-instance.** `SidebarV2.tsx:2778` hardcodes
  `id="sidebar-thread-search-results"`, which would collide. Mark the panel
  `singleton: true`.

**The default layout must still look like today**: sidebar on the left, chat
to its right. The difference is that it is now a tab a person can drag
elsewhere. Same pixels, new capability.

`/settings`, `/connect` and `/pair` must keep rendering T3's normal
`AppSidebarLayout` sidebar exactly as they do now. Only the thread routes get
the docked one. If that means the sidebar renders through `AppSidebarLayout`
on some routes and through the dock on others, say so explicitly in a comment
— that duality is a real cost and should be visible to the next reader.

## Part B — draft-route parity

`apps/web/src/routes/_chat.draft.$draftId.tsx` still renders `ChatView`
directly. Give it the same dock treatment as the server-thread route.

`ChatView`'s props are a discriminated union on `routeKind`
(`ChatView.tsx:465-485`), so the chat panel needs the same union rather than a
second component. A draft promotes to a real thread mid-session (the navigate
is at `_chat.draft.$draftId.tsx:40-60`) — **the layout must not reset at that
moment.** Choose a dock identity that is stable across the promotion and
explain the choice.

## Part C — one small correctness fix

`ChatView`'s header carries an Electron title-bar drag region and native
control inset (`ChatView.tsx:5742-5755`). Inside a dock panel it is no longer
the OS title bar. Step 1 already passes `reserveTitleBarControlInset={false}`;
confirm there are not two stacked title rows now that a tab strip sits above
it, and fix if there are.

## Acceptance — effect-level, in a real browser

**Use exactly ONE browser tab on the origin.** Two tabs on one origin contend
for the environment connection and present as an app that loads but never
receives data, with no error anywhere. This cost the previous round hours.

1. **The sidebar is a real tab.** Drag it out of its default position and dock
   it on the opposite side. The project/thread list still works from its new
   home: clicking a thread navigates, and the chat panel follows.
2. **It survives a reload where you put it.** Hard-reload; the sidebar is
   still where you dragged it, and the persisted layout JSON shows it there.
3. **Shortcuts still work.** With the sidebar docked, Cmd+1 (thread jump) and
   thread prev/next still navigate. This is what the no-close decision buys —
   prove it rather than assume it.
4. **Draft parity.** Start a new thread, confirm the dock is present on the
   draft route, send a prompt, and confirm the layout does NOT reset when the
   draft promotes to a real thread.
5. **No regression.** `/settings` still renders T3's own sidebar, normally,
   with zero dockview roots.

Plus `pnpm --filter @t3tools/web typecheck` and `pnpm --filter @t3tools/web
build` clean.

## Constraints that will get the work rejected

- Run **NO git commands of any kind** — no add/commit/stash/checkout/branch/
  restore. The orchestrator owns git. This overrides any general convention.
- Do not weaken, skip or delete an existing test.
- Node 24: `export PATH=/opt/homebrew/opt/node@24/bin:$PATH`. Node 25 fails 8
  unrelated web tests via an inert `localStorage` global.
- Do NOT set `T3CODE_HOME` or `--home-dir`. A dev server already runs against
  the repo's `.t3-dev`; reuse it. If you must restart, stop it by exact PID
  (`lsof -nP -iTCP -sTCP:LISTEN | grep 13773`) — never `pkill`/`killall`,
  which has killed Chrome on this machine before.
- Keep layouts as data. Do not hardcode an arrangement as JSX or flexbox — a
  later step wires an agent to rewrite layouts, and that only stays cheap if
  presets remain `SerializedDockview` and the panel catalog stays a registry.

## Report

Files changed and why. Verbatim typecheck and build output. For each of the
five acceptance checks, what you actually OBSERVED — distinguish observed from
inferred from not-run. If you could not run a check, say so plainly rather
than implying it passed.
