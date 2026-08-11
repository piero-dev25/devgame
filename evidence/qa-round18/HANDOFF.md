# QA round 18 — S14 upgrade offer + legacy migration, live on Mafia Game

Round 17 (evidence/qa-round17/REPORT.md) proved the gap: a paired
LEGACY install classified green and no Setup control rendered. S14 now
exists for exactly that state. This round re-runs the FULL loop.

Rig provenance: commit 84ac7553d, artifact DevGame-0.0.32-arm64.zip
built 2026-08-11 15:51 (S14 marker verified in the installed asar),
installed at "/Applications/DevGame (Alpha).app", app pid 67064,
backend listening on 127.0.0.1:3773. Target project: Mafia Game.
Unity Editor open on it with the LEGACY package still loaded/paired.

Pre-verified BEFORE state (orchestrator-side; your job is the UI):
Packages/com.ironmind.editor-presence PRESENT, new-id dir ABSENT,
legacy Library dir PRESENT, legacy EditorPrefs bearer LIVE.

METHOD RULES (verbatim, as rounds 10-17): perception rides
get_app_state (structured accessibility state) as the PRIMARY channel
on "DevGame (Alpha)"; Picture-in-Picture is BANNED BY NAME; no
screen-sharing; no typing in the Terminal panel; no git controls in
the app; nothing under ~/Projects/Deepmind — do not open, list, or
inspect it; leave the dock layout as found; every claim carries a
VERBATIM excerpt; every absence claim anchored by quoting what IS
present. If the display-name lookup resolves an ambiguous "Electron"
window first (round 17 saw this), resolve via the installed-app path
as round 17 did.

0. PREFLIGHT: get_app_state on "DevGame (Alpha)" + one benign Raise.
   Two failures → BLOCKED. Confirm the Unity "Mafia Game" window
   exists.
1. BASELINE (the round-17 FAIL, now expected to flip): active project
   Mafia Game. Sample the engine toolbar. PASS = a Setup
   Integrations-labeled control IS offered, alongside the working
   transport cluster, AND the setup message (tooltip/status text on
   the cluster) is the upgrade copy mentioning the older package
   (com.ironmind.editor-presence) — quote both verbatim.
2. THE CLICK: click Setup Integrations once. Wait ~20s. Sample
   toolbar + toast/report. Quote the report VERBATIM. PASS = no error
   wording AND the report contains "Removed the old
   com.ironmind.editor-presence package."
3. SETTLE: wait ~60s (Unity reimports the new package + auto-pairs;
   wait out any Unity progress dialog, up to 2 min). Sample the
   toolbar. PASS = quiet Unity state with transport cluster, NO Setup
   CTA anymore, NO stuck "Checking…". Quote.
4. SELECTION CHIP: bring the Unity "Mafia Game" window to front. In
   the Hierarchy single-click "Directional Light". Raise DevGame.
   Sample the composer. PASS = a selection chip "Directional Light".
   Quote.
5. PLAY/STOP ROUND-TRIP: click Play in DevGame; wait ~10s; sample
   (expect engaged Stop face). Bring Unity to front; click Unity's
   own play toggle to stop. Raise DevGame; wait ~5s; sample. PASS =
   Play face restored. Quote both. Leave Unity STOPPED.
6. REPORT: write evidence/qa-round18/REPORT.md — per-item verdicts
   with verbatim excerpts + ONE overall verdict line. Leave app and
   Unity as found.
