# QA round 12 — the unified top band (driver items)

Rig: commit 984e633d8 packaged, installed, fresh backend pid 96958 (19:43)
on 127.0.0.1:3773. Method rules as all prior rounds: perception via
get_app_state on "DevGame (Alpha)"; PiP BANNED BY NAME; no Terminal
typing; no git controls; nothing under ~/Projects/Deepmind. Evidence =
verbatim accessibility excerpts; anchor absences with what IS present.

0. PREFLIGHT: get_app_state + benign Raise. Two failures → BLOCKED, stop.
1. ONE BAND: quote the topmost content region. PASS = a compact corner
   (brand + sidebar toggle) at top-left AND the dock groups' tab strips
   (Sidebar/Browser/Files/Terminal/Diff/Chat tabs) at the SAME top band —
   NO full-width 52px strip row above the tabs any more. Note the Sidebar
   group's first tab is NOT hidden under the corner (its tab label must
   be present and positioned right of the corner region).
2. DOCK BOTTOM: verify the layout's bottom (the chat composer / panel
   content) reaches the window bottom — no clipped composer edge (quote
   the lowest elements).
3. TAB DND INTACT: drag the "Diff" tab and drop it ONTO the "Browser"
   tab (a no-drag island — drops onto tabs must work). PASS = the Diff
   tab now lives in the Browser group (quote the group's tab list before
   and after). During the drag, note whether drop overlays appeared
   (expected: yes, during a real tab drag — that is correct behavior).
   Then drag it back the same way.
4. SIDEBAR TOGGLE: click the corner's sidebar toggle twice (hide + show)
   — sidebar column leaves and returns to the LEFT slot; after the cycle,
   quote the corner-owner group's tab strip (the corner clearance must
   have followed whichever group was at (0,0) while hidden, and returned).
   Write evidence/qa-round12/REPORT.md, one section per item, overall
   verdict line at the end.
