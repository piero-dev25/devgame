# The MUST-GUT list, re-checked against the fork

The goal carries three things to fix "before building on it". Two of them do
not survive reading the code at HEAD `69dfb7f0`, and one would cause harm if
carried out. Both bad items trace back to my own earlier analysis of the
_vendored subtree_, not the fork — the same mistake that produced the
`instanceId` "workaround".

## 1. "Paginate `getCommandReadModel` first" — do not do this

The description is accurate: six `list*Rows(undefined)` queries run in one
transaction with no `WHERE`, no `LIMIT`, not even `deleted_at IS NULL`
(`ProjectionSnapshotQuery.ts:1362`, queries at `:346-395`).

The prescription is wrong on two counts.

**It is not a hot path.** Every call site:

| site                            | frequency                                   |
| ------------------------------- | ------------------------------------------- |
| `OrchestrationEngine.ts:301`    | **once per server boot**                    |
| `ProviderCommandReactor.ts:906` | recovery sweep for interrupted title regens |
| `cli/project.ts:342`            | one-shot CLI command                        |
| `http.ts:41`                    | `snapshot` route — CLI-only consumer        |

After boot the engine never re-reads it. `commandReadModel` is a single
mutable binding (`OrchestrationEngine.ts:88`) updated **in memory** by
`projectEventsOntoReadModel` as each command commits (`:121`, `:215`). So the
cost is boot latency and resident memory, not per-command work.

The `http.ts:41` comment shows they already met the OOM version of this
problem and fixed it deliberately: the route serves the _lightweight_ command
read model precisely because "hydrating every message and activity payload in
the database has OOM-killed servers", and UI clients use per-thread snapshots
instead.

**And it cannot be paginated without breaking correctness.** The decider
consults the whole read model to enforce invariants that are only meaningful
over the complete set — `requireActiveProjectWorkspaceRootAbsent`
(`commandInvariants.ts:75`) asks whether _any_ active project already claims a
workspace root. Hand it a page and it answers "no" for a project sitting on
page two. That is a silent wrong answer, not a visible failure: the
silent-corruption class.

Even the tempting cheap win — adding `WHERE deleted_at IS NULL` — is not
obviously safe. `requireThreadAbsent` resolves through `findThreadById`; drop
soft-deleted rows from the read model and a deleted thread's id becomes
reusable. That may be fine or may not, but it is a semantic change to
invariant enforcement and needs its own reasoning, not a drive-by.

**Recommendation: drop this item.** If boot time or RSS becomes a real problem,
measure it against thread count first, then fix the actual shape of the
problem — prune or archive old threads, or narrow what the decider needs into
a smaller invariant projection. Do not paginate the aggregate the invariants
are computed over.

## 2. "decider.ts guards are per-case; add a central invariant helper first" — already done

`commandInvariants.ts` exists (184 lines) and exports eleven helpers:
`requireProject`, `requireProjectAbsent`,
`requireActiveProjectWorkspaceRootAbsent`, `requireThread`,
`requireThreadArchived`, `requireThreadNotArchived`, `requireThreadAbsent`,
`requireNonNegativeInteger`, plus three finders.

`decider.ts` imports it at line 15-22 and calls those helpers **36 times**
against **10** remaining inline `OrchestrationCommandInvariantError`
constructions. The central helper is already the dominant pattern.

The 10 inline cases are genuinely case-specific business rules — "thread has a
pending approval or user-input request and cannot be settled", "thread has a
queued turn start and cannot be settled". They share no predicate worth
extracting; generalising them would obscure rules that read clearly today.

**Recommendation: drop this item too.** Nothing to add.

## 3. Checkpoint policy — mechanism confirmed, trigger not yet measured

The mechanism is real and is worth taking: `GitVcsDriver.ts:660` sets an
isolated `GIT_INDEX_FILE`, which is what lets a checkpoint stage a tree
without touching the user's index — and therefore what makes it able to roll
back Unity scenes, prefabs and `.meta` files.

The claim that the trigger is **per-turn and unbenchmarked on large binary
trees** is the one I have _not_ verified. I found no per-turn call site in
`ProviderCommandReactor.ts`. Treat this item as open and measure it against a
real Unity project before rewriting the policy for ICM stages.

## Why two of three were wrong

Both bad items were measured against the vendored adapter subtree driven by
our own server, not against the fork. That is the same error that produced the
`instanceId` workaround, which the live turn also proved moot. The pattern is
worth naming: **an observation about how their code behaved under our host is
not an observation about their code.**
