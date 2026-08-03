# FROZEN SPEC — Step 1: the smallest visible dock, with T3's real chat in it

This spec carries intent and acceptance, not implementation. Make the
implementation calls yourself and record the reasoning in comments.

## Goal

Put our dockview-based panel layout on screen inside this fork, on the thread
route, with T3's **real** `ChatView` living inside one of the panels and a
second panel beside it. A person must be able to drag the splitter between
them and have that survive a reload.

This is a port of working layout machinery, not a redesign. The source is the
other repo:

```
SOURCE: /Users/pieroherrera/Projects/gamedev-workbench/.claude/worktrees/substrate-research
        app/web/src/components/layout/**   and   app/web/src/lib/layout/**
TARGET: this repo, apps/web/src/dock/**
```

Read the source files before planning. They are already exercised by tests on
that side; the machinery is sound. What makes this non-trivial is that the
source files carry couplings to _that_ app which must be cut on the way in.

## Non-goals

Do not port any panel components (WorkspaceOverview, TaskBoard, FileTree,
References, Connections, …). They read a data model this fork does not have.
The second panel in step 1 is a placeholder, nothing more.

Do not wire MCP-driven layout mutation. Deferred by the owner.

Do not touch `/settings`, `/connect`, `/pair`, or the draft route. Step 1 is
the one server-thread route only.

## Mount point

`apps/web/src/routes/_chat.$environmentId.$threadId.tsx` — replace the direct
`<ChatView …/>` child of `<SidebarInset>` with the dock, keeping the
`SidebarInset` wrapper.

**Preserve the route's own `h-svh min-h-0 overflow-hidden` classes.** A
reviewer found the plan misattributed these to `SidebarInset`; they are on the
route element itself (`:80`), and `SidebarInset`'s own className has no height
constraint. Dockview collapses to zero height without a definite-height
parent, so losing those classes produces an invisible dock and no error.

Do **not** mount in `AppSidebarLayout.tsx` — that would put the dock on
`/settings`, `/connect` and `/pair` too.

## Five corrections a review pass already found. Do not rediscover them.

1. **`tabContextMenu.ts` is required in step 1.** `DockviewLayout.tsx:31`
   imports `buildTabContextMenuItems` and calls it at `:202-203` inside
   `createDockview()`. Omitting it fails the build. (This was the blocker.)

2. **`LayoutNotice.tsx` imports `IconButton`** from `../ui/IconButton.tsx`,
   which is not part of the layout system and is saturated with our own
   `@theme`-generated Tailwind utilities (`rounded-control`, `ease-wb`,
   `text-text-muted`, …) that do not exist here. Do not port `IconButton`.
   Replace that one usage with this fork's own button primitive.

3. **`tokens-wb.css` needs an import site.** In the source repo the tokens are
   only reachable because `styles/global.css` `@import`s them. Nothing in this
   fork will load them unless you say so explicitly. Without it every
   `var(--wb-*)` in `dockviewTheme.css` resolves to nothing and the dock
   renders unstyled — with no error. Choose an import site and state why.

4. **`--wb-surface-3` does not exist.** `dockviewTheme.css` references it at
   `:120` and `:165`, but the source `tokens.css` never defines it. This is a
   live bug in the source app (tab-action and context-menu hover are silently
   dead there). Define it here rather than porting the bug.

5. **Never bring the `@theme` block from `tokens.css`.** Bring only the raw
   `--wb-*` custom properties. `dockviewTheme.css` consumes them exclusively
   through `var(--wb-*)`, never through a Tailwind utility, so the dock chrome
   themes itself with zero collision. Merging `@theme` would silently restyle
   this entire application — the worst available outcome, because nothing
   would error.

## Two couplings to cut

`DockviewLayout.tsx` statically imports the two most app-coupled files in the
source tree:

- `:23` `createDefaultPanelRegistry` from `./catalog.tsx` (used at `:139` as a
  default) — `catalog.tsx` drags in `AgentSessionProvider`,
  `WorkspaceDataProvider`, `ConnectionsPanel`, `createConnectionsClient` and
  every fixture.
