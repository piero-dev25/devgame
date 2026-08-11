# QA round 14 — corner composition + folded-state clearance re-verification

Rig: fix-round-2 commit packaged, installed, fresh backend on
127.0.0.1:3773. Method rules identical to rounds 10-13: get_app_state
primary on "DevGame (Alpha)"; PiP BANNED BY NAME; no Terminal typing; no
git controls; nothing under ~/Projects/Deepmind; verbatim excerpts;
anchor absences.

0. PREFLIGHT: get_app_state + benign Raise. Two failures → BLOCKED.
1. CORNER COMPOSITION at first paint (owner mock): quote the corner
   region's element order and use the secondary screenshot to confirm:
   traffic lights, then the sidebar TOGGLE, then the "> DevGame" brand,
   then a CLEAR GAP before the Sidebar tab — no element overlapping the
   lights or each other. State what you saw visually, verbatim.
2. FOLDED-STATE CLEARANCE (the owner's screenshot bug, zero-area fix):
   click the corner's sidebar toggle (hide). The next group's tab strip
   becomes the (0,0) owner: its first tab (likely "Browser" — note the
   Diff tab may also live there from earlier rounds) must be CLEAR of
   the corner — not at the traffic lights, not under the brand. Quote +
   screenshot-confirm. Toggle back (show): Sidebar tab clear again.
3. Leave the layout as found. Write evidence/qa-round14/REPORT.md with
   verdicts + excerpts and one overall verdict line.
