# Final QA pass — DevGame, all three features

> **This is the QA SPECIFICATION — the source of truth for WHAT to verify.
> It is NOT the runnable Codex handoff.** The operational handoff adds the
> Item 0 preflight (`get_app_state` access check), the sandbox's writable
> paths, and the `REPORT.md` output contract this document doesn't define.
> It lives in the dispatch workspace at
> `/Users/pieroherrera/Projects/gamedev-workbench/.claude/worktrees/substrate-research/evidence/qa-final-pass/HANDOFF.md`,
> alongside the `REPORT.md`/`screenshots/` it already writes to.
>
> **Do not dispatch a Codex computer-use run against this file.**
>
> After the QA pass completes, the full evidence bundle (operational
> handoff + REPORT.md + screenshots) moves into this directory as the
> permanent record.

Live UI verification with **computer use**, on a running packaged app. Screenshots
throughout, with direct UI/UX critique. This is the pass that closes the goal.

## The app

**Already running.** `/Applications/DevGame (Alpha).app`, built from commit `566e9c803`.
**Name that commit in your report** — evidence that doesn't name its build isn't evidence.

It is on the owner's **real environment**, so their real projects are present. That is
deliberate: one check needs their live Unity project.

## Build provenance — read before starting

The app under test is /Applications/DevGame (Alpha).app, built from 566e9c803.
That is the commit this report must name.

HEAD is AHEAD of the build. These commits are NOT in this binary:
dc4ad0ca5 decode setup-probe + pipeline-install responses (#99/#100)
d71f1d889 decode command-dispatch responses (#101)

Both touch paths this pass exercises — the setup probe feeds the Connections
panel and the toolbar gating; command dispatch is the Play/Stop path.

DO NOT REBUILD to "get the latest." A rebuild invalidates this entire pass and
changes what is being verified mid-flight. If the app is not running, launch
the existing bundle; do not rebuild it.

If you find a defect on the probe or dispatch path, report it against
566e9c803. Note that the two later commits exist and may already bear on it,
but the finding still stands against the build you actually exercised.

## Safety — read this before touching anything

1. **NEVER open, modify, or run anything against `~/Projects/Deepmind`.** Their real work.
2. **Do not type commands into the Terminal panel.** Open it, confirm it starts a shell,
   stop there. Do not run anything.
3. **Do not modify any file** in any project. This pass is observation only.
4. **Do not click Play for Unity.** It is expected to be disabled; confirm that and move on.
5. **Do not quit or relaunch the app** unless it hangs. If it does, say so and stop.
6. If a dialog appears that would write anything, **cancel it and report it**.

## What to verify

### Feature 3 — Unity integration (do this first; it is the open gate)

1. **Settings → Connections → "Unity integration".** It must resolve to real per-item
   status — CLI, Pipeline package, selection package, live editor. **It must NOT sit on
   "Checking…"**; that was a bug fixed in this build and this is the check that proves it.
   Screenshot it. Report the exact text of every row.
2. **Open the project "Mafia Game"** and look at the **engine toolbar, top right**.
   Expected: Play **disabled**, with a reason naming the missing Pipeline package.
   Screenshot it and quote the exact wording (hover for a tooltip if needed).
   This is the sentence the whole feature exists to produce.

### Feature 1 — engine selector and Play/Stop

3. Confirm the **engine selector** sits in the top-right header, styled like its neighbours.
   Screenshot.
4. Open a project with **no engine** if one exists. Expected: selector reads "No engine",
   **Play absent**. That is correct conditional behaviour, not a bug.

### Feature 2 — the four dock panels

5. **Files** — opens, lists the project's files, clicking one shows content.
6. **Diff** — opens and shows either changes or an honest empty state.
7. **Terminal** — "New Terminal" starts a shell. **Do not type anything.**
8. **Browser** — open it, report exactly what it shows. This panel's desktop code path
   has barely ever run.
9. **Per-thread state** — open some panels in one chat, switch to another chat, switch
   back. **Do the panels and their contents return?** The owner asked about this directly.
10. **Tab behaviour** — right-click a tab, try "Maximize". Report anything odd.

### Known-absent — do not report as defects

- **Figma/Notion tabs do not exist.** Deleted by owner ruling. If you find any trace,
  that IS a finding.
- No Godot project exists on this machine, so Godot Play/Stop is unverifiable.
- Unity automation permission was never granted — do not attempt Unity Play.

## UI/UX critique — explicitly wanted

Critique what you actually see: spacing, alignment, contrast, empty states, whether
messages are clear and honest, anything unfinished or inconsistent. **Be blunt.**
"This looks unfinished" is more useful than politeness. Only critique screens you saw.

## Reporting

- **State the commit.**
- **OBSERVED vs INFERRED**, always distinguished.
- **Verbatim text**, never paraphrased — especially error and disabled-state messages.
- Screenshot every check.
- **Do not report a pass you did not observe.** Mark anything you couldn't run as
  UNRUNNABLE with the reason. A named gap beats a claimed pass.
