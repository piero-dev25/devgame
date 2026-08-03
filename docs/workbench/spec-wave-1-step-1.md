# FROZEN SPEC — Wave 1 step 1: two nullable columns, and `task_ref` end to end

Intent and acceptance, not implementation. Make the implementation calls
yourself and record the reasoning in comments.

Read `docs/workbench/wave-1-decisions.md` first — it records decisions already
taken, including the naming call, so you do not re-litigate them.

## The model, fixed and not up for redesign

```
project -> space        (ours: a CONTEXT SCOPE, its own event stream)
  -> thread             (T3's, plus nullable space_id + nullable task_ref)
    -> agent + subagents (the vendor's business, not ours)
```

**One new aggregate, two nullable columns. Do not grow it.** If a step seems
to need a third column or a second aggregate, stop and report rather than
adding it.

- A space is a **scope, not a container**. `null` means project-wide. Any
  thread may pull context from any space, including one under a different
  project.
- `task_ref` is an **opaque `{source, id}`** pointing at JIRA/Linear/GitHub
  through MCP. It carries no status, no assignee, no title, no due date.
  Adding any of those means we have accidentally started building a task
  tracker, which is explicitly not the product.

**Naming:** the aggregate is `space` in code (`SpaceId`,
`aggregate_kind = 'space'`, `projection_spaces`, `space_id`) and reads
"Workspace" in UI copy. This is because `workspace` is already taken in this
repo and means _the project's filesystem root_ — there is an entire
`apps/server/src/workspace/` module, a `NOT NULL workspace_root` column, a
required `workspaceRoot` contract field, and an invariant
`requireActiveProjectWorkspaceRootAbsent`. Using `workspace` for a second,
different concept would be a lasting confusion.

## Scope of THIS step

Only the storage layer and `task_ref`. **The space aggregate itself is NOT in
this step** — no new event type, no `projection_spaces`, no `space.create`.
This step lands the columns and pushes `task_ref` through the whole existing
path, because it is opaque and has no referential dependency, which makes it
the cheapest way to prove the path end to end before the aggregate widens the
blast radius.

### Part A — migration 036, both columns at once

Add `space_id TEXT` and `task_ref_json TEXT`, both nullable, to
`projection_threads`.

Follow the existing PRAGMA-guarded pattern — read
`PRAGMA table_info(projection_threads)` once, then add each column only if
absent. `Migrations/033_ProjectionThreadsSettled.ts` is the closest precedent;
read it before writing.

Registering a migration takes **two** edits (the import and the
`migrationEntries` array) and the loader keys off `{id}_{name}`. Missing
either is a silent no-op.

**No migration is needed for the event store.** `orchestration_events` is
keyed generically on `aggregate_kind / stream_id / stream_version`
(`Migrations/001_OrchestrationEvents.ts`), which is exactly what makes a third
aggregate additive later.

### Part B — `task_ref` through the command path

Thread it through contracts → decider → projector → SQL projection → read
model, on the existing thread-create and thread-meta-update commands.

Two things that will bite:

- **The payload schemas must be `optional`.** Historical `thread.created`
  events are re-decoded on every projector bootstrap. A required field fails
  decode on every pre-existing event, and the repo's escape hatch for that is
  a payload-rewrite migration (see `011_OrchestrationThreadCreatedRuntimeMode`)
  which we do not want to need.
- **Tri-state, and it is the likely bug.** `undefined` means _leave it alone_,
  `null` means _clear it_, a value means _set it_. These are three different
  things and collapsing any two is the defect this step exists to flush out
  while it is still cheap.

Also note the upsert has a **separate** `ON CONFLICT DO UPDATE SET` list from
its INSERT column list. Omitting a field there means the value inserts once
and then silently never updates again — a real and quiet failure.

## Acceptance — effect-level

Unit-green is necessary and not sufficient.

1. **The column really holds it.** Upsert a thread with
   `taskRef: {source:"linear", id:"ENG-42"}`, then run a **raw SQL SELECT** and
   assert `task_ref_json` is byte-equal to the expected JSON and `space_id` is
   SQL `NULL`. Asserting the repository echoed its own input back proves
   nothing.
2. **Tri-state, proven three ways.** Set a `task_ref`; update the thread with
   `taskRef: undefined` and assert it is UNCHANGED; update with
   `taskRef: null` and assert it is now NULL. All three by raw SELECT.
3. **It survives a replay.** Restart the projector (or run its bootstrap over
   the existing event stream) and confirm the value is still there — this is
   what proves the event payload carries it rather than only the projection
   table.
4. **Old events still decode.** Against a database that already has threads
   created BEFORE this change (the repo's `.t3-dev` has several), boot the
   server and confirm the projector completes with no decode error and those
   threads show `task_ref_json` NULL.
5. `pnpm --filter t3 typecheck` clean, and the existing server test suite still
   green — 4367 tests passed across the repo at Wave 0 baseline; do not
   regress it.

For 1 and 2, write the test so it FAILS if the field is dropped from the
`ON CONFLICT DO UPDATE SET` list. Break it, confirm red, restore, and say so
in your report.

## Constraints that will get the work rejected

- Run **NO git commands of any kind** — no add/commit/stash/checkout/branch/
  restore. The orchestrator owns git. This overrides any convention.
- **Stay out of `apps/web/**`.** Another implementer is working there
concurrently in this same checkout. Your lane is `apps/server/**`and`packages/contracts/**`.
- Do not weaken, skip or delete an existing test.
- Node 24: `export PATH=/opt/homebrew/opt/node@24/bin:$PATH`. Node 25 fails 8
  unrelated web tests for an inert-`localStorage` reason and will look like
  you broke something.
- Do not add a third column or a second aggregate. Report instead.
- If you need to run a server, one is likely already running on 13773; do not
  start a second. Stop by exact PID if you must — never `pkill`/`killall`.

## Report

Files changed and why. Verbatim typecheck and test output. For each acceptance
item, what you actually OBSERVED — distinguish observed from inferred from
not-run. Show the mutation test (red, then restored) explicitly.
