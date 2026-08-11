# QA round 17 — renamed package migration + zero-touch install, live on Mafia Game

Rig provenance (E2E doctrine — this round exercises EXACTLY this build):
commit 908cb509a, artifact DevGame-0.0.32-arm64.zip built 2026-08-11
15:21, installed at "/Applications/DevGame (Alpha).app" (asar verified:
new package id + S1 brew string present, UNVERIFIED.md absent from the
bundled package), backend pid 33343 listening on 127.0.0.1:3773.
Target project: Mafia Game (/Users/pieroherrera/Projects/Mafia Game),
Unity Editor believed open on it (lockfile present).

Pre-captured BEFORE state (orchestrator-verified, do not re-verify on
disk — your job is the UI):

- Packages/com.ironmind.editor-presence PRESENT (legacy), new-id dir ABSENT
- Library/com.ironmind.editor-presence PRESENT (stranded, empty), new ABSENT
- Legacy EditorPrefs keys present with a live bearer; DevGame.\* keys absent

METHOD RULES (verbatim, as rounds 10-16): perception rides get_app_state
(structured accessibility state) as the PRIMARY channel on "DevGame
(Alpha)"; Picture-in-Picture is BANNED BY NAME; no screen-sharing; no
typing in the Terminal panel; no git controls in the app; nothing under
~/Projects/Deepmind — do not open, list, or inspect it; leave the dock
layout as found; every claim carries a VERBATIM excerpt from state; every
absence claim is anchored by quoting what IS present.

0. PREFLIGHT: get_app_state on "DevGame (Alpha)" + one benign Raise. Two
   failures → report BLOCKED and stop. Also confirm the Unity Editor
   window for "Mafia Game" exists (list_apps / state). If Unity is NOT
   open, say so explicitly and continue — items 3-5 adapt (the install
   half still proves; pairing completes on next Unity open).
1. BASELINE: make sure the active project in DevGame is Mafia Game (it
   should already be; if a picker is needed, select it — nothing else).
   Sample the engine toolbar. Quote the Unity control cluster verbatim.
   EXPECT a "Setup Integrations"-labeled control to be OFFERED (the
   selection package under its NEW id is not installed yet).
2. THE CLICK: click Setup Integrations once. Wait ~20s. Sample toolbar +
   any toast/report text. Quote the install report VERBATIM. PASS
   requires: no error wording, AND the report contains the legacy-removal
   sentence "Removed the old com.ironmind.editor-presence package."
3. SETTLE: wait ~60s more (Unity reimports the new package and
   auto-pairs; if Unity shows a progress/import dialog, wait it out, up
   to 2 min). Sample the toolbar. PASS = quiet "Unity" state with the
   transport cluster (Play face visible), NO Setup CTA, NO stuck
   "Checking…". Quote.
4. SELECTION CHIP: bring the Unity "Mafia Game" window to front. In
   Unity's Hierarchy, single-click the object "Directional Light".
   Raise "DevGame (Alpha)" again. Sample the composer area. PASS = a
   selection chip showing "Directional Light". Quote the chip text.
5. PLAY/STOP ROUND-TRIP: in DevGame click Play. Wait ~10s, sample
   (expect the engaged/Stop state). Bring Unity to front, click Unity's
   OWN play toggle to stop. Raise DevGame, wait ~5s, sample. PASS =
   toolbar back on the Play face (external stop reflected). Quote both
   samples. Leave Unity STOPPED.
6. REPORT: write evidence/qa-round17/REPORT.md — per-item verdicts with
   the verbatim excerpts, then ONE overall verdict line. Leave the app
   and Unity as found.
