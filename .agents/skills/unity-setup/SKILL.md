---
name: unity-setup
description: Diagnose why a Unity project's Play/Stop or selection integration with DevGame isn't working, and carry out the correct, specific remedy for whatever is actually blocking it — reads Packages/packages-lock.json, Packages/manifest.json, ProjectSettings/ProjectVersion.txt, and the unity CLI directly rather than guessing from symptoms. Use when a user says Unity isn't connecting, Play doesn't work, selection chips are empty, Pipeline is missing, or asks to set up or fix the Unity integration.
---

# Unity setup: diagnosis and remedy

**STATUS: draft.** This skill is not wired to any button or automated trigger
today — nothing in DevGame invokes it. It exists so an agent that has been
asked to fix a Unity setup problem in chat has the same diagnostic knowledge
`UnitySetupClassifier.ts` encodes, instead of guessing from symptoms.
Deliberately MVP-simple, per owner ruling: no confirmation step before
writing. The user asking for this (or clicking a "Setup Unity Integrations"
action whose whole label is the task) is the consent — don't ask again. See
`docs/workbench/plan-setup-integration.md` (task #92) for the separate,
already-in-progress, non-agentic path to the same goal (a button plus a
dialog in Settings) — the two paths are independent, not layered: that one
stays exactly as it is.

## Why this exists

Running the right command isn't the hard part of Unity setup. Telling apart
14 states that all look similar from the outside is. That knowledge lives in
one file, `apps/server/src/unity/UnitySetupClassifier.ts` (states `S1`–`S13`,
in the priority order it evaluates them), backed by
`packages/contracts/src/unitySetup.ts` and cross-checked against a real
critique pass in `docs/workbench/plan-setup-integration-critique.md`. This
skill restates that logic so an agent can apply it directly, using only tools
it already has — it does not call any DevGame API, because none exists for
this yet (no MCP tool exposes Unity state or writes; the HTTP routes
DevGame's own web UI uses require that UI's own session credential, which an
agent does not hold). Gather every fact yourself, from the project's files
and the `unity` CLI.

If this skill and `UnitySetupClassifier.ts` ever disagree, the code is right
and this file is stale — fix this file, not the other way around.

## Non-negotiables

1. **`Packages/packages-lock.json` is authoritative for "is it installed."
   `Packages/manifest.json` is declared intent, never proof.** In the
   owner's own real project, 14 of 59 resolved packages — including one
   _embedded_ package — are absent from `manifest.json` entirely. Classifying
   "installed" from the manifest produces a false "missing" and offers to
   install a duplicate. Read the lock.
2. **Verify with a fresh probe. Never assert.** "I've set it up" is your
   opinion. The last step of every remedy below is: re-gather the facts and
   confirm the state actually changed. If you can't observe that, say so —
   don't claim success.
3. **Write directly once you've diagnosed a fixable state — no confirmation
   step.** The request that invoked this skill is the consent; asking again
   is friction, not safety. Report what changed after the fact, and still
   keep the manual command on hand — not as a gate, but because the user
   may want to run it themselves, or need it if the automated attempt
   fails.
4. **Run commands with your own shell tool, not DevGame's `runProjectScript`
   / dock terminal mechanism.** That path writes keystrokes into a PTY and
   never observes the result — you'd have no way to know if a command
   succeeded. Your own command-execution tool gives you real captured
   stdout/stderr/exit code; use that.
5. **When the CLI's own message is the best information available, show it
   verbatim.** Don't paraphrase an error you don't fully understand into a
   friendlier-sounding but possibly wrong sentence — that exact mistake
   (`S7`'s original "reloading scripts, clears on its own" text, which
   turned out to also fire for Safe Mode — which does _not_ clear on its
   own) is why `UnitySetupClassifier.ts` looks the way it does today. Don't
   reintroduce it.

## Step 0 — gather the facts

Run these from the project root you're diagnosing (call it `$PROJECT_ROOT`).
Do this every time — don't reuse a stale answer from earlier in the
conversation.

```bash
# 1. Is this even a Unity project?
test -f "$PROJECT_ROOT/ProjectSettings/ProjectVersion.txt"
# No → stop. This skill doesn't apply.

# 2. Is the Unity CLI on PATH?
command -v unity
# Found → cliAvailable = true, skip to 4.

# 3. Not on PATH — check the one location DevGame's own probe knows to look
# for (nothing else; a real install anywhere other than this exact path
# will not be auto-discovered by this check, or by DevGame's probe today):
test -x "$HOME/.unity/bin/unity"

# 4. What does Unity itself report is running, for THIS project?
# CWD matters here — the CLI's own instance list depends on the directory
# it's invoked from, confirmed live (UnityPipelineClient.ts's `list` doc
# comment): invoking it from anywhere other than the project root can
# inject a phantom, unrelated instance entry.
( cd "$PROJECT_ROOT" && unity pipeline list --json )
# Match the entry whose "projectPath" equals $PROJECT_ROOT. `pipeline list`
# has no --project-path filter — it lists every Editor instance on the
# machine; matching is your job.

# 5. What's actually RESOLVED? (authoritative — see non-negotiable #1)
cat "$PROJECT_ROOT/Packages/packages-lock.json"
# Check .dependencies["com.unity.pipeline"] and
# .dependencies["com.ironmind.editor-presence"] — presence of the KEY means
# installed, regardless of its "source" (registry/git/local/embedded all
# count equally).

# 6. What does the manifest DECLARE? (intent only — see non-negotiable #1)
cat "$PROJECT_ROOT/Packages/manifest.json"

# 7. Ambient "is Unity holding this project open" signal — cheap, but NOT
# authoritative on its own; step 4's matched, isRunning instance is. Use
# this only to distinguish "genuinely closed" (no lockfile) from "lockfile
# present but pipeline list hasn't confirmed liveness yet" — treat that
# second case as unknown, not as open.
test -f "$PROJECT_ROOT/Temp/UnityLockfile"
```

## Step 1 — classify, in this order

Evaluate top to bottom; stop at the first match. This mirrors
`classifyUnitySetup`'s own priority exactly (CLI availability gates
everything, then Pipeline package + liveness, then the selection package).

