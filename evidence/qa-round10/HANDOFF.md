# QA round 10 — no-engine UI gating, live E2E (driver handoff)

## Rig provenance (fixed context — do NOT repair, rebuild, or relaunch anything)

- Build under test: commit `34f054308` ("feat(web): game-harness UI renders
  only for game projects"), packaged as DevGame-0.0.32-arm64, installed to
  `/Applications/DevGame (Alpha).app` and verified by asar content check
  (feature marker present, the old chip text absent, positive control hit).
- App launched 15:03 local; backend pid 85014 listening on 127.0.0.1:3773.
- Unity Editor 6000.3.14f1 is RUNNING with the project
  `/Users/pieroherrera/Projects/Mafia Game`, and its active selection has
  been set to the `Directional Light` GameObject (verified via the pipeline
  CLI `get_selection`: count 1, hierarchyPath "/Directional Light").

## Method rules (owner policy — MUST follow)

- Perception rides `get_app_state` (structured accessibility state) on the
  target app as your primary channel. Screenshot vision is secondary.
  Picture-in-Picture is BANNED BY NAME. Screen sharing is banned.
- Target app: "DevGame (Alpha)". Do not drive any other app. Do not focus
  or interact with the Unity Editor window — the selection is already set
  and must stay untouched.
- NEVER type into the app's Terminal panel. NEVER click "Commit, push & PR"
  or any git action control. Never open, list, or navigate to anything
  under ~/Projects/Deepmind.
- Read-only interaction budget: clicking sidebar project/thread entries and
  scrolling is allowed; do not send messages, do not click Play/Stop, do
  not change settings.
- Evidence = verbatim excerpts of the accessibility state you observed,
  quoted per item in the report. Where a check is about ABSENCE, quote the
  surrounding elements that ARE present so the absence is anchored, not
  vacuous (e.g. quote the header row's actual buttons).

## Items

0. PREFLIGHT: `get_app_state` on "DevGame (Alpha)" + one benign action
   (bring its window frontmost). If either fails twice → report BLOCKED and
   stop. Do not proceed to items on a failed preflight.

1. NON-GAME PROJECT (t3code-fork): in the DevGame sidebar, click the
   "t3code-fork" project entry and open its thread (a "New thread" /
   existing thread view — do NOT send anything).
   VERIFY in the chat header row: the controls "Add action", "Open", and
   "Commit, push & PR" are present, and there is NO element whose text or
   accessible name mentions an engine — specifically no "No engine" badge
   and no engine toolbar cluster.
   VERIFY in the composer area: NO selection chip (nothing named
   "Directional Light"), NO "Editor presence" status text of any kind.

2. GAME PROJECT (Mafia Game): click the "Mafia Game" project entry in the
   sidebar and open one of its threads.
   VERIFY the header shows the Unity control ("Setup Integrations" or a
   "Unity" control with transport icons — either is a PASS; record which).
   VERIFY the composer shows the "Directional Light" selection chip (it may
   take up to ~30s after the project opens for presence to connect — sample
   the state again after a wait before calling it a FAIL).

3. CROSS-PROJECT LEAK (the owner's screenshot scenario): navigate BACK to
   the t3code-fork thread while the Unity editor stays connected with its
   Directional Light selection.
   VERIFY the t3code-fork composer STILL shows NO "Directional Light" chip
   and NO editor-presence text — the Unity connection for Mafia Game must
   not leak into this project's composer. Quote the composer region's
   actual state as the anchor.

## Report

Write `evidence/qa-round10/REPORT.md` (relative to the repo root you were
launched in): one section per item, PASS/FAIL/BLOCKED verdict + the
verbatim state excerpts. End with a one-line overall verdict. Your final
message should be the same overall verdict plus anything anomalous you saw.
