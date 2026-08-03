# Staying mergeable with T3

Adapted from [up.computer](https://github.com/krl-gr/upcomputer), another fork
of T3 Code solving the same problem. Their `docs/upstream-strategy.md` is the
source for most of what follows; the gap analysis is ours.

Their stated aim could be ours verbatim: keep the upstream runtime, provider
orchestration, contracts, desktop infrastructure and release plumbing **close
to upstream**, while diverging in product direction, UI and workflow.

## The rules

**Merge on a cadence, every 1–2 weeks during active development.** Drift is
cheap to reconcile weekly and expensive to reconcile quarterly. On a dedicated
branch, never mixed with feature work:

```
git fetch upstream --prune
git switch -c sync/upstream-YYYY-MM-DD
git merge upstream/main
# resolve, verify, review the diff, then merge back
```

**Full merges for runtime changes.** Cherry-pick only urgent bug fixes and
isolated security fixes — cherry-picking broad runtime changes is risky.

**Never encode product decisions inside deep runtime modules.** Local changes
belong in dedicated product-layer files and in our own wrapper components, not
scattered through upstream internals.

**Keep upstream subsystems intact. Hide, don't delete.** Removing an unwanted
feature means conflicting with every future upstream change to it. Hiding its
entry point costs one line.

**Extract local UI into small components** rather than repeatedly rewriting
large upstream files.

**Known high-conflict files** in this codebase, from their experience:
`Sidebar.tsx`, `ChatComposer.tsx`, `ChatView.tsx`, styling, settings.

## Where we already comply

Measured against `69dfb7f09`, first at 82 files / 7,848 insertions / **104
deletions**, and again after the editor-presence work at 153 files / 18,320
insertions / **106 deletions**. The fork more than doubled in size and added
**two** deletions. Almost purely additive, and staying that way under growth is
the part that matters.

- **Our dock is 36 self-contained files** under `apps/web/src/dock/`. Zero
  merge surface. This is exactly "extract local UI into small components".
- **We delete essentially nothing of theirs** — 104 deletions across the whole
  fork, and the owner's standing rule already forbids it. Their "hide, don't
  delete" reaches the same conclusion independently.
- **We touch T3's web files only at mount points** — 6 to 35 lines each in the
  routes, 19 in `AppSidebarLayout`. Small and re-appliable.
- **A live `git merge-tree` against `upstream/main` returns zero conflicts**
  today.

**The first real test of the "small mounts" rule, and it passed.** As of
2026-08-03 the fork is 153 files / 18,320 insertions / 106 deletions off
`69dfb7f09`, and the editor-presence work added mounts to BOTH named
high-conflict files. The one upstream commit since our base
(`30c962280`, "polish interface spacing") happens to touch
`ChatView.tsx` and `ChatComposer.tsx` — _exactly_ the two files we edited.

`git merge-tree --write-tree HEAD upstream/main` still reports **zero
conflicts**, because our edits total 15 inserted lines and sit in different
regions from theirs: one import plus a three-line conditional in the composer,
two imports plus one wrapping call in `ChatView`.

This is the concrete argument for the rule. Had the presence chips been
implemented _inside_ those components rather than mounted into them, the same
upstream commit would have conflicted. Keep the mount to a call; keep the
logic in our own directory.

## Where we do not comply

**`packages/contracts/src/orchestration.ts`: +132 lines in a file upstream
changes ~29 times per four months.** Our biggest edit in one of their hottest
files, and the clearest violation of "avoid deep runtime modules". The goal
document itself said _"never edit packages/contracts"_ and we did it anyway,
without noticing until the owner asked whether we were still mergeable.

This came from adding the `space` aggregate: an event-sourced system needs its
contracts to know an event type exists. Worth investigating whether our schemas
could live in a package of ours that composes with theirs. If Effect Schema
allows it, that removes our single worst merge liability.

The server-side spread is the same story more diffusely — `decider.ts` (+87),
`projector.ts` (+51), `ProjectionSnapshotQuery.ts`, `commandInvariants.ts`
(+80). Adding an aggregate necessarily reaches these, but we should know it is
a cost we are paying rather than assume it is free.

**No merge cadence.** We have merged upstream zero times. It is clean right
now, which is the best possible moment to start the habit rather than the
excuse to defer it.

**No product-layer convention.** We have no equivalent of their
`productConfig.ts` / `productFeatures.ts` / `productCopy.ts`. Worth adopting
before product decisions start leaking into upstream files, which is the point
at which it becomes expensive.

## Verification after a merge

Their post-merge checks, translated to this repo's tooling:

```
pnpm fmt        # or vp fmt
pnpm lint
pnpm typecheck
pnpm test
```

Node 24 is required — node 25 fails 8 web tests for an unrelated inert
`localStorage` reason and will look like the merge broke something.
