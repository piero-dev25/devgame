# Unified top band — headless capture-phase dragstart-cancel repro

Built while implementing `docs/specs/unified-topband.md` (rev 4). Section A,
critique B3/m6, and the spec's own test-plan line name this exact repro:

> Red-first headless test per critique m6: the repo's jsdom+dockview harness
> precedent (evidence/task-108-f7-headless-repro/, referenced from
> DockviewLayout.tsx) — construct a dock, synthetic dragstart on a band void,
> assert defaultPrevented AND LocalSelectionTransfer empty.

## What it is

`repro-band-dragstart-cancel.cjs` — a standalone Node script, same reason as
the precedent it reuses: `apps/web` has no jsdom environment configured on
purpose (`vite.config.ts`'s `test.environment` is `"node"` — see
`restoreActivePanel.test.ts`'s own module doc), so this is not part of
`pnpm test`/`vitest`.

Run it with:

```
node evidence/task-137-topband-headless-repro/repro-band-dragstart-cancel.cjs
```

If it fails to resolve `jsdom`/`dockview-core` after a `pnpm-lock.yaml`
change, re-resolve the hardcoded `JSDOM_ENTRY`/`DOCKVIEW_ENTRY` paths at the
top of the script the same way the precedent's own README says:

```
find node_modules/.pnpm -maxdepth 1 -iname "jsdom@*"
find node_modules/.pnpm -maxdepth 1 -iname "dockview-core@*"
```

## What it does

1. Boots a **real** `dockview-core@7.0.4` instance against a minimal jsdom
   shim (extended beyond the task-108 precedent's shim with `Document` and
   `Node` globals — this is the first headless script to dispatch a REAL
   dragstart that reaches dockview-core's actual `Html5DragSource` listener,
   which needs both).
2. Builds a two-group layout (Sidebar left, Chat right) and stamps
   `data-dv-topband` on both groups' `.dv-tabs-and-actions-container`
   directly — scoped to proving the dragstart cancel, not re-proving
   `computeTopBandLayout` (already covered, red-first, by
   `apps/web/src/dock/lib/topBandLayout.test.ts`).
3. Dispatches a synthetic `dragstart` at the Sidebar group's
   `.dv-void-container` — TWICE, in two scenarios:
   - `withListener: false` — no capture-phase guard installed at all.
   - `withListener: true` — `DockviewLayout.tsx`'s actual
     `handleTopBandDragStartCapture` logic installed on the dock container,
     capture phase, structurally identical to what ships.
4. Asserts `event.defaultPrevented` and reads `getPanelData()` (exported
   from the same dockview-core bundle `createDockview` comes from) as the
   "did `LocalSelectionTransfer` receive data" check — `LocalSelectionTransfer`
   itself is NOT part of dockview-core's public export surface (verified
   empirically against both `main.cjs.js` and `main.esm.mjs`), but
   `getPanelData()` reads the exact same singleton `groupDragSource.js`'s
   `sharedDragOptions.getData` writes to, from the same module graph.

## RED-FIRST method

Both scenarios run every time, `withListener: false` FIRST:

- **RED (no listener):** the void container's own drag machinery runs to
  completion — `defaultPrevented` stays `false`, and `getPanelData()`
  returns a real `PanelTransfer` (`{"viewId":"1","groupId":"1","panelId":null}`
  in the captured run below). This is the red state: proof this repro
  exercises dockview's real, unmodified dragstart path, not a tautology —
  the same standard `workspaceChromeInset.test.ts`/`topBandLayout.test.ts`
  apply via "module doesn't exist yet," adapted for a script that drives a
  live dock instead of importing a not-yet-written module.
- **GREEN (with listener):** the identical steps, with the capture guard
  installed — `defaultPrevented` is `true`, `getPanelData()` returns
  `undefined`. This lands on dockview's own supported cancel branch
  (`dnd/backend.js`'s `Html5DragSource` dragstart listener checks
  `event.defaultPrevented` FIRST, before calling `getData()` — confirmed
  against the installed dist/esm source, not assumed), so nothing leaks.

Between the two scenarios, `LocalSelectionTransfer` (a process-wide
singleton with no public clear method) is reset via a REAL `dragend`
dispatch on the same element — dockview's own `Html5DragSource` dragend
listener clears the transfer one macrotask later ("defer disposal so drop
handlers can still read the transfer payload before it clears," per its own
comment) — not a test-only reset hack, so the second scenario starts from a
genuinely empty singleton rather than silently inheriting the first
scenario's leftover data.

## Captured run (2026-08-10)

```
########## SCENARIO: band void dragstart, withListener=false ##########
  defaultPrevented: false
  getPanelData(): {"viewId":"1","groupId":"1","panelId":null}
  RESULT: NOT cancelled — dockview's own drag ran to completion (expected RED-FIRST baseline: no guard installed, proves this repro exercises the real, unmodified path)

########## SCENARIO: band void dragstart, withListener=true ##########
  defaultPrevented: true
  getPanelData(): undefined (empty)
  RESULT: CANCELLED — defaultPrevented, no leaked PanelTransfer data (expected, green)

================ SUMMARY ================
RED-FIRST (no listener):  defaultPrevented=false hasPanelData=true -> PASS (proves real path, not cancelled)
GREEN (with listener):    defaultPrevented=true hasPanelData=false -> PASS (cancelled, no leak)

RED-FIRST proven, then GREEN proven: the capture-phase guard is the thing making the difference, not an artifact of the harness.
```

Exit code `0`.
