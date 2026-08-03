# FROZEN SPEC — delete our Files panel, promote T3's surfaces to dock panels

Intent and acceptance, not implementation.

## The observation this comes from

The owner noticed T3 already has a Files tab with a diff, and asked whether we
need ours. Investigating it produced something bigger:

**T3's right panel is already a dock.** `RightPanelTabs` manages surfaces of
kind `diff`, `files`, `file` and `terminal`, with close, close-others and
close-to-the-right. It is a tab strip with tab management.

So we did not add a dock to an app that lacked one. We added a **second** dock
around the one it had. That single fact explains every symptom a fresh critic
found: two tab strips thirty pixels apart, two things called "Files", a `+` on
theirs and right-click-only on ours, and the conversation squeezed into a
fifth of the window.

## Part A — delete our Files panel

Ours is strictly worse, demonstrated on the same screen at the same moment:

- T3's file tree showed the correct file list; ours listed a file that **did
  not exist** and reported changes to a file identical to HEAD.
- T3's diff surface correctly said "No net changes"; ours had no diff at all.
- T3 has a refresh control. Ours has none, and no way to know it is stale.

Delete `FilesPanel.tsx`, `FilesPanel.logic.ts`, `FilesPanelBody.tsx` and their
tests. Remove the registration and take it out of the default preset.

This is the goal's "deleting our code is a WIN" in its purest form: a thing we
wrote, replaced by a thing of theirs that real users already exercise and that
is simply better. It is not a defeat and should not be softened in the commit
message.

Keep the removal honest: if anything in the dock depended on it, say so.

## Part B — promote T3's surfaces to dock panels

Deleting ours and stopping there would quietly exclude files, diffs and the
terminal from the "everything is a tab" model — which is most of what a game
developer actually looks at. T3's surfaces currently cannot be dragged,
redocked or tabbed alongside anything else, because they live inside
`ChatView`'s right panel.

So: make `diff`, `files`, `file` and `terminal` first-class dock panels.

**Do not delete `RightPanelTabs` or the surface components.** We are changing
where they render, not removing them. The owner's rule stands: we delete our
code, never theirs.

### The hard part, and the reason this is a spec rather than a ticket

Two sources of truth for "what is on screen":

- `rightPanelStore` — a global Zustand store owning which surfaces are open,
  which is active, and their order.
- the dockview grid — owning the same questions for panels.

Two stores answering one question is exactly the state-desync class that
produces bugs nobody can reproduce. **Resolving that is the actual work.**

Decide deliberately and write down why:

- Does the dock become the single source of truth, with `rightPanelStore`
  reduced to per-surface content state?
- Or does the store stay authoritative, with the dock reflecting it?
- What happens when a surface is opened programmatically — "open this file",
  "show this diff" — while its panel is closed, or in a different group?
- What happens to a persisted dock layout referencing a surface that no longer
  exists (a deleted file, a closed terminal)?

**A one-way sync is far safer than a two-way one.** If you find yourself
writing reconciliation in both directions, stop and reconsider.

Start with the SMALLEST surface that proves the pattern. Probably `files`, since
it is the one we are replacing and its behaviour is already understood. Get one
surface working as a dock panel end to end before touching the rest, and report
before continuing.

## Acceptance — effect-level, one browser tab

1. **Ours is gone and nothing references it.** No "Files" panel of our making,
   no dead registration, no orphaned imports.
2. **T3's files surface works as a dock panel.** Drag it to another position,
   reload, and it is where you put it — the thing it could never do before.
3. **It is still correct.** Modify a file on disk, use T3's refresh, and the
   panel reflects reality. This is the specific failure ours had; the ported
   surface must not inherit it.
4. **Only ONE tab strip is visible** on a thread route. If T3's own strip still
   renders somewhere, say where and why.
5. **Opening a surface programmatically still works** — whatever action opened
   a diff before must still open it, and land in the dock.
6. **No regression:** chat still streams in its panel, the sidebar still works
   as a tab, `/settings` still dock-free, suite green.

## Constraints

- NO git commands of any kind in this repo.
- Do not delete or gut T3's surface components or `RightPanelTabs`.
- Layouts stay data — register through the catalog, place via the preset.
- One browser tab. Node 24.
- Do not weaken or delete an existing test.

**Sequencing note:** the bricking fix (empty-layout guard, `tabContextMenu`
respecting `tabComponent`) lands FIRST. Do not start this until that is
committed — building on a dock that can be permanently destroyed in three
clicks wastes both efforts.

## Report

What you deleted and what replaced it. The state-ownership decision and its
reasoning. For each acceptance item, what you OBSERVED. And say plainly
whether the result reads as one system or still two — that is the whole point
of the change.
