# Final QA plan — P4, the pass that marks the goal done

Written, not run, per the team lead's instruction — this is the checklist a
computer-use driver (or a human) executes later. It is not a status report.

## The goal this closes

> Once we have the 3 laid out features done, run a last overall QA pass on
> computer use to mark the goal done.

Plus the owner's standing bar: _"Tests are not enough, you need to verify
live when possible. Screenshots with critics on the UI/UX."_

Tests passing is a precondition for running this plan, not a substitute for
it. Every check below has a **live** pass condition — something a driver (or
a human) observes happening in the running app, not a `vitest` exit code.

## Ground rules (apply to every section below)

1. **Computer use routes through Codex dispatches** (owner policy). Any item
   that requires OS-level clicking/typing outside the app's own web UI is
   driven via the `codex-computer-use` skill's dispatch/watch lifecycle, not
   directly by whoever is running this plan.
2. **Computer Use has never been granted for the Unity Editor.** An earlier
   lane hit an explicit refusal dispatching against it — it needs a live
   human to click "Always allow" in the Codex Desktop app first, once, the
   same one-time grant every other driven app already required. Section A's
   Unity checks are written to need the LEAST possible OS-level control
   (drive Play from the browser toolbar; only _observe_ the Unity Editor
   window, don't type into it) specifically so most of them are runnable
   before that grant exists. The two that still need it are marked
   **OWNER-GATED**.
3. **Never mutate `~/Projects/Deepmind`.** It is the owner's real project.
   Every check that needs a live engine project uses a disposable one
   (mirroring the `unity-selection-plugin` and `#65` repro conventions —
   `$CLAUDE_JOB_DIR/tmp/` or an equivalent scratch directory, never the
   owner's real checkout). Reading Deepmind's files to _confirm_ a claim
   (e.g. "does it have `com.unity.pipeline` installed") is fine; opening its
   Editor, running Play/Stop against it, or writing into it is not.
4. **Evidence, not vibes.** Every checklist item names what to capture
   (screenshot, network trace, console log, or a specific piece of on-screen
   text) — "looks right" is not a pass condition anywhere in this document.
5. **Screenshot + UI/UX critique points are marked 📸.** At each one, capture
   the frame and run it past a critic pass (composition, affordance clarity,
   whether a disabled control's reason is discoverable without a screen
   reader, whether the state is visually distinguishable from its
   neighbors) — the owner asked for critique, not just a picture attached to
   a checkbox.

## Launching the app under test

`npm run start:desktop` (builds and launches the DevGame desktop app) or
`npm run dev:desktop` (dev mode, hot-reload) from the repo root. The desktop
app is the correct target, not a browser tab — `isPreviewSupportedInRuntime()`
gates three.js preview specifically to the desktop runtime (see A3 below),
so running this whole plan against a browser tab would make that one section
unrunnable and everything else potentially non-representative of what the
owner will actually use.

---

## Section A — Play/Stop per engine

Preconditions common to this whole section: a project open in the app whose
engine has been detected or manually selected (engine selector, top-right of
the chat header — `data-engine-toolbar="true"`), and — for the two
presence-driven checks (A2) — this session holds `presence:command` scope
(Settings → Connections → the pairing-link scope option; the toolbar's own
degraded state, A2.4, is what to check if this is skipped).

### A1 — three.js

Precondition: a project with a `package.json` script. Two sub-states,
**both must be checked**, not just the happy path:

| #                                                                  | Check                                                                          | Evidence                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1.1                                                               | Project has a script with "Open preview automatically" configured. Click Play. | The dev-server script actually starts (visible in Terminal panel output or process list) and a preview surface opens. 📸 the running preview.                                                                                                                                                                    |
| A1.2                                                               | Same project, Play again while already running.                                | Does not spawn a second dev-server process — reuses or restarts cleanly, no orphaned process. Evidence: process list before/after, or the dev-server's own "already running" log line if it has one.                                                                                                             |
| A1.3 (negative)                                                    | Project with **no** script configured with "Open preview automatically".       | Play button is disabled. Tooltip text is **exactly** `No script has "Open preview automatically" configured for this project.` (verbatim from `ChatView.tsx`'s `threeJsUnavailableReason`) — not a generic "unavailable." 📸 the disabled button + tooltip.                                                      |
| A1.4 (negative, **only if a browser-tab fallback is ever tested**) | Same app state, but loaded in a plain browser tab instead of the desktop app.  | Play button disabled, tooltip **exactly** `Preview only runs in the DevGame desktop app, not a browser tab.` This check is informational (confirms the desktop-only gate is honest) — the rest of this plan runs in the desktop app per "Launching the app," so don't let this become the primary three.js pass. |

### A2 — Godot (the one engine-presence-command path currently live; Unreal is `#50`, still pending — see "Open scoping question" below)

Precondition: a disposable Godot project with `godot/addons/editor_presence/`
installed (per that addon's own README — copy the inner `editor_presence/`
folder into `addons/`, enable the plugin, pair via `t3 pair`, **not** the
server's own startup banner code). Godot Editor open with the addon
connected (toolbar dot green).

| #                                                                                                                             | Check                                                                                                                 | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A2.1                                                                                                                          | Engine selector set to Godot, editor connected. Toolbar renders.                                                      | Control cluster shows exactly the actions the addon advertised (`["play","stop"]` per the addon's own `CAPABILITIES` constant — no Pause, no Step, since Godot has no scriptable frame-step). 📸.                                                                                                                                                                                                                               |
| A2.2                                                                                                                          | Click Play.                                                                                                           | Godot Editor **actually enters Play mode** (its own Play button highlights / a running scene window opens) — not just "the command was accepted." Toolbar's Play button reflects `playState: "playing"` (highlighted/engaged per `isPlayEngaged`) within a few seconds. 📸 both the app's toolbar AND the Godot Editor window in the same frame, timestamped close together, so the causal link is visible, not just plausible. |
| A2.3                                                                                                                          | Click Stop.                                                                                                           | Godot Editor exits Play mode; toolbar's Play button returns to un-engaged. 📸.                                                                                                                                                                                                                                                                                                                                                  |
| A2.4 (negative)                                                                                                               | No connected Godot editor for this project (addon not running, or wrong project open).                                | Control cluster shows a single disabled Play-shaped button, tooltip **exactly** `No editor is connected for this project.` 📸.                                                                                                                                                                                                                                                                                                  |
| A2.5 (negative)                                                                                                               | Editor connected, but this session lacks `presence:command` scope.                                                    | Control cluster shows a single Play-shaped button whose click opens Settings → Connections instead of sending a command; tooltip **exactly** `This session can't send engine commands yet. Grant "Control connected editors" in Settings → Connections.` 📸.                                                                                                                                                                    |
| A2.6 (reconnect resilience — real risk per `docs/workbench/spec-editor-presence.md`, domain reload fires on every Play press) | After A2.2/A2.3, force a Godot script recompile (any trivial script edit) to trigger a domain reload while connected. | Toolbar recovers to `hasConnectedEditor: true` within a few seconds without a manual reconnect action, and a subsequent Play still works.                                                                                                                                                                                                                                                                                       |

### A3 — Unity (server-side CLI path, not Editor Presence — see `unity/README.md`)

Precondition: a disposable Unity project (`unity open <path>`, per the
`unity-selection-plugin` session's own recipe — **never** `~/Projects/Deepmind`),
Unity 6000.3.14f1, `com.unity.pipeline` installed. The `unity` CLI binary
resolvable on the machine's PATH.

| #                                    | Check                                                                                                                                                                                                                 | Evidence                                                                                                                                                                                                                                                                                                                                                          | Drivable via app UI alone?                                                                                                                                                                                                                                      |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A3.1                                 | Engine selector set to Unity, Unity Editor open for this project. Click Play.                                                                                                                                         | Server calls Pipeline's `editor_play`, then reads status back to CONFIRM (`UnityPipelineClient.play`'s own "assert the effect" contract — it does not report success on the command being merely accepted). Unity Editor **visibly enters Play mode**. 📸 the Unity Editor window showing Play mode active, plus the app's toolbar.                               | Yes — click Play in the browser/desktop-app UI; only _observe_ Unity, don't drive it.                                                                                                                                                                           |
| A3.2                                 | Click Stop.                                                                                                                                                                                                           | Unity exits Play mode; confirmed via the same status-readback path. 📸.                                                                                                                                                                                                                                                                                           | Yes                                                                                                                                                                                                                                                             |
| A3.3 (negative — **notReady**)       | Unity Editor is **not open** for this project (or is mid domain-reload). Click Play.                                                                                                                                  | Result tag is `notReady` — per `UnityCommandRoute.ts`'s own contract, this must reach the client as a **distinct** state, not folded into a generic error. Record the actual on-screen text shown (toast/banner — this plan does not presuppose exact copy here; capture it and confirm it says something like "no Editor open," not "something went wrong"). 📸. | Yes                                                                                                                                                                                                                                                             |
| A3.4 (negative — **cliUnavailable**) | The `unity` CLI is not on PATH (simulate by temporarily renaming it or running against a `PATH` without it, server-side).                                                                                             | Result tag is `cliUnavailable`, again a **distinct** client-visible state from `notReady` — the whole point of `UnityPipelineClient`'s four-tag result shape is that these two don't collapse into one message. Record the actual text shown.                                                                                                                     | Yes (server-side PATH manipulation, not OS-level Unity interaction)                                                                                                                                                                                             |
| A3.5 **OWNER-GATED**                 | Confirm the Unity Editor's own on-screen Play/Pause/Stop buttons visibly change state in sync with A3.1/A3.2, using Computer Use to inspect the Unity window directly (rather than trusting the app's toolbar alone). | Screenshot of the Unity Editor's own toolbar.                                                                                                                                                                                                                                                                                                                     | **No** — this is the one Unity check needing direct OS-level Unity interaction. Requires the one-time Computer Use grant for Unity from a live human first. Until granted, mark this row `BLOCKED — awaiting Unity Computer Use grant`, don't skip it silently. |

**Open scoping question, not resolved unilaterally:** `#55` is formally
`blockedBy` task `#50` (Unreal Play/Stop), which is still `pending`. The
team lead's own feature list for this QA pass names only three.js, Godot,
and Unity. If Unreal is meant to ship in this wave, add an "A4 — Unreal"
section mirroring A2's shape (it shares Godot's `editor-presence` backend
per `EngineToolbar.logic.ts`) before running this plan. If Unreal is
deliberately deferred past this wave, `#50` should be removed from `#55`'s
`blockedBy` list so the task graph matches the actual scope. Flagging rather
than guessing.

---

## Section B — Four dock panels, per-thread state

**The behavior the owner explicitly asked about:** each chat thread keeps
its own open files, diff scope, and terminal sessions — switching to a
different chat and back must restore them, not reset or bleed between
threads. This is the single most owner-salient check in this whole plan;
give it real weight, not one line.

Precondition: two (or more) distinct chat threads open in the same project,
each in a different dock-panel state (see B1–B3 setup steps).

| #                        | Check                                                                                                                                                                                                     | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1.1 (Files)             | In thread A, open two files in the Files panel (different from thread B's). Switch to thread B, open a different file. Switch back to thread A.                                                           | Thread A's Files panel shows exactly the two files it had open, not thread B's, not a union, not empty. 📸 before-switch and after-switch-back, side by side.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| B1.2 (Diff)              | In thread A, select a specific turn's diff (not the default "latest"). Switch to thread B (different diff scope, e.g. "Working tree"). Switch back to A.                                                  | Thread A's Diff panel still shows the same turn selected, not reset to latest/working-tree. 📸.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| B1.3 (Terminal)          | In thread A, open a terminal and run a long-lived command (e.g. `sleep 300` or a dev server) so it has visible, distinguishing output. Switch to thread B, open a _different_ terminal. Switch back to A. | Thread A's terminal is the **same PTY session** — its running command is still executing, output continues, not a fresh shell. This is the exact regression `TerminalDockPanel.test.tsx` was written to catch (reattach vs. respawn) — the live version of that same proof. 📸 the terminal's continuous output timestamp spanning the switch.                                                                                                                                                                                                                                                |
| B1.4 (Browser)           | In thread A, open a preview URL in the Browser panel. Switch to thread B (different or no URL loaded). Switch back to A.                                                                                  | Thread A's Browser panel still shows the same URL/page state, not reset to blank or thread B's. 📸.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| B2 (restart persistence) | With threads A and B each in a distinct dock-panel state (per B1.1–B1.4), fully quit and relaunch the desktop app.                                                                                        | Reopen thread A: same files/diff-scope/browser-URL restored. Terminal sessions specifically: confirm whether a restarted PTY reattaches or shows as ended-but-history-preserved — either is acceptable, but record which one actually happens (don't assume). This exercises the zustand `persist`+`localStorage` backing (`diffPanelStore.ts`, `terminalDockStore.ts`, `fileExplorerStore.ts`, `rightPanelStore.ts`) — the panel **layout** (open/closed/arranged) surviving restart was already proven separately (`#33`); this check is specifically about panel **content** surviving it. |
| B2 (negative)            | A thread that was never opened in this session (no prior dock-panel activity).                                                                                                                            | Opening its dock panels shows sensible empty states (Files: "no files open," not a crash; Diff: default scope; Terminal: no sessions), not an error boundary. `PanelErrorBoundary.tsx` / `QuarantinePanel.tsx` exist for a reason — if one fires here, that's a finding, not an expected state.                                                                                                                                                                                                                                                                                               |
| B3                       | Open all four panels simultaneously for one thread, in a layout that isn't the default preset (drag one to a new position).                                                                               | Layout survives a thread switch and a restart (already covered by `#33`'s own proof — this is a quick spot-check, not a re-derivation). 📸 the non-default arrangement.                                                                                                                                                                                                                                                                                                                                                                                                                       |

---

## Section C — Figma/Notion tabs with "Add to chat"

**Read this before running this section.** As of this writing, two things
are true simultaneously and must both be checked before assuming the
feature is testable at all:

1. **`#75`'s security findings are unresolved.** F1 (third-party pages
   silently granted preview-tier permissions — geolocation/clipboard, no
   prompt) is rated blocking. F5 (Google SSO popups are swallowed —
   `allowpopups` missing on the third-party webview — so the standard login
   path for both Figma and Notion doesn't work) means the feature may not
   even be usable end-to-end regardless of security posture. **Confirm F1
   and F5 (at minimum) have landed fixes before running C1–C3** — running
   this section against unpatched code would either produce a false pass
   (login silently fails, so nothing meaningful gets tested) or exercise a
   real security hole. If they haven't landed, mark this whole section
   `BLOCKED — #75 not resolved`, do not improvise around it.
2. **`ThirdPartySourceDockPanel` is not wired into the dock yet** — `#75`'s
   own calibration note confirms it's not registered anywhere `DockviewLayout.tsx`
   or the panel-open path (`dock/lib/openPanel.ts`) can reach. Confirm it
   has been registered (grep for `ThirdPartySourceDockPanel` in those two
   files) before assuming there's a UI entry point to drive at all.

Once both preconditions are confirmed:

| #                                                                      | Check                                                                                                                                                                                                                                      | Evidence                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1                                                                     | Open a Figma file tab.                                                                                                                                                                                                                     | Figma loads and renders inside the panel (not a blank/error webview). Sign-in, if not already authenticated, actually completes (this is F5's exact regression surface — treat a swallowed SSO popup as a hard fail, not a "login separately then retry"). 📸.                                                                                                               |
| C2                                                                     | Same for a Notion page tab.                                                                                                                                                                                                                | Same bar as C1. 📸.                                                                                                                                                                                                                                                                                                                                                          |
| C3                                                                     | From a Figma or Notion tab, use "Add to chat."                                                                                                                                                                                             | The referenced content (page/frame identity, not a screenshot-only blob, unless that's the deliberate design) lands in the composer/thread in a form the agent can actually use — confirm by asking the agent a question that requires the added content and checking its answer references it correctly. 📸 both the "Add to chat" action and the resulting composer state. |
| C4 (negative)                                                          | Attempt "Add to chat" before the tab has finished loading, or on a page that failed to load.                                                                                                                                               | Fails visibly and specifically (not a silent no-op, not a broken/blank attachment sent to the thread).                                                                                                                                                                                                                                                                       |
| C5 (security spot-check, not a full re-audit — `#75` already did that) | With the browser devtools reachable for the third-party webview (or via the same probe method `#75`'s review used), confirm the third-party session does **not** silently grant geolocation/clipboard permissions (F1's exact regression). | No unprompted "granted" result for either permission against the third-party partition.                                                                                                                                                                                                                                                                                      |

---

## What should NOT block marking the goal done

These are known, tracked, understood gaps — surfacing them here is what
makes a "done" claim honest, not what prevents making it:

- **`#65`** — Unity `.meta`-file GUID-orphaning on revert. Reasoned from
  code, not yet reproduced; the task's own next step is establishing the
  repro before designing a fix. Does not block this QA pass (nothing in
  Sections A–C reverts a Unity checkpoint), but worth a one-line mention in
  the final report since it's product-risk for the exact audience (Unity
  developers) this whole effort targets.
- **`#69`** — Unity intentionally bypasses `EditorPresenceRegistry` (its own
  CLI path instead, Section A3 above). Deliberate, deferred architecture
  work, not a defect.
- **`#71`'s coverage gap** — the wrong-project-selection bug itself is
  fixed and verified; what's open is that no _automated_ test guards
  `ChatView`'s call site (a unit-level substitute was sanctioned instead).
  This QA pass's live editor-presence chip observations (anywhere Godot/
  Unity selection surfaces in the composer) are exactly the kind of
  live check that closes this gap in practice, even without closing the
  automated-test gap — worth explicitly confirming a chip shows the RIGHT
  project's selection somewhere in Section A2/A3 as a bonus check, but its
  absence from this plan's pass/fail is not itself a blocker.
- **`#73`** — active scene name isn't on the Editor Presence wire yet (the
  engine-context headline can show engine+version+play-state+selection
  count, not the scene). If the headline is visible anywhere in this QA
  pass, confirm it degrades honestly (no scene field shown, not a fake
  placeholder) rather than treating the missing scene as a defect to fix
  here.
- **`#74`** — `apps/web` has no test infrastructure that executes a mount
  effect (`renderToStaticMarkup` only). This is exactly why this document
  exists as a _live_ QA plan rather than trusting the test suite for
  mount-time/effect-driven behavior — it's the gap this plan is compensating
  for, not a gap this plan needs to additionally flag as broken.
- **`#76`** — rejecting an oversized message amplifies the rejection back
  into the thread (131k+ chars, plus a leaked server file path). Unrelated
  to any of the three features under test; do not let a QA pass wander into
  reproducing it, but if it's encountered incidentally (e.g. while testing
  "Add to chat" with a very large Figma page), note it and move on rather
  than debugging it inline.

## Sign-off shape

Not a single pass/fail bit. For each section (A/B/C), record: checks run,
checks passed, checks that were `BLOCKED`/`OWNER-GATED` with the specific
reason, and the screenshot set with critique notes. The goal is marked done
when every non-gated check in A and B passes, C either passes or is
explicitly and correctly marked blocked on `#75` (not silently skipped), and
the "what should NOT block" list above is attached to the final report
verbatim so the owner sees exactly what's knowingly deferred alongside what
was actually verified live.
