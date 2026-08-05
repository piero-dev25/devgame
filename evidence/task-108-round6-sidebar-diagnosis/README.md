# Task #108 round 6 — the diagnosis that closed a three-round bug

QA rounds 3-5 fixed two real, log-proven mechanisms (group-then-panel
restore ordering; a per-group record subscription; a restore-transient
suppression guard for merge-gate finding F7) and the leak still reproduced.
Round 5 handed over a literal 12-step timestamped click record and asked for
the exact `activationKey`/`byActivationKey`/`restoreActivePanelForKey`
readout at each "return to a thread" window. This directory holds that
readout: the raw Electron console log from the instrumented diagnostic
build, a cleaned/reformatted version, and the analysis that named the real
root cause — fixed in commit `07a031926`.

## Files

- `dock-diag-raw.txt` — the actual `ELECTRON_ENABLE_LOGGING=1` output
  captured from the diagnostic build (`[dock-diag]`-prefixed
  `console.log` lines added temporarily to `DockviewLayout.tsx`,
  `restoreActivePanel.ts`, and `dockActiveSelectionStore.ts`, reverted
  before commit — see `07a031926`'s parent commits for the reverted diff).
  Timestamps are in the log's own local time (`0805/HHMMSS.ffffff`).
- `dock-diag-clean.txt` — the same lines with the Electron/Chromium log
  scaffolding stripped, timestamps reformatted to `HH:MM:SS.ffffff`, for
  direct reading.
- This README — the click-log-to-log-line mapping and the four "prize
  window" answers.

## The click record (from round 5's computer-use driver, UTC; the log runs

## ~7h behind — align 18:29:21.151Z UTC to 11:29:21.151 local)

1. 18:29:21.151Z — click WellnessCompanion > Greeting (thread **A**). Arrival: Diff.
2. 18:29:38.338Z — click Files (in A). Tab: Files.
3. 18:29:47.961Z — click WC > first "Start coding conversation" (thread **B**). Arrival: Files.
4. 18:29:57.418Z — click Diff (in B). Tab: Diff.
5. 18:30:07.371Z — click WC > Greeting (**back to A**). Arrival: **Diff — LEAK.**
6. 18:30:19.637Z — click WC > "Start coding conversation" (back to B). Arrival: Diff.
7. 18:30:34.833Z — click WC > Greeting (A). Arrival: **Diff — LEAK.**
8. 18:30:46.185Z — click Files (in A). Tab: Files.
9. 18:30:55.436Z — click WC > "Start coding conversation" (B). Arrival: Files (B's step-4 Diff also lost).
10. 18:31:05.413Z — click Diff (in B). Tab: Diff.
11. 18:31:17.781Z — click WC > Greeting (A). Arrival: **Diff — LEAK.**
12. 18:31:27.859Z — click WC > "Start coding conversation" (B). Arrival: Diff.

Thread key mapping (confirmed from the log's own `activationKey effect`
lines): **A = `...b968a54f-b71d-4e7f-a953-65b2c8ce3f01`**, **B =
`...c95ca78e-8fba-487c-bdb9-1e4e029c7774`**.

## Root cause

T3's thread list is itself a registered dock panel
(`SIDEBAR_PANEL_ID = "sidebar"`, `ChatDock.tsx`, `singleton: true,
closeable: false`). Clicking a thread to navigate is, to dockview-core, a
genuine click inside that panel's content area — dockview fires
`onDidActivePanelChange` for the sidebar panel **synchronously**, as part
of native DOM click handling, strictly **before** React commits the new
`activationKey` prop and the effect that updates
`activationKeyRef.current` (`DockviewLayout.tsx`) runs. The write-side
recorder (unsuppressed — this is a real activation, not a restore
transient) therefore stamps `panelId: "sidebar"` under the **OUTGOING**
(still-current, about-to-be-stale) thread's key. This happens on
**every single thread switch**, in both directions.

Proof, straight from `dock-diag-clean.txt`:

```
11:29:38.408077  recorder key=...b968a54f(A)... panelId=files suppressed=false   <- step 2: A correctly gets "files"
...
11:29:48.016755  recorder key=...b968a54f(A)... panelId=sidebar suppressed=false <- step 3 click: navigating AWAY from A clobbers A's own key back to "sidebar", BEFORE the activationKey effect for B even runs (next line, 11:29:48.099998)
```

By the time **any** later `restore ENTRY`/`activationKey effect` line reads
`byActivationKey`, the entry for whichever thread was just left already
reads `"sidebar"` — the real `"files"`/`"diff"` value never survives past
the same click that navigates away.

## The four prize windows

**Step 5 (18:30:07.371Z, return to A):** `activationKey effect` fired
(`hasApi=true`). `byActivationKey[A] = "sidebar"` (clobbered 22s earlier at
step 3). `restoreActivePanelForKey` found panel `"sidebar"` (`found=true`),
issued `group.api.setActive()` + `panel.api.setActive()` on the sidebar —
never touched the Files/Diff group, which stayed at whatever step 4 left it
(Diff). **Leak.**

**Step 7 (18:30:34.833Z):** identical — `byActivationKey[A]` still
`"sidebar"` (nothing re-selected Files between steps 5 and 7). Same
outcome.

**Step 9 (18:30:55.436Z, return to B "with remembered Diff"):** B's step-4
`"diff"` was clobbered at `11:30:07.429787` — the moment of switching away
FROM B TO A at step 5. So B's remembered value was _already_ `"sidebar"` by
step 9. Restore activated sidebar, not diff. The Files/Diff group's own
live tab stayed at `"files"` (from step 8's direct click in A, since
nothing else corrects that group) — matches the click log's observed
"Arrival: Files" exactly.

**Step 11 (18:31:17.781Z):** identical mechanism — A's step-8 `"files"`
(recorded `11:30:46.243893`) was clobbered at `11:30:55.494007` (switching
away to B at step 9). **Leak.**

## Round 4's suppression guard: ruled out, not implicated

Every recorder line across the full 12-step replay — 23 total — logs
`suppressed=false`. None fire between `group.api.setActive() issued` and
`panel.api.setActive() issued` inside any restore call (checked with
`awk`/`grep` against the clean log). `isRestoringRef` is doing exactly what
it was built to do; this bug lives entirely upstream of it.

## The fix (commit `07a031926`)

`CHROME_PANEL_IDS` (`dockActiveSelectionStore.ts`, currently
`{SIDEBAR_PANEL_ID}`) — navigation chrome is never a remembered selection:

- **Write side**: `recordActivePanelForKeyUnlessRestoring` ignores any
  `CHROME_PANEL_IDS` member outright, independent of `isRestoring` (this is
  a real, unsuppressed activation, not a restore transient).
- **Read side**: `restoreActivePanelForKey` treats a stored chrome id as no
  entry, falling through to `fallbackPanelId`. Needed independently of the
  write-side fix: `byActivationKey` persists to `localStorage`
  (`t3code:dock-active-selection-state:v1`), so every entry the pre-fix bug
  already clobbered to `"sidebar"` survives an app restart.

Deliberately not built: general "was this activation caused by the same
click that also changes the thread" machinery. The chrome-exclusion
principle covers the one case that exists today; a future non-thread-scoped
panel joins `CHROME_PANEL_IDS`.

## See also

`evidence/task-108-f7-headless-repro/` — the round-4 headless
dockview-core repro that ruled out F7 as the live trigger (its negative
result was correct: F7 self-corrects; this sidebar-attribution race is a
separate, upstream mechanism a headless harness with no sidebar panel could
never have modeled).
