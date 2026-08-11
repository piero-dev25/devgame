# QA round 3 — result

Build under test: commit `1f41acec2`, packaged app at `/Applications/DevGame (Alpha).app`.
Driver: Codex computer-use, perceiving via `get_app_state`.
Screenshots: 52 captured, collected live by `scripts/qa/collect-cua-screenshots.sh`
into `evidence/qa-round3/screenshots/` (untracked — see `.gitignore` there).

Build integrity was verified BEFORE the pass, so this is not stale-rig evidence:
grepped `Contents/Resources/app.asar` with a control string that must match first,
then confirmed `aria-disabled:cursor-not-allowed` present, `Restore maximized panel`
present, and the deleted panel's string absent.

## Verdicts

| Item                                | Result                                                        |
| ----------------------------------- | ------------------------------------------------------------- |
| 1 — Settings Unity panel gone       | **PASS**                                                      |
| 2 — disabled Play explains itself   | **PARTIAL** (keyboard yes; visible hover UNRUNNABLE)          |
| 3 — Restore clear of traffic lights | **PARTIAL** (works; placement UNRUNNABLE)                     |
| 4 — same-group tab selection        | **FAIL**                                                      |
| 5 — Setup Integrations end to end   | **FAIL**                                                      |
| 6–10                                | UNRUNNABLE — the handoff required stopping when Item 5 failed |

## Item 5 — FAIL, and it is the headline

One authorised click on **Setup Unity Integrations** (Mafia Game) produced a
failure toast in ~0.5s. Verbatim:

> "Could not install Pipeline package"
> "Not a Unity project: /Users/pieroherrera Unity projects must have an Assets/ folder."

The CTA still read "Setup Unity Integrations" after 10.5s. No pending/spinner
state appeared. Play's accessible name was unchanged.

**Independently corroborated**: `Packages/manifest.json` and `packages-lock.json`
were snapshotted before the pass and are byte-identical after. Nothing was written.

Root cause is filed as **#128**, and it is bigger than a bad path — see that task.
In short: every Unity server route resolves the project from the _server process's_
working directory, which in the packaged desktop app is the user's home folder
(measured: backend pid on `:3773` has `cwd=/Users/pieroherrera`). And
`UnitySetupClassifier.ts` has **no** "not a Unity project" state, so a non-Unity
directory falls through to S5 — a confident, actionable message about the wrong
directory, followed by a CTA that cannot succeed.

**The cache-invalidation fix this item existed to test was never reached**, because
the success path never ran. It remains unverified.

## Item 4 — FAIL

Per-thread tab selection leaks when two panels **share one dock group**.

1. Chat A: Files selected, Diff deselected.
2. Chat B: Diff selected, Files deselected.
3. Back to chat A: **Diff** selected. Leaked.

Round 2 called this a PASS but stated its own limit — its two panels were in
_separate_ groups, where no leak is structurally possible. That honest caveat is
exactly what let round 3 target the real case. Reopened as **#108**.

## Items 1–3

**Item 1 PASS.** Settings → Connections now contains only: "This environment",
"Network access", "Tailscale HTTPS", "Remote environments". No Unity section, no
"Not a Unity project" text, no orphaned heading or gap.

Caveat worth recording: that deleted panel was the only surface that ever said
anything true about a non-Unity directory (its own client-side fallback, never in
the server classifier). The scoping fix was right; it also removed the only honest
signal, leaving the header's misleading one. See #128.

**Item 2 PARTIAL.** Tab now reaches the disabled Play control and its focused
element carries the full explanation — a real improvement, since before this the
control was unreachable by keyboard. A targeted click did nothing and Play stayed
disabled, so the `aria-disabled` switch did not accidentally make it live.

UNRUNNABLE: whether a **visible tooltip** opens on hover. The computer-use toolset
has no hover/mouse-move primitive, and the standing method rule makes screenshots
evidence-only rather than perception. **This is a limitation of our own QA method,
not a property of the fix** — it means #124 cannot be closed by this driver at all
and needs a different verification route.

Stop and "Bring Unity to the front" were absent in this state, so their class
checks were UNRUNNABLE.

**Item 3 PARTIAL.** Maximize/Restore work: right-click Diff → Maximize announced
"Diff maximized", "Restore maximized panel" and "Reset workspace layout" were both
exposed, Restore worked without the context menu and announced "Diff restored".

UNRUNNABLE: actual placement, traffic-light overlap, and crowding — structured
state carries no coordinates and screenshot inspection was barred. #125 stays open.

## Incidental observations (not passes)

- Browser empty state still: "Open a local app or URL." / "New Tab."
- Files listed Mafia Game project entries.
- Diff warned: "This diff was truncated because it exceeded the preview limit.
  The changes shown are incomplete."

## Method notes for round 4

1. **Two items were UNRUNNABLE for the same reason**: no hover primitive, and
   screenshots barred as perception. Any round that asks "does a tooltip appear"
   or "do these two controls visually collide" will keep returning UNRUNNABLE.
   Either accept those as human-eye checks, or change the perception rule
   deliberately for geometry-only items.
2. The stop-on-Item-5-failure instruction cost items 6–10. That was the right
   trade for a write-bearing step, but the ordering should put non-destructive
   checks BEFORE the destructive one next time.
3. Screenshot collection worked — 52 preserved, versus 19 lost in round 2.
   Clear the source directory first, or the collector re-copies the prior round.
