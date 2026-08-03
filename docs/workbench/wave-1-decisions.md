# Wave 1 — decisions taken, and the one I want the owner to confirm

A research pass produced an implementable work order for the workspace
aggregate and surfaced four questions as "owner decisions". Three of them I
have decided, because the goal already answers them and a competent reader
would reach the same place. One is a genuine naming call the owner should see.

## The naming collision — decided, but flag it

`workspace` is already a heavily loaded word in this codebase, and it means
**the project's filesystem root**, not a context scope:

- an entire server module, `apps/server/src/workspace/` (`WorkspacePaths.ts`,
  `WorkspaceFileSystem.ts`, `WorkspaceEntries.ts`, `WorkspaceSearchIndex.ts`)
- a `NOT NULL` column `workspace_root` on `projection_projects`
  (`Migrations/005_Projections.ts:11`)
- a required contract field `workspaceRoot`
  (`packages/contracts/src/orchestration.ts:943`)
- the invariant `requireActiveProjectWorkspaceRootAbsent`
  (`commandInvariants.ts:75`)
- 68 files under `apps/web/src` that mention it

**Decision: the aggregate is `space` in code — `SpaceId`,
`aggregate_kind = 'space'`, `projection_spaces`, `space.create`, `space_id` on
threads — and reads "Workspace" in every piece of UI copy.**

This is free today and expensive after it ships (a migration plus an
event-payload rewrite). If the owner would rather the code word match the
product word, say so before the aggregate lands and it costs nothing.

## Decided: workspaces are user-created, not derived from task sources

The question was whether a workspace is a thing a person makes and names, or
something auto-derived from `task_ref` (one per Linear project, per Jira
epic).

**User-created.** The goal defines the workspace as ICM on disk with its own
event stream, and defines `task_ref` as a separate, opaque `{source,id}`
living on the _thread_. Deriving workspaces from task sources would fuse two
things the goal deliberately keeps apart, and would make the workspace tree a
function of whatever tracker happens to be connected — which is exactly the
"building a task tracker by accident" failure the goal warns against.

## Decided: a thread can be re-scoped, and nothing moves

**Yes, re-scopable via `thread.meta.update`, with no history rewrite.** The
goal is explicit that a workspace is a CONTEXT SCOPE and not a container, that
`null` means project-wide, and that any thread may pull context from any
workspace. Scope that cannot be changed is a container wearing a different
name. Re-scoping updates one nullable column; no events move, nothing is
rewritten.

## Decided: T3's right rail keeps working, the dock does not retire it

The question was whether our dock's panels replace `ChatView`'s own
right-panel surfaces or coexist — framed as "the difference between one
workbench and two nested panel systems".

**Coexist for now.** The owner has ruled: _"Dont delete t3 stuff if we don't
need to."_ Retiring the right rail on thread routes is a deletion of working
T3 behaviour affecting every existing user, and we do not yet know enough to
say ours is better. Revisit once our panels carry real data and can be
compared honestly.

This is a real cost, recorded rather than hidden: until it is revisited, a
thread route can show two panel systems at once.

## Decided: Electron is the playtest surface, web stays view-only

The research flagged that preview and all agent-driven browser automation are
structurally Electron-only, and asked whether the plain web build must also
support the playtest loop.

**Electron only.** The goal already settled this: _"Preview needs Electron for
CONTROL, not display: an iframe shows WebGL, but only
BrowserWindow/webContents lets the agent click/evaluate/screenshot its own
build. Agent-playtests-the-game is the point; web stays view-only."_ No new
subsystem is needed for web, because web is not a target for this loop.

## Build order, and an honest size

The research recommends — and I agree — landing `task_ref` **before** the
aggregate. It is an opaque `{source,id}` with no referential dependency, so it
exercises the entire path (contracts → decider → projector → SQL projection →
read model) and flushes out the tri-state bug class (`undefined` means leave
alone, `null` means clear) while the blast radius is still small.

The event store needs no migration for a third aggregate:
`orchestration_events` is keyed generically on
`aggregate_kind, stream_id, stream_version`
(`Migrations/001_OrchestrationEvents.ts:8-33`), which is what makes the whole
thing additive. That was the load-bearing assumption behind "one new
aggregate, two nullable columns", and it holds.

Honest size: **roughly 8–9 focused engineer-days**. No step is a one-liner.
