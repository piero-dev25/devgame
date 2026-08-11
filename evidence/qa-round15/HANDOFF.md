# QA round 15 — brand restored: composition + folded clearance, final driver pass

Rig: brand-fix commit packaged, installed, fresh backend on
127.0.0.1:3773. Method rules identical to rounds 10-14: get_app_state
primary on "DevGame (Alpha)"; PiP BANNED BY NAME; no Terminal typing; no
git controls; nothing under ~/Projects/Deepmind; verbatim excerpts;
anchor absences with what IS present.

0. PREFLIGHT: get_app_state + benign Raise. Two failures → BLOCKED.
1. CORNER COMPOSITION at first paint: the corner must now contain BOTH
   the sidebar toggle AND the brand ("Go to threads" link / "> DevGame").
   Quote the corner elements in order and screenshot-confirm the visible
   left-to-right sequence: traffic lights → toggle → "> DevGame" → clear
   gap → the Sidebar tab. PASS requires the brand VISIBLE (round 14's
   defect was a present-but-unpainted brand — say explicitly what the
   screenshot shows).
2. FOLDED-STATE CLEARANCE: click the corner's sidebar toggle (hide).
   The new (0,0) group's first tab must be CLEAR of the corner — right
   of the brand, nothing at the traffic lights. Quote + screenshot-
   confirm. Toggle back (show): Sidebar tab clear again.
3. Leave the layout as found. Write evidence/qa-round15/REPORT.md with
   verdicts + excerpts and one overall verdict line.
