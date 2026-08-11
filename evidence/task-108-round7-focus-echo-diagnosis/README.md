# Task #108 round 7 — the third root cause: chat-composer focus steals group activation

Round 6's fix (`07a031926`) gated CLEAN on all four pre-registered live criteria
(A→Files, B→Diff at every gated switch, both directions). But an UNGATED
micro-replay with settle time and double-sampling found a stable residual in
exactly one shape:

```
A(click Files) -> B(click Diff) -> A(restored, PASS) ->
B(restored, not clicked, PASS) -> A(restored AGAIN, FAIL — shows Diff, expected Files)
```

This directory holds the diagnostic-build log (raw + cleaned) and the
analysis that found the THIRD, independent mechanism behind this — fixed in
the commit that follows this evidence commit (see git log for the exact SHA).

## Files

- `dock-diag2-raw.txt` — the `ELECTRON_ENABLE_LOGGING=1` output from the
  round-7 diagnostic build. Three signals instrumented, all temporary,
  reverted before commit:
  - **Signal A** (`restoreActivePanel.ts`): `restore-entry`
    (rememberedPanelId/fallbackPanelId) and `restore-complete`
    (target panel + `panel.group.activePanel.id` right after both
    `setActive()` calls).
  - **Signal B** (`reactContentRenderer.tsx`): `onShow`/`onHide` hooks
    (dockview-core calls these; this app never implemented them before),
    logging panelId + the content element's `isConnected` state.
  - **Signal C, the timeline** (`DockviewLayout.tsx`): every top-level AND
    per-group `onDidActivePanelChange` event, timestamped, tagged with
    source (top-level vs which group) and `isRestoring` state at that
    instant.
- `dock-diag2-clean.txt` — same lines, Electron/Chromium scaffolding
  stripped, timestamps reformatted.
- This README.

## The click record (round 7 replay, UTC; log runs ~7h behind, same offset as prior rounds)

1. A click 19:14:52.141 → arrival sampled Diff (stale/absent persisted entry from earlier sessions)
2. Files click 19:15:01.596 → Files
3. B click 19:15:07.768 → sample 19:15:12.196: Diff (RESTORE-DRIVEN — B's persisted Diff — and it LANDED)
4. Diff click 19:15:16.966 → Diff
5. A click 19:15:21.184 → sample 19:15:25.703: Files (restore LANDED)
6. B click 19:15:31.653 → sample 19:15:36.093: Diff (restore-driven, LANDED)
7. A click 19:15:42.953 → sample1 19:15:47.410: Diff; sample2 19:15:52.501: Diff — **FAILED, stable**

Local log timestamps for the same window: 12:14:52 through 12:15:53.

## The four questions, step 5 (12:15:21, LANDS) vs step 7 (12:15:43, FAILS)

**Step 5 — restore lands on Files:**

- (a) restore-entry: `rememberedPanelId=files, fallbackPanelId=chat` — correct.
- (b) restore-complete: `target=files, groupModel=files` — correct.
- (c) Signal B: `onHide(diff)` at `.311892`, `onShow(files)` at `.317388` — exactly as expected.
- (d) Timeline AFTER restore-complete: **one further event, 23ms later** —
  `top-level panel=chat isRestoring=false` at `12:15:21.341493`. UNSUPPRESSED.
  This writes `byActivationKey[A]="chat"`, silently overwriting the "files"
  restore just set. The Files/Diff group itself is untouched by this write
  (it only activates Chat's own separate group), so the SCREEN still
  correctly shows Files — the corruption is invisible until the next read.

**Step 7 — restore lands on Chat, screen shows stale Diff:**

- (a) restore-entry: `rememberedPanelId=chat` — **not files.** Already
  corrupted before this restore even started.
- (b) restore-complete: `target=chat, groupModel=chat` — restore did exactly
  what it was told; restore itself is not the bug.
- (c) Signal B: `onHide(chat)`/`onShow(chat)` at `.091660`/`.091752` —
  restoring the Chat panel, never touching the Files/Diff group at all.
- (d) No revert event fires after THIS restore — the damage happened 22
  seconds earlier, at step 5's trailing write. Nothing touched A's key in
  between (step 6 is entirely about B).

## The mechanism, confirmed in dockview-core@7.0.4 source

Every restore is followed 9–23ms later by an unsuppressed top-level "chat"
activation. `dockview/dockviewGroupPanelModel.js` wires:

```js
this.contentContainer.onDidFocus(() => {
  this.accessor.doSetGroupActive(this.groupPanel);
});
```

Whenever a DOM element INSIDE a group's content container receives focus,
dockview-core treats that as "this group is now active," fires the
top-level `onDidActivePanelChange` event — and since this lands well after
`isRestoringRef` has already reset to `false` (the focus event is
asynchronous relative to the synchronous restore call, not part of it), the
write is unsuppressed and gets recorded as if the user picked Chat.

Something inside the Chat panel's content autofocuses shortly after each
thread's content mounts — almost certainly the message composer input.
Chat has its own separate group from the shared Files/Diff group
(`group-terminal` in this build's persisted layout), which is exactly why
step 7's failure shows Diff, not Chat: restoring Chat only activates Chat's
own group. The Files/Diff group is left completely untouched, still showing
whatever step 6 last set it to.

**Why step 5 survives but step 7 doesn't:** the same trailing corruption
happens after EVERY restore (confirmed after steps 1, 3, and 5 too — see the
raw log). It only matters if nothing else re-writes that thread's key
before the next read. B is saved by step 4's own Diff click landing right
after step 3's corruption. A never gets that chance in this exact sequence
— nothing touches A's key between step 5 and step 7.

## Why round 4's suppression guard doesn't already cover this

`isRestoringRef` is scoped to the SYNCHRONOUS duration of
`activatePanelInItsGroup`'s two `setActive()` calls. This focus-driven event
fires asynchronously afterward — outside that window by construction. It was
never a candidate for suppression under round 4's design, because round 4's
design was built to answer a different question (F7's transient, which is
synchronous).

## The fix

A settle window anchored to the ACTIVATION-KEY CHANGE (not the restore
call): for a short window after any thread switch, activation events are
machinery, not user selections — restore, autofocus, and mount churn all
included. See the commit that follows this one for `SETTLE_MS` and the
updated `recordActivePanelForKeyUnlessRestoring` signature.

Deliberately NOT in scope for that fix: touching the composer's autofocus
itself (a real UX design question — does switching threads have any
business silently changing which dock GROUP is active, independent of the
settle-window bug? — recorded as a future owner call), per-group store
semantics, or patching dockview-core's focus wiring.

## See also

- `evidence/task-108-f7-headless-repro/` — round 4's F7 investigation (ruled
  out as the live trigger) and round 6/7's scenario C (real-click-vs-restore
  divergence, also ruled out) and scenario D (this round's focus echo,
  reproduced headlessly once the mechanism was known).
- `evidence/task-108-round6-sidebar-diagnosis/` — round 6's sidebar
  panel-attribution diagnosis (the SECOND root cause, fixed in `07a031926`).
