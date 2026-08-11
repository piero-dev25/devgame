# Codex Computer-Use handoff — DevGame QA round 3

You are the UI driver for a live QA pass on a macOS desktop app. You perceive
the app through the computer-use MCP's `get_app_state` (structured
accessibility state). Target taps from `get_app_state`, never from a
screenshot file.

**Round 2 confirmed three of four round-1 defects fixed and found one still
broken plus two new ones. This round confirms the round-2 fixes and closes
two things round 2 could not prove.**

## Target

- App: **DevGame (Alpha)**, at `/Applications/DevGame (Alpha).app`.
- **Built from commit `1f41acec2`** — name it in your report.
- Do not rebuild it. If it is not running, launch the existing bundle.

## Item 0 — preflight (always first)

1. `get_app_state` on "DevGame (Alpha)"; confirm you can read its tree.
2. One benign action (bring to front); confirm state changes.
3. If either fails — especially an approval denial — **STOP**, do not retry
   more than twice, report exactly `BLOCKED: <verbatim error>` and end. A
   clean blocked report is a complete outcome.

## Screenshots — read this, it is different from round 2

Save screenshots wherever your toolset **can** write, and **report that exact
directory in your report**. Do not fight the filesystem: round 2 burned time
discovering that the Computer Use helper cannot write under `~/Projects` **or**
`/tmp` (`EPERM` — a macOS privacy restriction on that process, not a sandbox
setting), and its own capture directory is fine.

You do **not** need to copy anything out. The orchestrator runs
`scripts/qa/collect-cua-screenshots.sh` alongside you, which copies every
capture into the repo continuously while you work. Round 2's 19 screenshots
were all verified non-empty and then lost because collection happened only at
the end — that is now handled outside your process. Just capture freely.

## Safety — absolute

1. **Never open, list, or inspect `~/Projects/Deepmind`.** Not yours.
2. **Do not type into the Terminal panel.** Open it, confirm a shell starts, stop.
3. **Do not modify project files by hand.** The ONE sanctioned write is Item 5's
   "Setup Unity Integrations" click, which the owner has explicitly authorised
   for the **Mafia Game** project. Everything else is observation only.
4. **Do not quit or relaunch the app** unless it hangs; if it hangs, say so and stop.
5. **Any OTHER dialog that would write something → cancel it and report it.**

---

## The three fixes to confirm

### Item 1 — the Settings Unity panel is GONE

Round 2's worst finding: on the Unity project "Mafia Game", Settings →
Connections → "Unity integration" said **"Not a Unity project — no
ProjectSettings/ProjectVersion.txt was found"** with no status rows and no
Retry, while that same project's chat header correctly said **Unity**. Two
screens contradicting each other.

The cause was scope: that panel always probed the _primary/local backend's_
project, never the one you were looking at. **It has been deleted** — Unity
integration is project-scoped and lives in the chat header.

Open **Settings → Connections** and confirm:

- There is **no "Unity integration" section at all**.
- No "Not a Unity project" text is reachable anywhere in Settings.
- The rest of the Connections screen still renders normally — no blank gap,
  no orphaned heading, no error where the panel used to be.

Report the **full list of sections** you see under Connections. Screenshot.

_(If the panel is still there, say so immediately — that is the single most
important thing this round can report.)_

### Item 2 — the disabled Play button now explains itself on hover

Round 2 confirmed the **accessible name** was correct and specific — it read
back: _"This project doesn't have Unity's Pipeline package, and Unity isn't
open. Add the package, then open the project in Unity."_ But hovering produced
**no visible tooltip** after ~1.8s. A natively-disabled button does not
dispatch pointer events, so sighted mouse users got no explanation at all.

On **Mafia Game**, hover the disabled **Play** button and **wait at least 2
full seconds**.

- Does a **visible tooltip** appear? Quote its text verbatim.
- Report the **accessible name** separately, verbatim.
- Say plainly whether the two **agree**.
- Also try reaching the button by **keyboard** (Tab). Can you focus it? Does
  focusing reveal the explanation?

Do the same for **Stop** and any **"Bring Unity to the front"** control. This
was fixed as a class, so a miss on one of them is a real finding.

**Confirm the button still does not activate**: it must look and behave
disabled — hovering and focusing are expected to work, _clicking must do
nothing_. If clicking Play actually dispatches, report that loudly; that would
be a worse bug than the one being fixed.

### Item 3 — Restore is clear of the macOS traffic lights

Round 2: the "Restore maximized panel" control worked but sat in the extreme
top-left, colliding with macOS's window buttons. Verbatim: _"It looks broken
despite functioning."_

Right-click a dock tab → **Maximize**. Then:

- **Where is the Restore control now?** Describe its position precisely.
- Does it **overlap or crowd** the red/yellow/green traffic lights? Look
  carefully at the screenshot, not just the accessibility tree — this is a
  visual collision and coordinates alone may not show it.
