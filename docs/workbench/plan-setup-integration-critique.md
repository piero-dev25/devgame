<!-- Produced by a 7-agent research workflow (wf_71dc8f4d-d70): five parallel
investigation lanes over this repo and this machine, one web lane on current
Unity documentation, an Opus synthesis, and a FRESH Opus adversarial critic.
The critique is preserved alongside the plan deliberately: it found the plan
reintroducing the same defect class the plan exists to fix. Read both. -->

# Critique: "Set Up Integration" plan (Unity first)

Verified against `/Users/pieroherrera/Projects/t3code-fork` at HEAD `c7e46ad86` and live `unity` CLI `1.0.0-beta.3`.

---

## Findings

### F1 — "manifest.json is the authoritative 'is the package installed' source" is false in the owner's own project
**Severity: HIGH · Confidence: OBSERVED**

§1 makes `Packages/manifest.json` the authoritative installed-check, and S4/S5/S9 all key off "manifest has no `<key>`". But manifest.json holds only *direct, non-embedded* dependencies. In the owner's real project:

```
$ python3 (compare manifest vs packages-lock in /Users/pieroherrera/Projects/Mafia Game)
manifest deps: 45
lock deps: 59
in lock but NOT manifest: 14
['com.elringus.naninovel', 'com.unity.burst', 'com.unity.collections', ...]
```

`com.elringus.naninovel` is `{'version': 'file:com.elringus.naninovel', 'depth': 0, 'source': 'embedded'}` — a **depth-0, installed, first-class package that does not appear in manifest.json at all** (its files are git-tracked under `Packages/com.elringus.naninovel/`, confirmed via `git ls-files Packages/`). So 14 of 59 resolved packages are invisible to the plan's authoritative probe.

Consequence: a project that gets Pipeline embedded, vendored, or transitively is classified S4/S5 ("package missing") and DevGame offers to install a duplicate. Same hazard for S9 and `com.ironmind.editor-presence`, which a teammate could plausibly vendor under `Packages/`.

**Fix:** read `packages-lock.json`'s `dependencies` map (which carries `source`/`depth`/`version`) as the primary, and additionally stat `Packages/<id>/package.json` for the embedded case. manifest.json alone is the *intent* file, not the *state* file.

---

### F2 — S7's sentence is a confident false statement, and the disambiguating field is sitting unused in the JSON the plan already reads
**Severity: HIGH · Confidence: OBSERVED (signal) / INFERRED (alternate causes)**

S7 maps `hasPipelinePackage:true` + `isReachable:false` → *"Unity is reloading scripts. This clears on its own in a few seconds."*

That exact pair is also produced by at least:
- **Safe Mode.** `pipeline list --json` returns a `safeMode` field per instance (observed live: `"safeMode": null`, alongside `summary.instancesInSafeMode`). The plan never mentions it. Safe Mode does *not* clear on its own — it needs the user to fix compile errors.
- **The deadlock the plan itself cites in §6** — a wedged Pipeline HTTP server presents as `isReachable:false` and never recovers. §6 excludes DevGame from calling `/api/exec`, but nothing stops the user's own `unity mcp` session or Unity's AI Assistant from wedging it.
- Editor busy on a long import; port bound but server failed to start.

This is precisely the defect class §1 is written to kill: mapping an ambiguous signal onto a friendly sentence. It is the plan reintroducing its own bug one row lower in its own table.

**Fix:** consume `safeMode`; treat `isReachable:false` as "not responding" with a bounded retry, and only claim "reloading" after the retry succeeds — never as the first-shot explanation.

---

### F3 — S10's evidence is produced by at least four different states
**Severity: HIGH · Confidence: OBSERVED**

S10 ("selection package present, not paired") is detected by "no publisher registered for this workspace root (`EditorPresenceRegistry`)". But that registry is explicitly ephemeral:

> `apps/server/src/editorPresence/EditorPresenceRegistry.ts:1-4` — *"Pure in-memory fan-out for the Editor Presence Protocol… **Nothing on disk**, nothing per-thread"*

Absence of a publisher therefore means *any* of: not paired · Unity closed · Unity mid-domain-reload · WebSocket dropped · **the DevGame server restarted since Unity connected**. The plan asserts one cause and tells the user to go to Settings > Connections. After a DevGame restart with a correctly-paired Unity open, this fires falsely.

`EditorPresenceRegistry.ts:463` does carry `workspace: hello.workspace`, so the *matching* is implementable — it is the *inference* that is unsound. S10 needs to be gated on S6/S11 first, and needs a "we don't know yet" state for the window after server start.