| #                                                     | Recognize by                                                                                                                | Say                                                                                                                                                      | Remedy                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **S1**                                                | `unity` not on PATH, not found at `~/.unity/bin/unity` either                                                               | _"Unity's command-line tool isn't installed on this machine. DevGame needs it to talk to the Editor."_                                                   | **No automated remedy exists in this codebase today.** Do not invent or guess an install command — the actual installer's behavior (idempotency, sudo, which rc files it touches) is explicitly unverified in this repo's own planning (`plan-setup-integration.md` §8, item 3). Point the user to Unity's own CLI installation docs / Unity Hub.                                                                                                                                                                                                                                 |
| **S2**                                                | not on PATH, but found at `~/.unity/bin/unity`                                                                              | _"The Unity CLI is installed at `<path>`, but DevGame can't find it on this app's PATH."_                                                                | Not something you can fix from inside a chat session (it's this DevGame process's own environment, not the project). Tell the user: quit and reopen DevGame; if it persists, that's a DevGame bug to report, not something to work around here.                                                                                                                                                                                                                                                                                                                                   |
| **S3** _(pre-write gate, not a standalone diagnosis)_ | before attempting ANY write below, run `unity auth status --json`                                                           | _"You're not signed in to the Unity CLI."_                                                                                                               | `unity auth login` opens a browser OAuth flow — it must be run by the user, in their own terminal. Print the exact command; do not attempt to run it yourself. Whether local/offline operations even require login is unverified (`plan-setup-integration.md` §0) — don't gate on this speculatively; only surface it if a write actually fails on an auth error.                                                                                                                                                                                                                 |
| **S12**                                               | step 0.4's `pipeline list --json` call itself failed or didn't parse                                                        | (none — show the CLI's own message)                                                                                                                      | Show the CLI's stderr/message **verbatim**, plus the exact command you ran. Do not classify anything below this row — nothing downstream is knowable once this call has failed.                                                                                                                                                                                                                                                                                                                                                                                                   |
| **S4′** _(uncertain, not a real state)_               | `Temp/UnityLockfile` present, but you could not get a successful `pipeline list --json` reading                             | _"Checking Unity's status…"_                                                                                                                             | Re-run step 0.4. Don't commit to S4/S6/S7a/S7b/S8 below on the lockfile alone — it's ambient, not authoritative.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **S13**                                               | `com.unity.pipeline` **absent from the lock** but **present in `manifest.json`'s dependencies**                             | _"Pipeline is added to this project — Unity resolves it automatically, either right away if the project is already open, or the next time you open it."_ | No write needed — one was already made (very likely by a previous `unity pipeline install` run). Nothing to do but wait and verify. Don't say "open the project in Unity" as if it's closed — this state fires the same way whether Unity is open or closed.                                                                                                                                                                                                                                                                                                                      |
| **S4**                                                | `com.unity.pipeline` absent from lock, absent from manifest, AND step 0.4 matched a running, live instance for this project | _"Unity is open, but this project doesn't have Unity's Pipeline package — that's why Play doesn't work here. DevGame can add it to this project."_       | **The one write action with a known-safe, tested shape — see "Writing to the project" below.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **S5**                                                | same package absence, but no live matched instance (Unity closed)                                                           | _"This project doesn't have Unity's Pipeline package, and Unity isn't open. Add the package, then open the project in Unity."_                           | Same write as S4 — confirmed to work with no Editor running (`UnityPipelineClient.ts`'s `install` doc comment: with Unity closed it writes only the manifest line; the lock updates later, when Unity next opens the project). After it succeeds, tell the user to open the project.                                                                                                                                                                                                                                                                                              |
| **S6**                                                | Pipeline IS in the lock, but no live matched instance                                                                       | _"Unity isn't open for this project. Open it in the Unity Editor, then try again."_                                                                      | Cannot be done from a chat session — launching the Unity Editor GUI isn't something this skill has a verified, safe mechanism for. Ask the user to open it.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **S7a**                                               | Pipeline installed, matched instance running but not reachable, **and its `safeMode` field is `true`**                      | _"Unity is in Safe Mode because of a compile error in this project. Fix the error in the Editor, then Unity will exit Safe Mode on its own."_            | Cannot be fixed automatically — needs a human to fix a compile error in the Editor. Say so plainly; do not claim this will clear on its own (it won't, unlike S7b).                                                                                                                                                                                                                                                                                                                                                                                                               |
| **S7b**                                               | Pipeline installed, matched instance running but not reachable, `safeMode` is `false` or `null`                             | _"Waiting for Unity to respond…"_                                                                                                                        | Wait a few seconds (real domain reloads take a moment) and re-run step 0.4. If it's still unreachable after two or three checks, **stop guessing** — this can also mean a wedged Pipeline HTTP server that will never recover on its own (a real failure mode this codebase has hit). Say plainly that you don't know which, and suggest the user check the Unity Editor directly.                                                                                                                                                                                                |
| **S8**                                                | reachable instance, `updateAvailable: true`, and a `latestVersion` is present                                               | _"This project's Pipeline package is older than your Unity CLI expects. Update it to `<version>`?"_                                                      | The same install command used for S4/S5 is the best-known equivalent, but whether re-running it performs a clean in-place upgrade is **not verified** in this codebase against a real outdated-Pipeline project. Run it directly, same as S4/S5, but treat the result with extra scrutiny — re-verify (Step 2) rather than assuming it worked.                                                                                                                                                                                                                                    |
| _(S8′, unresolvable)_                                 | `updateAvailable` is `null` (registry lookup failed, or Unity offline)                                                      | —                                                                                                                                                        | Not a state to report on its own. Don't claim "up to date" — you don't know. Fall through to whatever S6/S11 otherwise applies.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **S9**                                                | Pipeline fully resolved and reachable, but `com.ironmind.editor-presence` absent from the lock                              | _"Unity selection chips are off — this project doesn't have DevGame's selection package."_                                                               | **No automated remedy exists.** This package has no published, fetchable UPM URL yet — that's an open, owner-blocked decision (`plan-setup-integration.md` §4, §8 items 4–5), not something missing from this skill. It exists in source at `unity/com.ironmind.editor-presence/` in this repo. Tell the user plainly that DevGame can't install this one for them yet, and that a manual local reference (e.g. a `file:` path in `manifest.json` pointing at that folder) only works on a machine with this exact repo checked out — explain the tradeoff, don't do it for them. |
| **S10**                                               | selection package resolved, but no live publisher registered, and NOT within the just-started grace window                  | _"Unity has DevGame's selection package but isn't paired with this app yet. Pair it from Settings > Connections."_                                       | Pairing happens inside Unity's own Editor Preferences UI plus a DevGame Settings panel — there's no CLI or file-based shortcut for it. Point the user there.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **S10′**                                              | same, but within ~15s of this DevGame server having started                                                                 | _"Checking Unity's connection…"_                                                                                                                         | Wait a few seconds and re-check — a DevGame restart drops a live pairing that will reappear on its own once Unity's next heartbeat arrives. Don't tell the user to re-pair yet.                                                                                                                                                                                                                                                                                                                                                                                                   |
| **S11**                                               | none of the above — everything checked is green                                                                             | (nothing to report)                                                                                                                                      | Nothing to do. This is the target state every remedy above is verified against.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

## Writing to the project

There is exactly **one** write action this skill can perform with a verified,
safe, known shape — adding `com.unity.pipeline` to the project (the S4/S5/S8
remedy). Everything else in the table above is either read-only or requires
the human directly (CLI install, `unity auth login`, opening the Editor,
fixing a compile error, pairing in Settings, the selection package).

For that one write action:

1. **Run it directly — no confirmation step first.** With your own shell
   tool (non-negotiable #4), not `runProjectScript`:
   ```
   unity pipeline install --project-path "<PROJECT_ROOT>" --json --non-interactive
   ```
   Read the real exit code and JSON output; don't assume success from "the
   command didn't error."
2. **Verify.** Re-run Step 0 and re-classify. Confirm the state actually
   moved — to `S13` (declared, not yet resolved — the expected immediate
   result with Unity closed) or further, not just that the command exited 0.
3. **Report what you actually observed, plainly.** Name what changed —
   `Packages/manifest.json` gained one line for `com.unity.pipeline`; say
   that `Packages/packages-lock.json` and possibly other package versions
   under it may change too, once Unity's own resolver catches up, and that
   other files under `Assets/` showing as changed afterward is normal
   Editor activity, not something this action caused. This is a report,
   not a question — the state you observed in step 2 is what you say
   happened, not what you expect to have happened. If step 0's lockfile
   check found Unity open before you ran the command, mention that it will
   pause to reimport for a few seconds.
4. **If the write fails, hand over the exact command from step 1** so the
   user can run it themselves or see the same error directly.

Do not attempt to build a write path for anything else in the table above —
those are genuinely unbuilt (CLI install, login) or genuinely blocked on an
owner decision that hasn't been made yet (the selection package's
distribution mechanism). Inventing one here would be building ahead of a
decision this skill isn't the place to make.

## Sources

- `apps/server/src/unity/UnitySetupClassifier.ts` — the classification logic
  and every message string, verbatim.
- `packages/contracts/src/unitySetup.ts` — field meanings for every fact
  gathered above.
- `apps/server/src/unity/UnityPackageLock.ts` — why the lock, not the
  manifest, is authoritative.
- `apps/server/src/unity/UnityPipelineClient.ts` — exact CLI invocations
  (`pipeline list`, `pipeline install`) and their documented, verified
  behavior.
- `docs/workbench/plan-setup-integration.md` +
  `docs/workbench/plan-setup-integration-critique.md` — the owner-critiqued
  plan this skill's remedies are scoped to match, including which write
  actions are and are not considered safe today.
