# QA round 8 — the dock-leak closure gate

Build: commit `53d3fbf50` (settle-window fix), packaged app, backend verified
freshly launched (pid 37351, 12:45:58, post-install; SETTLE marker present in
app.asar with positive control).

## Verdict: ALL FOUR GATES PASS

| Step | Check                                                                     | Result              |
| ---- | ------------------------------------------------------------------------- | ------------------- |
| 5    | first return to A → Files                                                 | **PASS** (19:47:33) |
| 6    | restore-driven return to B → Diff                                         | **PASS** (19:47:41) |
| 7    | second return to A → Files — **the historic failure point**               | **PASS** (19:47:50) |
| 8    | genuine post-settle focus into chat, switch away/back → strip still Files | **PASS** (19:48:21) |

Step 7 had failed identically in rounds 5, 6 (micro), and 7 — stable across
double samples every time. It passes now, and step 8 proves the settle window
doesn't blanket-mute genuine focus: a real click into the composer well after
the window, followed by a full switch cycle, leaves the Files/Diff strip's
own selection intact.

## The complete saga, for the record

Three distinct root causes, uncovered in sequence, each requiring the
previous fix to be in place before it became observable:

1. **Sidebar-as-panel** (fixed `07a031926`): the thread-list is a dockview
   panel, so the navigation click itself recorded "sidebar" over the
   OUTGOING thread's memory. Found via diagnostic build #1.
2. **F7's transient** (suppressed `eebb4c322`): real but self-correcting —
   an honest negative result from the headless harness that redirected the
   investigation.
3. **Composer-autofocus echo** (fixed `53d3fbf50`): chat autofocus after
   each switch → dockview's `contentContainer.onDidFocus → doSetGroupActive`
   → an unsuppressed "chat" write 9–23ms AFTER restore — async, outside the
   round-4 guard by construction. Found via diagnostic build #2 with a
   three-signal timeline. Restore itself never failed once in eight rounds;
   it faithfully restored corrupted data.

Fix principle: **for `SETTLE_MS` (250ms; measured echo 9–23ms) after a
thread switch, activation events are machinery, not user selections** — a
pure-function recorder guard, red-proven (exactly the two new tests fail
with the check removed).

Diagnostic artifacts preserved: `evidence/task-108-f7-headless-repro/`
(harness, scenarios A–D), `evidence/task-108-round6-sidebar-diagnosis/`,
`evidence/task-108-round7-focus-echo-diagnosis/`.

Deferred by design, recorded in the ledger: whether the composer's autofocus
SHOULD steal dockview group-activation at all (a UX design call), and
per-group selection memory (#26's territory).