---

### F4 — The consent model promises a diff it cannot compute
**Severity: HIGH · Confidence: OBSERVED**

§3: *"shows the literal diff it will apply — **the two lines added, the two files touched** (`Packages/manifest.json`, `Packages/packages-lock.json`)"*.

`packages-lock.json` receives the whole transitive closure, not two lines. Per the digest's own observation of `arena-spike`, `com.unity.pipeline@0.4.0-exp.1` pulls `com.unity.test-framework 1.1.33`, `com.unity.nuget.mono-cecil 1.11.6`, `com.unity.nuget.newtonsoft-json 3.0.2`, plus modules. Mafia Game already resolves `com.unity.nuget.newtonsoft-json` at **3.2.2** (observed: it is naninovel's dependency in `packages-lock.json`) — so this is a live version-range interaction, not an append.

More fundamentally: the size and content of that diff **are the output of UPM's resolver**, which the plan proposes to run *after* consent. There is no way to render the true diff before running `unity pipeline install`. The honest options are (a) show the manifest line only and say plainly that the lock file will be re-resolved by Unity and may change other entries, or (b) run the install into a copied scratch project first and diff — expensive and not what the plan describes.

Related, same section: *"`Library/` is gitignored so nothing else appears in git"*. Not true for this project:

```
$ git status --porcelain   # in /Users/pieroherrera/Projects/Mafia Game
 M Assets/NaninovelData/.nani/Transient/Bridging/Server
 M Assets/NaninovelData/.nani/Transient/Metadata.json
```

Tracked files under `Assets/` are already churning from Editor activity. A consent prompt that promises "two files" and then hands the owner a dirty tree loses trust on the first use.

---

### F5 — Increment 4b manufactures S2 in the same session, and the plan's S2 copy blames DevGame for it
**Severity: HIGH · Confidence: OBSERVED**

The PATH repair runs exactly once, at startup:

```
$ /usr/bin/grep -rn "installIntoProcess" apps --include="*.ts"
apps/desktop/src/app/DesktopApp.ts:231:  yield* shellEnvironment.installIntoProcess;
```
(`DesktopApp.ts:226-231` — inside `startup`, before `bootstrap`; the only non-definition, non-test call site.)

So after 4b installs the CLI to `~/.unity/bin` and appends the sourcing line to `~/.zshrc` (observed: `~/.zshrc:44` is `. "/Users/pieroherrera/.unity/env"`), the *running* server process's `process.env.PATH` is unchanged. `isCommandAvailable("unity")` stays false, the binary is now on disk, and the plan's own S2 rule fires:

> *"…DevGame can't find it on this app's PATH. Quit and reopen DevGame; **if it persists, tell us — this is a DevGame bug, not a Unity one.**"*

DevGame's own success path emits its own bug report. 4b must either splice `~/.unity/bin` into `process.env.PATH` on install success, or show a purpose-built "installed — restart DevGame to finish" state distinct from S2.

---

### F6 — The probe needs a new authenticated route and the plan never says which scope
**Severity: HIGH · Confidence: OBSERVED**

Increment 1 creates `UnitySetupProbe`; increment 2 wires the toolbar to it; increment 3 wires a settings panel. All three are browser→server calls, and §2 claims the four-tag contract "holds" because no tag is removed. But S8/S9/S10 are states `POST /unity/command` can never produce — they require a **new** route and a **new** contract, and the plan is silent on both.

The existing Unity route's scope choice is documented and deliberate:

> `apps/server/src/unity/UnityCommandRoute.ts:14-22` — gated by `AuthPresenceCommandScope`, chosen because this is *"the identical class of risk… 'make the user's editor execute code or change what it's doing'"*.

A read-only probe under that scope is over-privileged. A probe under *no* scope is an unauthenticated endpoint that reads `Packages/manifest.json` and stats `Temp/UnityLockfile` **at a caller-supplied project path** — a path-traversal / filesystem-oracle surface. Neither is addressed. This is a security-touching design decision the plan currently leaves to the implementer.

---

### F7 — The wrong-version check applies *our* package's floor to *Unity's* package
**Severity: MEDIUM · Confidence: OBSERVED**

§7: *"read `ProjectSettings/ProjectVersion.txt` … against the package floor (`package.json` `"unity": "6000.3"`; Pipeline is 6.0 LTS+ per Unity's docs)"*, with the sentence *"the Pipeline package needs 6000.3 or newer."*

