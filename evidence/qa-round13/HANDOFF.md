# QA round 13 — corner clearance fix re-verification

Rig: commit a8f0a03a1 packaged, installed, fresh backend pid 61800 on
127.0.0.1:3773. Method rules identical to rounds 10-12: perception via
get_app_state on "DevGame (Alpha)"; PiP BANNED BY NAME; no Terminal
typing; no git controls; nothing under ~/Projects/Deepmind; evidence =
verbatim excerpts; anchor absences with what IS present.

0. PREFLIGHT: get_app_state + benign Raise. Two failures → BLOCKED, stop.
1. FIRST-PAINT CLEARANCE (the round-12 defect): WITHOUT interacting with
   anything first, quote the top band state. PASS = the Sidebar group's
   first tab label is clearly positioned RIGHT of the corner (brand +
   toggle) — not intersecting or under it. Use the secondary screenshot
   channel to confirm visually and state what you saw.
2. HIDDEN-STATE HANDOFF: click the corner's sidebar toggle (hide). Quote
   the NEW (0,0) group's tab strip — its first tab must now be clear of
   the corner (the clearance followed the handoff). Toggle again (show):
   the Sidebar tab must be clear again. Quote all three states.
3. TAB-TARGETED RETURN DROP (round-12 item-3 retry): the "Diff" tab
   currently sits in the Browser group (round-12 residue). Drag "Diff"
   and release PRECISELY on the "Terminal" TAB LABEL (not near it, not
   on empty strip space). PASS = Diff joins the Files/Terminal group
   (its home). Quote before/after tab lists of both groups.

Write evidence/qa-round13/REPORT.md — one section per item, verdicts +
excerpts, one overall verdict line at the end.
