# QA round 4 — result

Build under test: commit `3a1562ce8`, packaged app, backend verified freshly
launched from the new bundle (pid + start-time checked — round 4 nearly ran
against a stale backend that survived a regex-broken `pkill`; caught before
dispatch). Driver: Codex computer-use via `get_app_state`. 30 screenshots
collected live into `evidence/qa-round4/screenshots/` (untracked).

## Verdicts

| Item                              | Result                                    |
| --------------------------------- | ----------------------------------------- |
| 0 preflight                       | PASS                                      |
| 1 same-group tab selection (#108) | **FAIL — restore half; record half PASS** |
| 2 Settings stays clean            | PASS                                      |
| 3 panel regression sweep          | PASS (all five)                           |
| 4 header before install           | PASS                                      |
| 5 Setup Unity Integrations E2E    | **FUNCTIONAL PASS**                       |

## Item 5 — the headline: the E2E loop is CLOSED

One authorised click on **Setup Unity Integrations** (Mafia Game):

- **Ground truth, verified on disk independently of the driver**: the
  before/after snapshot of `Packages/manifest.json` shows exactly one line
  added — `"com.unity.pipeline": "0.4.0-exp.1"`. The install executed against
  the CORRECT project. (Round 3's identical click had targeted
  `/Users/pieroherrera` and written nothing.)
- OBSERVED: the CTA disappeared and the header settled to `Unity` + Play,
  with Play's accessible name now, verbatim:
  > "Pipeline is added to this project — Unity resolves it automatically,
  > either right away if the project is already open, or the next time you
  > open it."
  > That is S13, the honest just-installed state; it no longer claims the
  > package is missing.
- OBSERVED: switching to another project and back briefly showed
  "Checking Unity's status…" then returned to the installed state.
  **Persistence PASS.**
- Driver's answer to the acceptance criterion: **yes on final outcome** — a
  single click removed the CTA, produced a clear installed state, and
  persisted.

Honest gap: the driver's own scripting error (`item5Events is not defined`)
left the 0.5s–16s window unsampled, so "settled within a few seconds" and
"no transient stale CTA" are UNOBSERVED rather than proven. The cache-bug
signature (CTA lingering at 10s+) was not seen at the 16s sample. Also noted
by the driver: no pending/progress state was exposed immediately post-click —
a click could initially feel ignored. Recorded as a UX note, not a defect
gate.

This closes #128's E2E gate. The projectId → server-resolved-root design is
proven live end to end.

## Item 1 — #108 restore half still leaks; record half now works

OBSERVED, same shared Files+Diff group:

- chat A → Files; chat B → Diff; back to A → **Diff** (leak — same as round 3)
- back to B → Diff (correct)
- NEW, and it isolates the bug: focusing a different group first, then
  clicking Files directly, then switching away and back → **Files
  remembered correctly**.

So `3d3c66a76`'s RECORD half (the per-group unguarded subscription) is
live-proven working — a click in a non-focused group is now remembered,
which round 3's code could not do. The RESTORE half still loses to the
group's stale tab in the A→B→A alternation. Prime suspect: merge-gate F7 —
`group.api.setActive()` fires the top-level event with the group's OLD
active panel before `panel.api.setActive()` runs, and the gate warned the
store-write ordering in that window is structurally untested. Returned to
the implementing lane with this evidence.

## Everything else

Settings clean (no Unity section), all five panels pass their sweep, header
order and plain-text "Unity" hold, pre-install Play name was S4 ("Unity is
open, but this project doesn't have Unity's Pipeline package…") — correctly
reflecting that the Editor was open this round.

## Still open after this round

- #108 restore half (fix round dispatched with the new isolation).
- #124/#125 visual halves — tooltip-appears-on-hover and
  Restore/traffic-light clearance are **owner-eye checks**; the driver
  structurally cannot answer them and round 4 deliberately did not ask.
