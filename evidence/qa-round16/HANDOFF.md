# QA round 16 — Browser panel loads typed URLs in-panel (guard fix)

Rig: guard-fix commit packaged + installed, fresh backend on
127.0.0.1:3773. Method rules as rounds 10-15: get_app_state primary on
"DevGame (Alpha)"; PiP BANNED; no Terminal-panel typing (the Browser
panel's URL bar IS allowed — it is the subject under test); no git
controls; nothing under ~/Projects/Deepmind; verbatim excerpts.

0. PREFLIGHT: get_app_state + Raise. Two failures → BLOCKED.
1. FRESH-TAB HALF: focus the Browser dock panel. Click "New Tab". In the
   panel's URL bar type exactly: example.com and press Enter. Wait ~5s,
   sample. PASS = the page renders IN the panel (state shows "Example
   Domain" content or the URL bar shows https://example.com/ with page
   text present) and NO external browser activity is triggered by you.
2. LOADED-TAB HALF (the F6 case): in the SAME tab (a page now loaded),
   select the URL bar and type exactly: google.com and press Enter —
   this 301s (apex → www), the previously-broken redirect case. Wait
   ~5s, sample. PASS = Google renders IN the panel (URL bar shows a
   www.google.com URL, page content present in-panel).
3. Write evidence/qa-round16/REPORT.md with verdicts + verbatim excerpts
   and one overall verdict line. Note explicitly whether at any point
   focus left the DevGame app (it must not — external Chrome opening
   would steal focus).
