# Codex Computer-Use handoff — DevGame QA round 5

You are the UI driver for a live QA pass on a macOS desktop app. Perceive
through the computer-use MCP's `get_app_state`; target every action from it,
never from a screenshot file. Picture-in-Picture and screen sharing are
BANNED. Screenshots are the evidence record only.

## Target

- App: **DevGame (Alpha)**, `/Applications/DevGame (Alpha).app`, ALREADY
  RUNNING — built from commit `678dfb34b`. Name it in your report. Do not
  rebuild, quit, or relaunch it.

## Item 0 — preflight

`get_app_state` on "DevGame (Alpha)" + one benign Raise. On failure, retry
at most twice, then report exactly `BLOCKED: <verbatim error>` and stop.

## Screenshots

Capture freely wherever your toolset can write; report the directory. An
external collector copies them out continuously. Never write to
`~/Projects` or `/tmp` (EPERM).

## Safety — absolute

1. **Never open, list, or inspect `~/Projects/Deepmind`.**
2. **Do not type into the Terminal panel.**
3. **Do not modify project files by hand.** The ONE sanctioned write is Item
   2's "Setup Unity Integrations" click on **Mafia Game** (owner-authorised).
4. **Do not quit or relaunch the app.**
5. Any OTHER dialog that would write something → cancel and report.

---

## Item 1 — dock tab selection, exact repro, click-by-click (the #108 fix round 2)

Round 4 leaked on this exact sequence; a suppression fix landed since. A
headless repro could NOT reproduce the round-4 leak, so **your literal
click-by-click record is the most valuable artifact this item can produce**
— if it leaks again, the fix team needs the exact sequence, not a paraphrase.

Files and Diff must share ONE tab strip — verify and say so; if not, drag
one into the other's strip and note it.

1. Chat A: click the **Files** tab. Record precisely what you clicked and
   what was focused before. Screenshot.
2. Switch to chat B (record HOW — sidebar click on which item). Click
   **Diff**. Screenshot.
3. Back to chat A. **Must show Files.** Screenshot.
4. Back to chat B. **Must show Diff.**
5. Repeat 1–3 once more, and this time note ALL intermediate states you
   observe during the switch (any flicker of the wrong tab).

If step 3 shows Diff again: the suppression fix did not close the live
leak — say so immediately, and your click record becomes the headline.

## Item 2 — the S9 CTA and the selection-package install (owner-authorised)

Mafia Game's state: Pipeline package installed (Play works), but DevGame's
SELECTION package is missing — chips are silently off. New in this build:
the ready header row must offer the filled **Setup Unity Integrations** CTA
_alongside_ working Play/Stop controls.

1. Open Mafia Game. Record the header row verbatim. Expected: `Unity`
   (plain text) … filled `Setup Unity Integrations` … `Unity` (button) …
   `Play` … `Stop`. If the CTA is absent, say so immediately — the S9
   gating change did not land.
2. **Click the CTA.** Watch the whole transition; quote any toast verbatim
   (it should mention the selection package outcome).
3. Within a few seconds, the CTA must disappear from the header (the probe
   reads the embedded package copy without waiting for Unity). Report the
   timing. Play/Stop must remain.
4. Switch to another project and back — CTA must stay gone.
5. If the install FAILS: quote the error verbatim, screenshot, stop this
   item. Do not retry more than once, never edit files.

## Item 3 — regression spot-checks (brief)

- Settings → Connections: no Unity section, sections render normally.
- Header on a no-engine project reads "No engine", Play absent.
- One screenshot each; terse verdicts.

## NOT in this round

- Pairing and the live chip (the owner performs the token mint + paste in
  Unity afterwards — human steps by design).
- Hover tooltips and Restore/traffic-light geometry (owner-eye checks).

## Reporting

Commit named; OBSERVED vs INFERRED; verbatim text for every toast/error/
accessible name; screenshot directory; UNRUNNABLE with reason for anything
skipped; if a fix did not land, say so immediately and plainly.
