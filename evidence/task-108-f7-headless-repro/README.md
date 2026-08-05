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

## If round 5 (or later) still shows the leak

Treat this script as a starting point, not a dead end. Things worth trying
next, roughly in order of suspicion:

1. **Load-path difference**: this script builds the layout via `addPanel()`;
   the real app loads a persisted layout via `api.fromJSON(...)`
   (`DockviewLayout.tsx`'s `loadInitialLayout`). Extend a scenario to build
   the layout via `fromJSON` with a serialized tree captured from a real
   saved-layout blob, in case the initial `activeGroup`/`activeView` wiring
   differs in a way that changes which event-ordering sub-case applies.
2. **React re-render/StrictMode timing**: nothing here models React at all
   — `activationKeyRef.current` is a plain script variable set synchronously
   in this repro, but the real `useEffect` could interact with a re-render
   or StrictMode double-invocation in a way a headless script can't
   surface. Worth checking Locale via `console.log` (or a `debugger`
   statement) added to `DockviewLayout.tsx`'s actual mount/activation-key
   effects in a throwaway diagnostic build.
3. **Exact live click sequence**: get the literal click-by-click sequence
   from whichever QA round reproduces it next, not a paraphrase, and encode
   it as a new `scenarioC_...()` function in this script — the two existing
   scenarios don't exhaust the state space (e.g. neither tries clicking
   Diff, then Files, then Diff again within the SAME thread before
   switching away).

A diagnostic/instrumented build is for diagnosis only — final evidence for
closing #108 still has to come from a clean build, per the owner's
end-to-end verification doctrine.
