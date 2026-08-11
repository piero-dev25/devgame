# Final QA pass — status record

**Build under test:** `566e9c803` (`/Applications/DevGame (Alpha).app`)
**Date:** 2026-08-04
**Outcome:** **INCOMPLETE — E2E gate OPEN, blocked on an owner-side grant.**

This file is the durable record. It is not the Codex driver's output slot —
that is `REPORT.md`, deliberately left for the driver to write.

---

## Why this is sealed with the gate open

Owner doctrine:

> A deferred E2E pass is an OPEN GATE, tracked explicitly in the ledger and the
> PR body — never silently absorbed into "done". A wave may seal with the E2E
> gate open **only when the blocker is an owner-side grant**, and the gate must
> be closed before merge/un-draft.

The blocker here **is** an owner-side grant. This record exists so the gate is
tracked rather than absorbed.

## The blocker, proven not assumed

Two independent dispatches, two different routes, identical verbatim result:

| #   | Route                                              | Result                                                          |
| --- | -------------------------------------------------- | --------------------------------------------------------------- |
| 1   | `codex:codex-rescue` subagent                      | `BLOCKED: Computer Use was not approved to use DevGame (Alpha)` |
| 2   | direct `codex-companion.mjs` from the main session | `BLOCKED: Computer Use was not approved to use DevGame (Alpha)` |

Attempt 1's report is preserved at `REPORT-attempt1-blocked.md`.

**Attempt 2 matters because it eliminates the obvious confound.** Attempt 1's
_seat_ died on a Claude weekly limit — nothing to do with the app. Attempt 2 ran
Codex directly on its own separate ChatGPT auth, loaded the computer-use skill,
read the dispatch spec, read `HANDOFF.md`, called the computer-use tool, and was
denied on the **first** call. It then stopped without retrying and wrote the
blocked report — exactly the specified fail-fast path, no workaround attempts,
no partial run, no fabricated observations.

**The dispatch route was never the problem. The grant is genuinely absent.**
Corroborating: `DevGame` appears nowhere in any Codex computer-use state on this
machine.

## What unblocks it

One human action, ~30 seconds:

1. Open **`/Applications/ChatGPT.app`** (the Codex desktop app on this machine;
   there is no separate `Codex.app`).
2. Ask it for any trivial computer-use action on DevGame (Alpha), e.g.
   _"take a screenshot of DevGame (Alpha)"_.
3. On the permission dialog choose **"Always allow"** — **not** "Allow once".
   A one-time grant does not persist to the CLI elicitation the automated run uses.

The pass then re-fires with no further prep. Everything is staged:
`HANDOFF.md` (137 lines: Item 0 preflight, sandbox writable paths, REPORT.md
contract, build-provenance block), `screenshots/` provisioned, and a reusable
dispatch spec.

**Not substituted:** this session's own `mcp__computer-use__*` MCP. Owner
instruction, verbatim: _"for qa, use computer use with codex computer use. do
not use your own computer use."_ Honoured.

---

## Verified WITHOUT the UI (observed, not assumed)

| Check                                              | Method                                             | Result                                                                                                                                                                                           |
| -------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Figma/Notion fully removed from the shipped bundle | `strings` over `app.asar`                          | **OBSERVED PASS** — exactly 1 occurrence, and it is a doc comment _explaining the deletion_, not live code. Control: "Unity integration" also matched, proving the search reaches real app code. |
| Runaway setup-probe poll fixed                     | process + request measurement on the running build | **OBSERVED PASS** — 0 probes, 0 `unity` subprocesses, 2.4% CPU                                                                                                                                   |
| Unity detection over the real route                | live HTTP against the owner's real Unity project   | **OBSERVED** — returns `S4` for Mafia Game (after the `79c213e14` envelope fix)                                                                                                                  |
| Consented Pipeline install                         | live HTTP, both token scopes                       | **OBSERVED** — 403 read-only / 200 command, manifest line verified on disk                                                                                                                       |
| Four dock panels render on desktop                 | packaged app                                       | **OBSERVED** (#84), Browser included                                                                                                                                                             |

## UNRUNNABLE — require a screen (9)

Recorded as unobserved. **Not** as passing.

1. Settings → Connections → "Unity integration" resolves to real per-item status
   (must **not** sit on "Checking…") — exact text of every row
2. Mafia Game engine toolbar: Play **disabled**, reason naming the missing
   Pipeline package — the exact sentence the feature exists to produce
3. Engine selector present in the top-right header, styled like its neighbours
4. No-engine project: selector reads "No engine", Play absent
5. Files panel — opens, lists files, click shows content
6. Diff panel — changes or an honest empty state
7. Terminal panel — "New Terminal" starts a shell (no typing)
8. Browser panel — desktop code path has barely ever run
9. Per-thread panel state — panels and contents return across chat switches
   (+ tab right-click / Maximize behaviour)

Plus the UI/UX critique, which by definition needs eyes on the screens.

## Gate closure criteria

The gate closes when the nine checks above are **observed** on a build whose
commit is named in the report — either by the Codex driver once granted, or by
the owner testing directly and reporting observations.

Related: **#55** (this pass), **#95** (live screenshot proof of S4 in the app).
