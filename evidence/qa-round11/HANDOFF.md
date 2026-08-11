# QA round 11 — chrome strip + live Unity play state (staged driver parts)

## Rig provenance (fixed — do NOT repair, rebuild, or relaunch anything)

- Build: commits `7ed4f1cff` (Unity play state over presence) +
  `ffafc3728` (chrome strip), packaged DevGame-0.0.32-arm64, installed and
  content-verified; backend pid 74769 (16:58 launch) on 127.0.0.1:3773.
- Unity 6000.3.14f1 running `/Users/pieroherrera/Projects/Mafia Game`,
  editor-presence package 0.3.1 (PlayStateWatcher) resolved + recompiled
  clean; selection = Directional Light.
- The orchestrator fires EXTERNAL editor commands (pipeline CLI) BETWEEN
  driver parts — from the harness's perspective these are identical to a
  human acting inside Unity. Each dispatch names ONE part; execute only it.

## Method rules (owner policy — MUST follow)

- Perception rides `get_app_state` on "DevGame (Alpha)". Screenshot vision
  secondary. Picture-in-Picture BANNED BY NAME. Screen sharing banned.
- Do not interact with the Unity Editor window. Never type into the app's
  Terminal panel. Never click git action controls. Never open anything
  under ~/Projects/Deepmind.
- Evidence = verbatim accessibility-state excerpts per item; anchor
  ABSENCE claims by quoting the elements that ARE present.
- The Unity transport cluster in the Mafia thread header: a toggle button
  whose Description is "Play" when stopped (Value: 0) and a Stop-face
  (engaged) rendering while playing; plus a pause toggle ("Nothing is
  playing to pause." when disabled). Quote Descriptions/Values verbatim.

## PART A — chrome strip + baseline + harness Play

0. PREFLIGHT: `get_app_state` + benign Raise on "DevGame (Alpha)". Two
   failures → BLOCKED, stop.
1. CHROME STRIP: from the window's accessibility tree, quote the TOPMOST
   content row: it must contain the DevGame brand and a sidebar-toggle
   control, and must NOT be a dock tab strip (quote what the first
   elements under the window actually are). Then verify the dock tab
   headers (Sidebar/Browser/Files/Terminal/Diff/Chat tabs) appear BELOW
   that row.
2. SIDEBAR TOGGLE: click the strip's sidebar toggle once → the sidebar
   column disappears (quote state); click again → it returns as the LEFT
   column (not as a tab next to Chat — quote the group structure).
3. BASELINE: open the Mafia Game thread. Verify the Unity transport shows
   the Play face (stopped) and the "Directional Light" chip is in the
   composer.
4. HARNESS PLAY: click the transport's Play toggle once. Unity enters play
   mode (its domain reloads; presence reconnects). Sample the toolbar
   state, then wait ~20s and sample again: final state must show the
   ENGAGED Stop face (playing). Quote both samples.
5. Write `evidence/qa-round11/REPORT-A.md` with verdicts + excerpts.

## PART B — the owner's repro: external stop, no harness click

Context when you run: the orchestrator has JUST stopped play mode
EXTERNALLY (pipeline `editor_stop` — equivalent to the user clicking stop
inside Unity). The harness issued NOTHING.

1. Open/focus the Mafia Game thread. Sample the transport state; if not
   yet flipped, wait ~15s and sample again (up to 3 samples). PASS = the
   toggle shows the Play face (stopped) WITHOUT any harness click this
   part. This is the exact bug #136 re-run. Quote all samples.
2. Write `evidence/qa-round11/REPORT-B.md`.

## PART C — Unity-initiated play, then external pause

Context when you run: the orchestrator has JUST started play mode
EXTERNALLY (harness idle throughout), waited for the reload reconnect,
then paused it externally.

1. Sample the Mafia transport: the Play/Stop toggle must show the ENGAGED
   Stop face (playing arrived with zero harness clicks), and the pause
   toggle must show ENGAGED/pressed (paused). Up to 3 samples 15s apart.
2. Write `evidence/qa-round11/REPORT-C.md`.

## PART D — presence outage observation (documented, not judged)

Context when you run: the orchestrator has QUIT the Unity editor entirely
while the harness sat idle.

1. Sample the Mafia transport + composer: record what renders (expected:
   toolbar falls back to the last command-echo state; the Directional
   Light chip disappears as presence drops). No PASS/FAIL — this is the
   documented honest-bound observation. Quote the state.
2. Write `evidence/qa-round11/REPORT-D.md` and end with a one-line overall
   note.