- `:21` `buildCoreCombatPreset` (used at `:168` as a hard-coded fallback) —
  pixel geometry measured against a mock that does not exist here.

Cut both. Make `panelRegistry`, `presetRegistry` and a fallback preset
**required props**. Roughly a ten-line edit, and it is what stops the whole
ICM app becoming a build dependency of this fork.

## Three mechanical sweeps — do them during the copy, not after

- **Strip `.ts`/`.tsx` from every relative import.** The source tsconfig sets
  `allowImportingTsExtensions`; this fork's does not.
- **Repoint `cn`** from the source's `lib/cn.ts` to this fork's `~/lib/utils`.
  Same `(...inputs) => twMerge(…)` signature, so call sites are unchanged.
- **Rewrite Tailwind classes** in `LayoutNotice.tsx`, `QuarantinePanel.tsx`
  and `PanelErrorBoundary.tsx` onto this fork's semantic tokens
  (`border-border`, `bg-card`, `text-muted-foreground`, `text-destructive`).
  These three are the only step-1 files touching token-named utilities.

Expect `lucide-react` icon-name drift between the two repos. Typecheck will
find it.

## Two design constraints that prevent known failures

- **`ChatPanel` must read thread identity from the ROUTE**, never from
  dockview panel params, and no `threadId` may be written into the persisted
  layout. Otherwise a saved layout resurrects a stale thread.
- **Register the chat panel as a singleton.** `ChatView` depends on
  module-level Zustand stores; two instances would share composer state.
  `PanelDefinition` already supports `singleton: true`.

`ChatView`'s header carries an Electron title-bar drag region and native
control inset. Inside a dock panel it is no longer the OS title bar — pass
`reserveTitleBarControlInset={false}` and check you have not produced two
stacked title rows.

## Acceptance — effect-level, in a real browser against a live backend

Unit tests are necessary and not sufficient. All four must pass on a real
thread:

1. **Live chat through the portal.** Send a prompt from the docked chat panel.
   The response streams into the panel **and** that thread's row in T3's left
   sidebar updates. Streaming proves the atom registry reached `ChatView`
   through `createPortal`; the sidebar updating proves it is the _same_
   registry instance, not an isolated one.
2. **It is genuinely a dock.** Drag the splitter, then hard-reload. The split
   is where you left it, and a layout key in `localStorage` shows the new
   proportions in `dockview.grid.root`. Reload-persistence is the proof — a
   drag that does not survive reload proves nothing.
3. **Route is the source of truth.** Click a different thread in T3's left
   sidebar. The docked chat shows that thread, the URL changes, and the dock
   does not remount (the splitter stays put).
4. **No regression outside the dock.** `/settings` and `/connect` render
   exactly as before, with no dock.

Plus `pnpm --filter @t3tools/web typecheck` and `pnpm --filter @t3tools/web
build` clean.

## Constraints that will get the work rejected

- Run **NO git commands of any kind** — not `add`, not `commit`, not `stash`,
  not `checkout`, not `branch`. The orchestrator handles all git. This is
  absolute and overrides any general convention.
- Do not modify anything outside `apps/web/src/dock/**`,
  `apps/web/src/routes/_chat.$environmentId.$threadId.tsx`,
  `apps/web/package.json`, and whichever single CSS entry file you choose for
  the token import (say which and why).
- Do not weaken, skip or delete an existing test.
- Node 24 is required: `export PATH=/opt/homebrew/opt/node@24/bin:$PATH`. Node
  25 fails 8 web tests for an unrelated `localStorage` reason.
- Isolate server state if you run the app: `export
T3CODE_HOME="$PWD/.t3-dev"`.

## Report

Files changed and why. Verbatim output of typecheck and build. For each of the
four acceptance checks, what you actually observed — not what should happen.
If you could not run the browser checks, say so plainly rather than implying
they passed.