- Is it **also clear of the "Reset workspace layout" button**? Both may be
  visible at once and must not overlap each other either.
- Would you have found it **unprompted**? Answer honestly.

Screenshot maximized and restored.

---

## What round 2 could not prove — close this

### Item 4 — same-group dock tab selection across chats

Round 2 reported per-chat tab selection as a PASS but flagged its own limit:
Browser and Diff sat in **separate dock groups**, so both could be selected
simultaneously and no leak was possible. The mutually-exclusive case was never
exercised.

Exercise it: find **two panels that share one dock group** (tabs sitting in the
same tab strip, where selecting one deselects the other). Then:

1. In chat A, select the **first** tab of that group.
2. Switch to chat B, select the **second** tab of that same group.
3. Switch **back** to chat A.

**Chat A must still show the first tab.** Screenshot each step.

If you cannot find two panels sharing a group, say so and describe the layout
you actually have — that is a useful answer, not a failure.

---

## Item 5 — Setup Unity Integrations, END TO END (the headline of this round)

**The owner has explicitly authorised this write on the Mafia Game project.**
Previous rounds forbade it; that prohibition is lifted. This is the one
sanctioned file-modifying action in this pass.

This is the most valuable item in the round, because the failure it hunts is
one nothing else can catch. A merge-gate review found that the CTA would
**look broken after succeeding**: it refreshed its status through a 5-second
cache and re-read the _pre-install_ answer, so a successful install still
rendered "you need to install this". That was fixed by invalidating the cache
before refreshing — **and that fix has never once been exercised live.**

Do this in order, and screenshot at every numbered step:

1. **Before.** On Mafia Game, record the header verbatim: the CTA's exact
   label, and disabled Play's accessible name (which in round 2 read _"This
   project doesn't have Unity's Pipeline package, and Unity isn't open."_).
2. **Click "Setup Unity Integrations".**
3. **Watch the button through the whole transition** and describe every state
   you observe, in order — does it show a pending/spinner state, does it stay
   filled, does anything flicker? If a toast appears, quote it **verbatim**,
   including whether it is styled as success or failure.
4. **After — this is the assertion that matters.** Within a few seconds and
   _without_ you switching projects, reloading, or restarting anything, the
   header must stop offering setup and settle into the quiet **Unity + Play**
   pair.
   - If the CTA is still showing "Setup Unity Integrations" after ~10 seconds,
     **that is the cache bug surviving its fix — report it immediately and
     prominently.** Note it may self-correct around the 5s mark; if it does,
     say exactly how long it took, because a visible stale window is still a
     defect.
   - If Play became enabled, hover it and say what the tooltip reads now.
5. **Re-check Play's accessible name.** It must no longer claim the Pipeline
   package is missing. Quote the new value verbatim.
6. **Then switch to another project and back.** Confirm the ready state
   persists and wasn't just transient UI.

Report plainly whether a person clicking that button once would believe it
worked. That is the actual acceptance criterion.

If the install **fails**, that is a completely legitimate and valuable result
— quote the error verbatim and stop. Do not try to fix it, retry more than
once, or work around it by editing files yourself.

## Also check

6. **Files** — opens, lists files, clicking one shows content.
7. **Diff** — changes or an honest empty state.
8. **Terminal** — "New Terminal" starts a shell. **Type nothing.**
9. **Browser** — open it, report exactly what it shows.
10. **A project with no engine** — header reads "No engine", Play absent.

## Known-absent — do NOT report as defects

- **Figma/Notion tabs do not exist.** Deleted by owner ruling. Any trace IS a finding.
- **No Godot project on this machine** — Godot Play/Stop is unverifiable.
- **The engine name is plain text, not a picker.** Deliberate: engine is
  detected, never chosen. A clickable engine control IS a regression.

## UI/UX critique — explicitly wanted

Round 2's critique was acted on, so be blunt again. It called out: low-contrast
gray labels app-wide, disabled Play nearly invisible, Browser's empty state
looking like a placeholder, Diff's icon-only toolbar being undiscoverable,
inconsistent Terminal naming ("New Terminal" → "Python" → "Terminal 1"), and a
cramped Files split. **Say which of these are still true** — and anything new.
Only critique screens you actually saw.

## Reporting

- **State the commit.**
- **OBSERVED vs INFERRED**, always distinguished.
- **Verbatim text** for every error, tooltip and disabled-state message.
- **Report the directory your screenshots went to.**
- **Do not report a pass you did not observe.** Mark anything you couldn't run
  UNRUNNABLE with the reason. A named gap beats a claimed pass.
- **If a fix did not land, say so immediately and plainly.** That is the most
  valuable outcome this pass can produce.
