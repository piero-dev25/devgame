# Codex Computer-Use handoff — DevGame QA round 4

You are the UI driver for a live QA pass on a macOS desktop app. You perceive
the app through the computer-use MCP's `get_app_state` (structured
accessibility state). Target every action from `get_app_state`, never from a
screenshot file. Picture-in-Picture and screen sharing are BANNED. Screenshots
are the evidence record only, never your eyes.

**Round 3 found two real failures. Both are fixed in this build. The headline
is Item 5: the Setup Unity Integrations install, end to end, owner-authorised.
Unlike round 3, the non-destructive items come FIRST — run them all even if
something fails; only Item 5's own sub-steps stop on its failure.**

## Target

- App: **DevGame (Alpha)**, at `/Applications/DevGame (Alpha).app`.
- **Built from commit `3a1562ce8`** — name it in your report.
- Do not rebuild it. If it is not running, launch the existing bundle.

## Item 0 — preflight (always first)

1. `get_app_state` on "DevGame (Alpha)"; confirm you can read its tree.
2. One benign action (the window's Raise action); confirm state changes.
3. If either fails — especially an approval denial — **STOP**, retry at most
   twice, report exactly `BLOCKED: <verbatim error>` and end. A clean blocked
   report is a complete outcome.

## Screenshots

Capture freely wherever your toolset can write and **report that exact
directory**. Do not try `~/Projects` or `/tmp` — both are refused by a macOS
privacy restriction on your process. An external collector copies your
captures out continuously; you never need to move a file.

## Safety — absolute

1. **Never open, list, or inspect `~/Projects/Deepmind`.** Not yours.
2. **Do not type into the Terminal panel.** Open it, confirm a shell starts, stop.
3. **Do not modify project files by hand.** The ONE sanctioned write is Item
   5's "Setup Unity Integrations" click — owner-authorised, on the **Mafia
   Game** project only.
4. **Do not quit or relaunch the app** unless it hangs; if it hangs, say so and stop.
5. **Any OTHER dialog that would write something → cancel it and report it.**

## Not asked this round (deliberately — do not report as gaps)

- Whether tooltips visibly appear on hover: your toolset has no hover
  primitive; twice returned UNRUNNABLE. Owner-eye check now.
- Visual overlap of the Restore control with the traffic lights: needs pixel
  geometry your method rules exclude. Owner-eye check now.

---

## Item 1 — same-group tab selection across chats (the #108 fix)

Round 3 proved the leak with this exact sequence; repeat it exactly. Files and
Diff shared one tab strip in the saved layout — verify that is still true and
say so; if they are now in separate groups, drag one INTO the other's tab
strip first and note that you did.

1. In chat A, select **Files**. Screenshot.
2. Switch to chat B, select **Diff** in that same shared group. Screenshot.
3. Switch back to chat A. **It must show Files.** Screenshot.
4. And back to chat B once more. **It must show Diff.**

Round 3 observed step 3 showing Diff — if you see that again, the fix did not
land; say so immediately.

Also: click a tab in the shared group while a DIFFERENT group is focused
(e.g. click into the chat area first, then click the Files tab directly).
Switch away and back — the click must have been remembered. This targets the
recording half of the fix; round 3 only proved the restore half broken.

## Item 2 — Settings stays clean (regression check)

Settings → Connections: still no "Unity integration" section, no "Not a Unity
project" text, sections render normally. One screenshot. (Round 3 PASS —
confirm it held.)

## Item 3 — panels still work (regression sweep, brief)

- **Files** — opens, lists files, clicking one shows content.
- **Diff** — changes or an honest empty state.
- **Terminal** — "New Terminal" starts a shell. **Type nothing.**
- **Browser** — open it, report exactly what it shows.
- **A project with no engine** — header reads "No engine", Play absent.

One screenshot each. Terse verdicts are fine here.

## Item 4 — the header before install

On **Mafia Game**: record verbatim the row order, the CTA label, and disabled
Play's accessible name. Confirm "Unity" is plain text (role `text`, no menu).
Screenshot. This is the before-state Item 5 is measured against.

---

## Item 5 — Setup Unity Integrations, END TO END (the headline)

**Owner-authorised write on Mafia Game.** Round 3's click failed in ~0.5s with
_"Not a Unity project: /Users/pieroherrera"_ — the routes resolved the
server process's own cwd instead of the selected project. That is fixed: the
client now sends the project's id and the server resolves the real project
root. Your job is to prove the whole loop.

Also still untested from before: a reviewed-and-fixed bug where the CTA would
**look broken after succeeding** (a 5s cache served the pre-install answer).
If the install succeeds but the CTA lingers, that is this bug's ghost —
report the exact timing.

Do this in order, screenshot at every numbered step:

1. **Click "Setup Unity Integrations".**
2. **Watch the whole transition** — every state, in order: pending/spinner?
   toast? Quote any toast verbatim, and whether styled success or failure.
3. **The assertion that matters:** within a few seconds, without switching
   projects or reloading, the header must stop offering setup and settle to
   the quiet **Unity + Play** pair.
   - CTA still present after ~10s → the cache bug's signature — report loudly.
   - If it corrects itself late, report exactly how long the stale window was.
4. **Play's accessible name now** — quote it verbatim. It must no longer
   claim the Pipeline package is missing. (Unity is likely CLOSED on this
   machine: a message about opening Unity is CORRECT in that case — quote it,
   don't fail it.)
5. **Switch to another project and back.** The ready state must persist.
6. **If the install FAILS**: quote the error verbatim, screenshot, stop Item
   5 there — that is a valuable result, not a botched round. Do not retry
   more than once, never edit files yourself.

Then answer plainly: **would a person who clicked that button once believe it
worked?** That is the acceptance criterion.

## UI/UX critique

Only what you actually saw, structural observations welcome; skip anything
needing pixel judgment (owner-eye now — see "Not asked this round").

## Reporting

- **State the commit.** OBSERVED vs INFERRED, always distinguished.
- **Verbatim text** for every toast, error, and accessible name.
- **Report your screenshot directory.**
- Mark anything you couldn't run UNRUNNABLE with the reason. A named gap
  beats a claimed pass.
- **If a fix did not land, say so immediately and plainly.**
