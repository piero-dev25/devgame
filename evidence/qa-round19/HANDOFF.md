# QA round 19 — ONE-CLICK legacy migration end to end (forceMint build)

Round 18 (evidence/qa-round18/REPORT.md) proved the S14 CTA renders and
the sweep runs, but pairing was skipped (alreadyPaired early-exit on the
doomed legacy publisher — root-caused via server trace, fixed: the
route now FORCES the mint when its own sweep removed a legacy dir).
This round re-runs the FULL loop on the fixed build against a restored
paired-legacy baseline.

Rig provenance: commit 401da162a, artifact DevGame-0.0.32-arm64.zip
built 2026-08-11 16:2x (marker "package_resolve outcome after install"
verified in installed asar), app relaunched fresh (pid 81829), backend
127.0.0.1:3773. Mafia Game project; the LEGACY package
com.ironmind.editor-presence was restored from pre-rename history and
Unity recompiled it (Editor.log confirms Ironmind.EditorPresence dll);
legacy EditorPrefs bearer present; new-id package ABSENT.

METHOD RULES (verbatim, rounds 10-18): perception rides get_app_state
as the PRIMARY channel on "DevGame (Alpha)"; Picture-in-Picture is
BANNED BY NAME; no screen-sharing; no Terminal-panel typing; no git
controls; nothing under ~/Projects/Deepmind — do not open, list, or
inspect it; leave the dock layout as found; every claim carries a
VERBATIM excerpt; absences anchored by quoting what IS present. If the
name lookup hits an ambiguous "Electron" window, resolve via the
installed-app path as rounds 17-18 did.

0. PREFLIGHT: get_app_state on "DevGame (Alpha)" + one benign Raise.
   Two failures → BLOCKED. Confirm the Unity "Mafia Game" window.
1. BASELINE: active project Mafia Game. Sample the toolbar. PASS = a
   Setup Integrations control IS offered alongside the transport
   cluster. Quote the cluster. (The S14 upgrade copy lives in the
   cluster's tooltip/aria surface — quote it if present in state, but
   its absence from the accessibility tree is NOT a fail this round;
   the CTA presence is the load-bearing check.)
2. THE CLICK: click Setup Integrations once. Sample TWICE: at ~5s
   (toasts can auto-dismiss — this catches the install report) and at
   ~20s. Quote any toast/report text verbatim from whichever sample
   carries it. PASS = no error wording; the report/toast text, if
   captured, should mention the legacy removal ("Removed the old
   com.ironmind.editor-presence package.") — quote exactly what you
   see; if no toast is capturable in either sample, say so and
   continue (the orchestrator verifies the mint on disk).
3. SETTLE (patient this round — this machine reimports slowly):
   sample the toolbar at ~60s, ~120s, and ~180s after the click, or
   stop early once settled. PASS = by the final sample, quiet Unity
   state with transport cluster, NO Setup CTA, NO stuck "Checking…".
   Quote each sample briefly, the final one fully. If Unity shows an
   import/progress dialog at any point, note it and wait it out.
4. SELECTION CHIP: bring Unity's "Mafia Game" window to front. In the
   Hierarchy single-click "Directional Light". Raise DevGame. Sample
   the composer. PASS = a selection chip "Directional Light". Quote.
5. PLAY/STOP ROUND-TRIP: click Play in DevGame; wait ~10s; sample
   (expect engaged Stop face). Bring Unity to front; click Unity's own
   play toggle to stop. Raise DevGame; wait ~10s; sample. PASS = Play
   face restored. Quote both. Leave Unity STOPPED.
6. REPORT: write evidence/qa-round19/REPORT.md — per-item verdicts
   with verbatim excerpts + ONE overall verdict line. Leave app and
   Unity as found.
