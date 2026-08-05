# Task #108 round 4 — headless dockview-core repro (merge-gate finding F7)

Built while fixing the dock tab-selection leak (task #108) after QA round 4
reported the restore half still leaking on the exact
A-selects-Files / B-selects-Diff / back-to-A repro, even after round 3's
per-group record-side fix. The merge gate's finding F7 hypothesized a
transient wrong write during restore as the cause. This directory holds the
diagnostic script used to check that hypothesis against real
dockview-core code, not just source reading.

## What it is

`repro-dockview-restore-sequence.cjs` — a standalone Node script (not part of
`pnpm test`/`vitest`; this repo deliberately has no jsdom environment
configured for `apps/web`, see `restoreActivePanel.test.ts`'s own module
doc) that:

1. Boots a **real** `dockview-core@7.0.4` instance against a minimal
   `jsdom` shim.
2. Builds the same two-group layout this app's dock actually has: one group
   with a `chat` panel, one group shared by `files` and `diff` (mirroring
   `ChatDock.tsx`'s Files+Diff tab strip).
3. Drives it through the **exact** restore/record logic as committed at
   round 3 (`restoreActivePanelForKey`'s group-then-panel ordering, the
   top-level + per-group `onDidActivePanelChange` subscriptions — no
   suppression guard, since that's what round 3's code actually shipped).
4. Runs two scenarios and reports whether the store's FINAL value for
   thread A ends up `"files"` (correct) or something else (leak
   reproduced).

Run it with:

```
node evidence/task-108-f7-headless-repro/repro-dockview-restore-sequence.cjs
```

If it fails to resolve `jsdom` or `dockview-core` after a `pnpm-lock.yaml`
change, the hardcoded `JSDOM_ENTRY`/`DOCKVIEW_ENTRY` paths at the top of the
script point at specific pnpm store hashes — re-resolve them with:

```
find node_modules/.pnpm -maxdepth 1 -iname "jsdom@*"
find node_modules/.pnpm -maxdepth 1 -iname "dockview-core@*"
```

## What it found

- **F7 is real.** Scenario B's log shows `panel.group.api.setActive()`
  transiently firing the top-level `onDidActivePanelChange` with the
  group's OLD active panel (`diff`) before the correct one is applied —
  exactly as the merge gate described, traced to
  `dockviewComponent.js`'s `doSetGroupActive` override calling
  `fireActivePanelChange(this.activePanel)` using whatever panel was
  already active in the group at that instant.
- **F7 self-corrects.** In both scenarios this script constructs — the
  natural sequence, and a variant where focus explicitly leaves the shared
  group before the final restore (the condition that actually triggers the
  transient) — the wrong write is synchronously superseded, within the
  SAME call, by dockview-core's own guarded re-broadcast once the group
  becomes active. The store's final value and dockview's own live
  `activePanel` both land on `files` in every run.
- **Conclusion at the time:** this headless repro did **not** reproduce QA
  round 4's persisting live leak. The suppression fix
  (`isRestoringRef` / `recordActivePanelForKeyUnlessRestoring`, commit
  `eebb4c322`) was implemented anyway — restore never legitimately needs to
  write to the store it's only applying, so making it read-only removes the
  whole risk class regardless of whether F7 was the live trigger — but the
  negative repro result means F7 may be a red herring for the actual
  live-observed leak.

## Round 5/6: F7 was a red herring — the real bug needed a sidebar panel modeled

Neither scenario A nor B ever modeled the thread-list sidebar as a panel at
all — which is exactly why this script could not have caught round 5/6's
actual root cause: the sidebar is itself a dock panel, so navigating
threads fires a real, unsuppressed panel activation that got misattributed
to the OUTGOING thread's key. Full diagnosis:
`evidence/task-108-round6-sidebar-diagnosis/`. Fixed in commit `07a031926`
(`CHROME_PANEL_IDS`).

## Round 7: scenario C — a real-click-vs-restore divergence, still unreproduced

Round 6's fix gated CLEAN on all four pre-registered live criteria, but an
ungated micro-replay found a stable residual: `A(click Files) -> B(click
Diff) -> A(restored, PASS) -> B(restored, not clicked, PASS) -> A(restored
AGAIN, FAIL — shows Diff, expected Files)`. The suspected mechanism, traced
against dockview-core@7.0.4's own `tab.js`: a real tab click and
`restoreActivePanelForKey`'s `panel.api.setActive()` chain are NOT the same
code path — a real click's `onPointerDown` handler calls
`group.model.openPanel(panel)` directly, with no separate
`group.api.setActive()` call wrapping it (confirmed this app's custom
`createTabComponent` doesn't change that — it only supplies content mounted
INSIDE dockview-core's own clickable `.dv-tab` element).

**Scenario C** (`scenarioC_restoreThenRestoreAcrossThreads`) models this
precisely: a real `sidebar` panel (this round's fix to round 6's own gap), a
distinct `realTabClick()` helper matching the traced click path, the
existing `activatePanelInItsGroupWithSuppression()` restore path (rounds
3+4's fixes, unchanged), and — new this round — DOM-level inspection via
`[data-panel]`-tagged content elements checked with `.isConnected`, not just
`group.activePanel`, since dockview-core's `ContentContainer` tracks
"currently rendered panel" as its OWN separate piece of state from the group
model's `_activePanel`.

**Result: did NOT reproduce.** All three gated steps pass; model state and
DOM connectivity agree at every checkpoint. This is the SAME kind of
negative result as round 4's F7 investigation — a real, structurally sound
repro of the reported mechanism, run against the real library, that still
can't surface what production shows.

## If a future round still can't close this the headless way

Two real bugs have now needed this harness extended before it could
reproduce them (round 6's sidebar; round 7's real-click-vs-restore
divergence, still open). The next likely structural gap: this harness's
panels are trivial synchronous DOM elements (`{element, init(), dispose()}`)
— no React anywhere. The real app's panel content mounts via React portals
(`createReactContentRenderer` + `panelPortalStore.ts`). A diagnostic-build
loop that logs `group.activePanel.id` at the moment of a live step-7
failure tells you which half is broken:

- If the live dockview-core MODEL is already wrong at that point, the bug
  is inside dockview-core under conditions this harness still doesn't
  create (worth revisiting `fromJSON`-loaded initial state — never tried;
  every scenario here still builds via `addPanel()`).
- If the live MODEL is correct but the SCREEN is wrong, the bug is in the
  React portal rendering layer, which no amount of dockview-core-only
  headless testing can ever reach — that needs the diagnostic-build loop
  (same rig procedure as round 6, new instrumentation) or a
  `@testing-library/react`-class harness this repo doesn't currently have.

A diagnostic/instrumented build is for diagnosis only — final evidence for
closing #108 still has to come from a clean build, per the owner's
end-to-end verification doctrine.