`"unity": "6000.3"` is `com.ironmind.editor-presence`'s own floor (confirmed: `unity/com.ironmind.editor-presence/package.json`, `"unity": "6000.3"`). The plan's own parenthetical says Pipeline is 6.0 LTS+. So the rule would **refuse to offer Pipeline install** on a 6000.0 LTS project where Pipeline is supported, and would state a false reason while doing it. Two packages, two floors; read Pipeline's floor from `unity pipeline list-versions` / the package's own manifest, not ours.

(Mafia Game itself is `6000.3.14f1` — observed in `ProjectSettings/ProjectVersion.txt` — so this wouldn't bite here, which is exactly why it would ship unnoticed.)

---

### F8 — §6's load-bearing citation points at a file that does not exist in this repo
**Severity: MEDIUM · Confidence: OBSERVED**

§6 and §8-6 cite `spikes/unity-testbed/REPORT.md:1-20` and `:12` as repo paths.

```
$ /bin/ls /Users/pieroherrera/Projects/t3code-fork/spikes
ls: .../spikes: No such file or directory
$ /bin/ls -la /Users/pieroherrera/Projects/gamedev-workbench/.claude/worktrees/substrate-research/spikes/unity-testbed/
-rw-r--r--  ... REPORT.md
```

The file lives in a *different repository's worktree*. §6's exclusion of Pipeline's exec surface — the plan's single strongest scope ruling — is unverifiable by anyone reading it in `t3code-fork`. Either copy the report into the repo or cite the absolute cross-repo path.

Same class, lower stakes: §0 says *"HEAD `05b28ce7b` postdates both"*; actual HEAD is `c7e46ad86`. The underlying ancestry claim **does** hold (`git merge-base --is-ancestor 6799b7b4b HEAD` → yes), so the conclusion survives; the citation is stale.

---

### F9 — The distribution defence contradicts itself on the copy step, and ignores git-on-PATH
**Severity: MEDIUM · Confidence: OBSERVED (contradiction) / INFERRED (PATH hazard)**

§4 argues the `.meta`/GUID hazard is *"handled structurally, not by discipline… UPM git resolution clones, so `.meta` files travel; **there is no copy step to get wrong**."*

But §4's own gate proposes *"a split, package-only repo mirrored on tag."* The mirror **is** the copy step — a subtree split or export from `unity/com.ironmind.editor-presence/` into a new repo root, run on every tag, and it is the one step that can drop `.meta` files. The structural guarantee applies to *consumers*, not to *publication*. The gate in §8-4 should therefore also cover "who runs the mirror, and what proves `.meta` survived it".

Second, unmentioned anywhere in plan or digest: UPM git-URL resolution requires **git on the Unity Editor's own PATH**. The Editor is launched from Hub/Finder — precisely the environment the plan's own §7 row establishes is unreliable on this machine (*"`launchctl getenv PATH` is empty on this machine"*). The plan spends a full row on that hazard for DevGame and does not apply it to the mechanism it is choosing for distribution. A `file:`/tarball route does not need git; the recommended route does.

Third, `package.json`'s shipped `documentationUrl` already points at `https://github.com/piero-dev25/devgame/…` — a different name from the proposed `devgame-unity-presence` and of unestablished public status. §8-4 flags the hosting question but the artifact already carries a URL that will 404 for external users if that repo is private.

---

### F10 — S8 is undetectable in exactly the case it matters, and `updateAvailable:false` is not trustworthy
**Severity: MEDIUM · Confidence: OBSERVED**

§1 correctly states `pipeline list` *"only sees Editors that are currently running."* S8's detection row then says simply "`updateAvailable:true`" with no caveat. So:

- Unity closed → no instance → `updateAvailable` unobservable → S8 silently unreachable, and the user is never told their pin is stale.
- Live output right now shows `"latestVersion": null` alongside `"updateAvailable": false` and `"instancesWithUpdateAvailable": 0`. With `latestVersion` null, `updateAvailable:false` cannot be distinguished from "the registry lookup failed / offline". Treating it as "you're up to date" is an unfounded negative.

---

### F11 — S1/S2 hardcode a path observed on exactly one machine, from an installer that was never run
**Severity: MEDIUM · Confidence: OBSERVED**

The S1/S2 split turns on `~/.unity/bin/unity` being *the* install location. The digest's grounding for that is `~/.unity/env`'s comment on this machine plus mtime correlation — and digest lane 1 explicitly lists as unknown: *"Exact behavior of the documented install.sh when run non-interactively… not executed, only its URL/content strings were observed inside Hub's app.asar."*

So the plan converts one machine's observed artifact into a cross-platform canonical probe. Consequences: a Windows/Linux user, or anyone whose installer honoured a different prefix, gets S1 ("not installed") and is offered a **second** install of a CLI they already have. The plan treats an artifact as provenance.

Cheap mitigation available today: `unity doctor` / `resolveCommandPath` already exist; probe a small candidate set and, when the binary is found off-PATH, report the path you found rather than asserting a hardcoded one.

---

### F12 — The proposed install command omits the two flags that make it safe to spawn
**Severity: MEDIUM · Confidence: OBSERVED**

§3 and §7 use `unity pipeline install --project-path "<path>"`. The CLI's own help lists these as global options:

```
$ unity pipeline install --help
  --json                 Shorthand for --format json
  --non-interactive      Disable interactive prompts. Useful in CI/CD environments.
  --proxy <url>          HTTP/HTTPS/SOCKS/PAC proxy URL
```

Spawned from `ProcessRunner` with no TTY and no `--non-interactive`, an install that decides to prompt (version choice, pre-release confirmation, auth re-prompt) blocks until `ProcessRunner`'s timeout and surfaces as an opaque failure — which §7 then instructs you *not* to classify. Without `--json` the plan cannot parse the result structurally, which is the whole thesis of §1. Both flags belong in the command, and the copy-paste equivalent shown to the user should match what DevGame actually runs.

---

### F13 — Lockfile presence is treated as "Unity is open" with no stale-lock handling, and S4's detector is an unresolved OR
**Severity: MEDIUM · Confidence: OBSERVED (mechanism) / INFERRED (stale case)**

`probeUnityLockfilePresent` is a bare existence check (`UnityColdStart.ts:131-139`: `fileSystem.exists(lockfilePath)`), and the module's premise is asserted, not measured: *"`Temp/UnityLockfile` … exists **exactly while** an Editor instance already has that project open"* (`UnityColdStart.ts:5-7`). A force-quit or crashed Editor is the standard way that premise breaks.

The plan then uses lockfile presence for three decisions: S4/S5/S6 classification, and the §3 consent warning *"Unity is open. It will reimport this project and be unresponsive for a few seconds."* S4's detector is written as `"lockfile present / isRunning:true"` — an unresolved slash. When they disagree (stale lockfile present, `isRunning` absent), the plan does not say which wins, and the two branches give opposite sentences. `pipeline list`'s `pid` + `isRunning` is the stronger signal and should be authoritative for liveness whenever it has been run.

---

### F14 — Path-matching is the join key and the plan doesn't say to reuse the existing normalizer
**Severity: LOW · Confidence: OBSERVED**

`pipeline list` has no `--project-path` (confirmed: `unity pipeline list --help`), so matching an instance to "this project" is a raw string compare on `projectPath`. The repo already learned this lesson and has a shared normalizer with a comment naming the exact bug class:

> `apps/web/src/editorPresence/resolveProjectEditor.ts` — *"a second, subtly-different normalizer would let the Play/Stop toolbar and the chip attachment disagree about whether an editor belongs to a project — precisely the class of bug #71 already was."*

The plan introduces a third comparison site (server-side, against `pipeline list`) without naming it. The owner's project path contains a space and could sit behind a symlink; trailing-slash and case normalization are already solved here and should be reused, not re-derived.

---

### F15 — Minor citation drift
**Severity: LOW · Confidence: OBSERVED**

`isCommandAvailable` is at `packages/shared/src/shell.ts:601`, not `:513-568` as §1's table says (`:513` is `resolveCommandPathForPlatform`). Points at the right mechanism, wrong line. The digest had it right (`:601-609`); the plan degraded it.

---

## What the plan gets right

These are safe to build as written.

- **Dropping MCP from scope (§0, §6) is correct and well-grounded.** Verified: `apps/server/src/server.ts:512` mounts `McpHttpServer.layer` unconditionally in the main layer composition, with no flag. Building setup UI for it would be inventing work. Likewise, refusing to write into *other* clients' MCP configs from DevGame is the right call.
- **Detection-first, and saying so explicitly.** §1 and §5 both state that increments 0–3 ship alone, write nothing, and depend on none of the §8 unknowns. That is the correct sequencing and the plan is unambiguous about it. Your question 7 — "could the honest-message half ship sooner, and does the plan say so" — is answered yes on both counts.
- **The `pipeline list` gap is real.** Confirmed: `/usr/bin/grep -rn "hasPipelinePackage\|pipeline list" apps packages` returns nothing. The CLI hands over exactly the taxonomy the UI needs and the codebase discards it.
- **`NOT_READY_MESSAGE_PATTERNS` is genuinely stale — I reproduced it.** Live against the owner's project:
  ```
  "message": "No Unity Editor instances found with reachable Pipeline servers.\n\nMake sure:\n• Unity Editor is running with a project open\n• The Pipeline package is installed in the project…"
  ```
  None of the three patterns at `UnityPipelineClient.ts:126-134` is a substring. So today this falls to the `error` tag and dumps the raw multi-line blob through `ChatView.tsx:1630-1636`. The plan's diagnosis of the drift is correct and it does not overclaim.
- **Verbatim passthrough for unrecognized CLI messages (S12) is the right default** and is the correct inversion of the current design.
- **The README correction (increment 0) is warranted.** `unity/README.md:11-13` still says the package "was deleted on 2026-08-03" and `:41-42` says "Unity selection is currently unimplemented", while `6799b7b4b` ("thin selection-only editor-presence publisher") is an ancestor of HEAD and the package is on disk at v0.2.0. One research lane already misread it.
- **Rejecting `file:` paths and in-bundle tarballs** for the reasons given. Both defences hold.
- **Consent per-write, per-project, with no global "always install"**, and "remember" scoped to the identical write. This is stricter than Bezi's precedent and correctly identified as such.
- **The §8 blocker list is honest and correctly placed.** Auth-for-local-ops, install-without-a-running-Editor, `install.sh` behaviour, and the packaged-DMG PATH question are all genuinely open in the digest and the plan does not pretend otherwise. §0 explicitly marks CLI login UNKNOWN and refuses to gate on it — that is the discipline that should have been applied to F2 and F11 too.
- **Excluding uninstall/rollback, the multi-engine wizard, auto-install-on-failure, and Pipeline's exec surface.** No scope creep found; the plan is if anything under-scoped, which is right.
- **The E2E gate on increment 2** (real Editor, real project, screenshot naming the commit) matches the standing doctrine and is the correct bar.

---

## What I could not check, and why

| Question | Why unresolved | What would settle it |
|---|---|---|
| Does `pipeline list --json` return an error or an empty `instances` array when **zero** Editors run? S5/S6 classification depends on the shape. | Unity is currently open on Mafia Game (`pid 39658`); closing it is out of bounds. | Run `unity pipeline list --json` with no Editor running, on any machine. |
| Does `unity pipeline install` work with no Editor running (§8-1)? | Requires an actual install; read-only pass. | Copy a scratch project, close Unity, run it, diff `manifest.json` + `packages-lock.json` and count the lock delta — this also settles F4. |
| Is the owner's *originally reported* symptom ("Unity isn't open for this project") reproducible on CLI `1.0.0-beta.3`, or did it come from a different action (`editor_play` vs `editor_status`) or an older CLI? | I declined to run `unity command editor_play` against the owner's live Editor. The digest lists this as an open unknown; the plan's §0 treats the S4 diagnosis as settled. | Run `editor_play`/`editor_stop --json` against a *scratch* Pipeline-less project and compare messages. Until then, increment 2's E2E gate cannot prove it fixed the reported bug — only that it produces a true sentence. |
| Whether a stale `Temp/UnityLockfile` survives a crashed Editor (F13). | Would require force-quitting the owner's Editor. | `kill -9` a scratch-project Editor, then stat the lockfile. |
| Whether git-URL UPM resolution succeeds from a Hub/Finder-launched Editor on this machine (F9). | Requires launching Unity and adding a git-URL package. | Add any public git-URL package to a scratch project from a Finder-launched Editor. |
| Whether `updateAvailable` is meaningful when `latestVersion` is null / offline (F10). | Pipeline isn't installed anywhere I could observe with network variation. | `unity pipeline list --json` on `arena-spike` (which has 0.4.0-exp.1) with and without network. |
| Whether `com.ironmind.editor-presence` v0.2.0 has ever been compiled in an Editor. | `unity/com.ironmind.editor-presence/UNVERIFIED.md:17-20` says its status is "dated to when this file was last edited"; I did not verify the "Verified this pass" section against an actual Editor session, and cannot launch Unity. | Import the package into a scratch 6000.3 project and check the console. S9's promise ("chips turn on") rests on this. |

**Provenance note:** every file:line and command output above is OBSERVED in this session. The causal claims — F2's alternate causes, F5's session-order consequence, F9's git-PATH hazard, F13's stale-lock case — are INFERRED from those observations and labelled as such in each finding.