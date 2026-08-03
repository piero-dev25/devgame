# FROZEN SPEC — Wave 1 step 2: the `space` aggregate

Intent and acceptance, not implementation. Make the implementation calls
yourself and record the reasoning in comments.

Read `docs/workbench/wave-1-decisions.md` first — the naming call and three
product decisions are already settled there and are not to be re-opened. Step
1 landed in `4414c0630`; `space_id` already exists as a column with nothing
reading or writing it. This step gives it meaning.

## What a space is, and what it must never become

```
project -> space        (ours: a CONTEXT SCOPE with its own event stream)
  -> thread             (T3's, with nullable space_id + nullable task_ref)
```

A space is **a scope, not a container**. This is the whole design and every
invariant follows from it:

- `space_id = null` means **project-wide**. It is a normal, permanent state,
  not "unassigned yet".
- A thread may reference a space **under a different project**. Cross-project
  references are legal by design — a space is context, and context is not
  owned by a directory.
- Re-scoping a thread is a **normal edit**, not a migration. Nothing moves, no
  history is rewritten, no events are replayed. One nullable column changes.
- **Deleting a space must never delete a thread.** Threads that referenced it
  become project-wide. That is not a cascade; it is the scope disappearing and
  the thread falling back to its default.

If any step seems to require ownership semantics — cascading deletes, a thread
"belonging" to exactly one space, moving history — stop and report. That is
the design turning into a container behind our backs.

**Still one aggregate and two nullable columns.** No third column. If you
believe you need one, report instead of adding it.

**Naming:** `space` in code (`SpaceId`, `aggregate_kind = 'space'`,
`projection_spaces`, `space.create`), "Workspace" in UI copy. `workspace` is
already taken in this repo for the project's filesystem root.

## Scope

In:

- the `space` aggregate: commands, events, decider cases, projector cases
- a `projection_spaces` table and its migration
- `space_id` wired through the existing thread path, same as `task_ref` was
- spaces exposed on the wire so a client can list them
- the invariants below

Out — do not build:

- any UI. No panel, no picker, no sidebar entry.
- ICM-on-disk. The event stream is the source of truth for now.
- context resolution — nothing yet _reads_ a space to assemble context.
- anything touching `apps/web/**`.

## The three closed unions

Somewhere in contracts and the event store, `aggregate_kind` and its
neighbours are modelled as a closed `"project" | "thread"` union. A third
stream is not currently representable. Find every one of them and widen them —
there were three at last count, but **verify rather than trusting that number**
and report what you actually find.

The event store table itself needs no migration: `orchestration_events` is
keyed generically on `aggregate_kind / stream_id / stream_version`
(`Migrations/001_OrchestrationEvents.ts`). That genericity is what makes this
additive, and it is worth confirming with your own eyes before you rely on it.

## Invariants

Exactly one is genuinely new: **a non-null `space_id` must reference a space
that exists.** Put it in `commandInvariants.ts` alongside the existing
`require*` helpers and follow their shape.

Deliberately NOT invariants — do not add them:

- that the space belongs to the thread's project (cross-project is legal)
- that a space has at least one thread
- that a thread has a space

Beware the naming trap: `requireActiveProjectWorkspaceRootAbsent` already
exists and concerns the project's **filesystem root**, a completely different
thing. Do not extend it, do not name yours similarly, and consider a comment
distinguishing them since the next reader will assume they are related.

## Acceptance — effect-level

Unit-green is necessary and not sufficient. Every item below is proven by
**raw SQL SELECT** or by observing a real effect, never by asserting a
repository echoed its own input back.

1. **A space exists.** Dispatch `space.create` through the engine; raw-SELECT
   the row out of `projection_spaces`.
2. **A thread can be scoped, unscoped, and re-scoped.** Set `space_id`,
   raw-SELECT it. Update with `undefined` and prove it is UNCHANGED. Update
   with `null` and prove it is project-wide. Re-point it at a different space
   and prove it moved. Same tri-state discipline as `task_ref`.
3. **Cross-project scoping works.** Create two projects, a space under the
   first, a thread under the second, scope that thread to that space, and
   prove it holds. If an invariant rejects this, the invariant is wrong.
4. **Deleting a space does not delete threads.** Scope two threads to a space,
   delete the space, and prove by raw SELECT that both threads still exist and
   are now project-wide. This is the single most important check in the step —
   a cascade here would silently destroy a person's work.
5. **A dangling reference is refused.** Attempt to scope a thread to a
   `space_id` that does not exist and prove the command fails with the
   invariant error rather than writing a dangling row.
6. **It survives replay.** Delete the relevant `projection_state` bookmarks
   AND the projection rows, run bootstrap, and prove everything reconstructs
   from stored events alone.
7. **Old events still decode.** Against the real `.t3-dev` database, which has
   threads created before any of this existed, boot and confirm the projector
   completes and those threads read NULL.
8. Typecheck clean; server suite green.

**Mutation tests, red then restored, for at least these two:**

- make the delete cascade to threads — item 4 must go red
- drop the existence invariant — item 5 must go red

Show me the red output, not a description of it.

## Constraints that will get the work rejected

- **NO git commands of any kind.** No add/commit/stash/checkout/branch/
  restore. The orchestrator owns git. Absolute.
- **Stay in `apps/server/**`and`packages/contracts/**`.** Another
  implementer is in `apps/web/**` in this same checkout.
- Do not weaken, skip or delete an existing test.
- Node 24: `export PATH=/opt/homebrew/opt/node@24/bin:$PATH`.
- **Test-result reporting rule on this machine:** ~1000 leaked node processes
  from unrelated tooling make full-suite runs fail exactly one
  `server.test.ts` test per run, a different one each time. A single
  full-suite failure there is NOT evidence of a regression. Isolate before
  concluding anything (`npx vp test run src/server.test.ts`, ~5s, 120/120),
  and say which you ran when you report a number.
- A dev server is already running on 13773. Do not start a second. Stop by
  exact PID if you must — never `pkill`/`killall`.

## Report

Files changed and why. Verbatim typecheck and test output. For each acceptance
item what you actually OBSERVED — observed vs inferred vs not-run. Both
mutation reds shown explicitly. And say plainly how many closed unions you
found, since I am not certain the number is three.
