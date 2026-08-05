# QA round 5 — result

Build: commit `678dfb34b`, packaged app, backend verified freshly launched
(pid 94982, started 11:13, post-install). 30 screenshots collected live.

## Verdicts

| Item                                 | Result                                                       |
| ------------------------------------ | ------------------------------------------------------------ |
| 1 dock selection, exact repro        | **FAIL — leak reproduced twice, full click record captured** |
| 2 S9 CTA + selection-package install | **PASS** (E2E, disk-corroborated)                            |
| 3 regression spot-checks             | PASS                                                         |

## Item 2 — the selection-package install loop is CLOSED

- Pre-click ready header, verbatim: `Unity` · `Setup Unity Integrations` ·
  `Bring Unity to the front` · `Play` · `Nothing is playing to stop.` —
  the S9 CTA renders inside the READY trio (e61bd3b04 live-confirmed).
- One authorised click. **Ground truth on disk, verified independently**:
  `com.ironmind.editor-presence/` now exists in Mafia Game's `Packages/`
  with full content (before-snapshot had only naninovel + manifest + lock).
- CTA gone at the first post-click sample (7.2s — the driver's own scripting
  error delayed sampling; "within a few seconds" is bounded, not measured),
  stayed gone across a project switch.
- No toast text was exposed in accessibility state (UNRUNNABLE, not a fail).

Remaining for the chip: the owner's two-minute pairing — mint a token in
Settings → Connections (scope: Operate tasks), paste in Unity's
Settings → DevGame Editor Presence, then select something in the scene.

## Item 1 — the leak, now with a literal click record

Reproduced twice. The record (19 numbered steps, in the driver report and
task #108) contains the decisive observation the previous rounds lacked:

**Step 15: chat B HAD a remembered selection (Diff, clicked at step 5) and
arriving at B showed Files — the group's current tab.** Combined with A's
failures, every observation is consistent with **restore never landing in
the packaged app, in either direction**: the arriving thread always shows
whatever the shared group last displayed.

That kills the "restore loses a race" framing (round 4's) and narrows to:
restore not running, reading an empty/mis-keyed store, failing panel
lookup against the fromJSON-built layout, or dockview ignoring the
activation in the real Chromium environment. The suppression guard's
wiring was re-inspected and is correct (`.current` at event time,
try/finally), so a stuck guard is unlikely but not excluded — the store's
actual contents at switch time have never been observed live.

Next step (the fix lane's own round-5 plan): a DIAGNOSTIC build with
console logging at the recorder, the restore entry (key + store snapshot),
and the panel lookup, launched with Electron logging captured, driven
through this exact 19-step record. A diagnostic build is for diagnosis;
the eventual fix still gets a clean-build round.

## Item 3

Connections sections normal, no Unity section; "No engine" header correct
with Play absent.
