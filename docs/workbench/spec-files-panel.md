# FROZEN SPEC — the first real panel: Files, on live git status

Intent and acceptance, not implementation.

This is the step where the dock stops being a container for T3's chat and
starts being a workbench. Every panel we have on our side is fixture-fed; this
one reads the fork's **real** VCS state.

## Goal

A `Files` dock panel showing the actual working-tree status of the thread's
project, live — updating when files change on disk, without a manual refresh.

Register it in the panel catalog so it can be added and moved like any other
tab, and put it in the default preset in the placeholder's current slot.

## Do not port our component

Our `FileTree.tsx` takes `FileTreeNode[]` with a `FileStatus` of `M/A/D/R/?`,
synthesized from ICM fixtures. Do not adapt it. Read the fork's real shape
first and build the panel around **that**, borrowing from ours only where the
rendering genuinely fits.

Fitting a real data source to a fixture-shaped component is how you end up
with a panel that displays a lie convincingly.

## What the fork actually has — verify before you build on it

A prior read established the following. Spot-check, do not assume:

- `packages/contracts/src/git.ts` — `VcsStatusLocalShape.workingTree.files`
  carries `path`, `insertions`, `deletions`. Note what is **not** there: a
  porcelain status code. Whether a file is modified/added/deleted/renamed is
  not directly in that shape, and you must determine what actually is
  available rather than inventing a mapping.
- `packages/client-runtime/src/state/vcs.ts` — `subscribeVcsStatus` /
  `vcs.status` is a **live subscription**, which is what makes "no manual
  refresh" achievable. Find how other consumers subscribe and follow that.
- **Untracked files ARE representable.** An earlier plan claimed a diff cannot
  contain a file git has never seen; that is wrong.
  `apps/server/src/vcs/GitVcsDriverCore.ts:2089` (`readUntrackedReviewDiffs`)
  runs `git diff --no-index -- /dev/null <path>` per untracked file and folds
  the result into the dirty diff. So an untracked state is available if you
  want it — confirm how, rather than trusting either claim.

**If the real data cannot express something, show less rather than guessing.**
A panel that omits a status is honest; one that infers a wrong status is not.
Say plainly in your report what you could not represent.

## Scope

In:

- one new panel, registered in the catalog, added to the default preset
- live updates via the existing subscription
- an empty state (clean tree) and an error state that says what went wrong

Out — do not build these now:

- diffs, staging, committing, discarding, or any write operation
- file opening or navigation
- multi-project or cross-environment aggregation

The panel is **read-only**. It reports; it does not act.

## Constraints

- Layouts stay data. Register through the panel catalog and put it in the
  preset's `SerializedDockview`. Do not hardcode an arrangement.
- Do not modify anything under `packages/client-runtime/**`. If the
  subscription you need is not exported, report that rather than editing
  their package.
- Reuse the fork's own UI primitives and semantic tokens (`border-border`,
  `bg-card`, `text-muted-foreground`). Do not bring our `--wb-*` Tailwind
  `@theme` block — the raw custom properties in `tokens-wb.css` exist only for
  dockview's own chrome.
- Prefer a `singleton: true` registration unless you can argue two Files
  panels are useful. The guard is enforced now, so this is real.

## Acceptance — effect-level, in a real browser

**One browser tab.** Two tabs on one origin contend for the environment
connection and present as an app that loads but never receives data.

The scratch project `wb-e2e` is at
`/Users/pieroherrera/.claude/jobs/d1eda764/tmp/wb-e2e` and is a real git repo.
Use it.

1. **It shows real, current state.** With a clean tree the panel shows its
   empty state. Modify a file on disk from the terminal; the panel reflects it
   **without a manual refresh**. Say how long it took.
2. **It distinguishes what it claims to.** Create a new untracked file, modify
   a tracked one, and delete a tracked one. Report exactly what the panel shows
   for each. If it cannot tell them apart, say so — that is a finding, not a
   failure.
3. **It is a real panel.** Drag it to another position, reload, and confirm it
   comes back where you put it.
4. **It degrades honestly.** Point a thread at a project directory that is not
   a git repository, or otherwise force the status call to fail. The panel must
   show an error state that says what happened — not an infinite spinner, not
   an empty list implying a clean tree. This is the check most likely to
   expose a wrong assumption; do not skip it.
5. No regression: `/settings` unaffected, existing suite still green.

Restore `wb-e2e` to a clean tree afterwards.

## Constraints that will get the work rejected

- **NO git commands of any kind** in the fork repo — no add/commit/stash/
  checkout/branch/restore. The orchestrator owns git.
  You WILL need git commands inside the scratch repo `wb-e2e` to create test
  states; that is fine and expected. Never in `t3code-fork`.
- Another implementer is working in `apps/server/**` and
  `packages/contracts/**`. Stay in `apps/web/**`. If the backend restarts
  under you mid-check, that is them — reload and continue, do not diagnose it.
- Node 24: `export PATH=/opt/homebrew/opt/node@24/bin:$PATH`.
- Do not weaken, skip or delete an existing test.

## Report

Files changed and why. Verbatim typecheck/build/test output. For each
acceptance item what you actually OBSERVED, separating observed from inferred
from not-run. And state plainly which file states the panel can and cannot
distinguish — that honesty is worth more to me than a panel that looks
complete.
