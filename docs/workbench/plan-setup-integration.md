<!-- Produced by a 7-agent research workflow (wf_71dc8f4d-d70): five parallel
investigation lanes over this repo and this machine, one web lane on current
Unity documentation, an Opus synthesis, and a FRESH Opus adversarial critic.
The critique (plan-setup-integration-critique.md) found the plan
reintroducing the same defect class it exists to fix (F2), plus 14 more
findings. This is REVISION 2: every finding is resolved below — see
"Critique resolution log" at the end for a one-line pointer to each. Read
the critique alongside this file; it stays as the record of what was wrong
and why. -->

# Set Up Integration — implementation plan (Unity first), revision 2

## 0. What is actually required vs. what we assumed

| Piece | Needs setup? | Evidence |
|---|---|---|
| **MCP connection** | **No. Drop it.** DevGame's MCP server is mounted unconditionally at server boot and spliced into every provider turn with a server-issued bearer token. Zero user action. | `apps/server/src/server.ts:512`; `McpHttpServer.ts:219-225`; `ProviderService.ts:221`; `ClaudeAdapter.ts:3634-3641` |
| `unity mcp configure` | **No. Out of scope.** It writes Unity's MCP server into *other* clients' configs (`claude mcp add --scope user`, `~/.cursor/mcp.json`) for a capability DevGame does not consume. | digest lane 4, `unity mcp configure --list` / `--dry-run` |
| **Unity CLI on PATH** | Yes | `UnityPipelineClient.ts:59` spawns bare `unity`; `isAvailable()` at `:213-217` |
| **Unity CLI login** | **UNKNOWN — do not gate on it yet.** Verified only that `unity auth status --json` reports state. Whether local 127.0.0.1 ops need it is untested. | digest lane 5, "CLI-authentication state" finding |
| **`com.unity.pipeline` in the target project** | Yes — this is the owner's bug | `Mafia Game/Packages/manifest.json` has no such key; `pipeline list --json` → `hasPipelinePackage:false` |
| **`com.ironmind.editor-presence` in the target project** | Yes — this is why selection never appeared | package exists on disk at v0.2.0 (`unity/com.ironmind.editor-presence/package.json`), rebuilt in `6799b7b4b`, absent from the project's manifest |
| **Presence pairing (server URL + token)** | Yes, per machine — currently hand-typed into Unity Preferences | `EditorPresenceSettingsProvider.cs:39-70` ("Server URL" TextField + "Not paired") |
| **Unity Editor being open** | Not setup — a runtime state. Detect and report only. | `probeUnityLockfilePresent`, `UnityColdStart.ts:59-61` |

**Doc correction, do this first:** `unity/README.md:11-46` still says our package was deleted and "Unity selection is currently unimplemented." It was rebuilt (`git log unity/com.ironmind.editor-presence` → `6799b7b4b` after `33d6cc4d8`; ancestry confirmed via `git merge-base --is-ancestor 6799b7b4b HEAD`). One research lane already drew the wrong conclusion from that README. Fix the file before anyone else reads it. *(F8: citation corrected to the ancestry check itself, not a specific HEAD sha, which goes stale the moment another lane commits — as it already has twice this session.)*

## 1. Detection and installation are separate features. Ship detection alone.

**Yes — detection is worth shipping by itself, and should ship first.** It writes nothing to anyone's project, and it alone fixes the defect that started this. Its taxonomy and classification logic (§2) need none of the open UNKNOWNs resolved to be built and proven correct — one item (§8-6) must be settled before the probe route is exposed to real, untrusted callers in production, which is a narrower bar than "before it can be built." Installation depends on five separate, genuinely blocking questions (§8, items 1–5).

Confirmed dead giveaway that detection is the real gap: `pipeline list --json` already returns the exact taxonomy the UI needs (`isRunning` / `hasPipelinePackage` / `pipelineServer.isReachable` / `pipelineVersion` / `updateAvailable` / `safeMode`) — and it is **called nowhere in the codebase**. Verified: `/usr/bin/grep -rn "hasPipelinePackage|pipeline list|pipeline install" apps packages --include="*.ts" --include="*.tsx"` → no hits.

### Detection inputs, cheapest first

| Tier | Probe | Cost | Cadence |
|---|---|---|---|
| Free | `isCommandAvailable("unity")` — PATH stat, no spawn (`packages/shared/src/shell.ts:601-609`) | sub-ms | ambient / every render |
| Free | `Temp/UnityLockfile` exists (`UnityColdStart.ts:59-61`) | sub-ms | ambient; provisional only — see §2's S4/S4′ liveness note |
| Free | read `Packages/packages-lock.json`'s `dependencies` map for the two package ids, plus stat `Packages/<id>/package.json` for the embedded case | sub-ms | ambient, 1-min TTL (`EngineTypeResolver.ts:49`'s pattern) |
| ~400ms | `unity pipeline list --json` | measured 0.400s | on demand only: panel open, Play click, explicit refresh |
| ~285ms | `unity command editor_status --json` | measured 0.285s | already reactive; unchanged |

*(F15: `isCommandAvailable`'s citation corrected — it's at `shell.ts:601-609`; `:513` is `resolveCommandPathForPlatform`, a different function.)*

**F1 — authoritative "is it installed" source is `packages-lock.json`, not `manifest.json`.** `manifest.json` holds only direct, non-embedded dependencies. In the owner's real `Mafia Game` project, 14 of 59 packages resolved in `packages-lock.json` are absent from `manifest.json` — including `com.elringus.naninovel`, a depth-0 **embedded** package (`{"version": "file:com.elringus.naninovel", "depth": 0, "source": "embedded"}`, files git-tracked under `Packages/com.elringus.naninovel/`). A project that gets Pipeline or `com.ironmind.editor-presence` embedded or vendored would be misclassified S4/S5/S9 ("missing") and offered a duplicate install.

**Fix, now the authoritative rule:** read `packages-lock.json`'s `dependencies` map (carries `source`/`depth`/`version`) as primary. For the embedded case specifically (`source: "embedded"`), the lock entry's own presence is already sufficient — no separate directory stat is needed beyond confirming the lock entry exists, since UPM only writes an embedded lock entry once the directory is actually resolved. `manifest.json` is read too, but only as *declared intent* (used for §3's diff-preview honesty, never as the installed-check).

**Path-matching (F14):** `pipeline list` has no `--project-path` filter (confirmed: `unity pipeline list --help`), so identifying "this project" among running instances is a raw string compare on `projectPath`. Reuse `apps/web/src/editorPresence/resolveProjectEditor.ts`'s existing normalizer — its own comment already names this exact bug class ("a second, subtly-different normalizer would let the Play/Stop toolbar and the chip attachment disagree… precisely the class of bug #71 already was"). Do not write a third comparison site.

### The classification rule that fixes the drift

Delete substring matching as the *classifier*. `NOT_READY_MESSAGE_PATTERNS` (`UnityPipelineClient.ts:126-134`) is already stale against CLI 1.0.0-beta.3: today's live message is `"No Unity Editor instances found with reachable Pipeline servers."`, which matches none of the three hardcoded strings — so the owner's scenario currently falls through to the generic error toast (`ChatView.tsx:1630-1636`). Replace with:

1. Classify from `pipeline list`'s structured booleans + `packages-lock.json`.
2. Keep the substring list only as a degraded fallback when `pipeline list` itself fails.
3. **When nothing matches, show the CLI's own message verbatim.** Never map an unrecognized CLI string onto a friendly sentence. The current bug is exactly that mapping.

### New route and auth scope (F6) — decided here, not left to the implementer

Increment 1 introduces `UnitySetupProbe`, and increments 2–3 need it reachable from the toolbar (desktop) and the web settings panel (`ConnectionsSettings.tsx`). Neither existing Unity route fits:

- `POST /unity/command` is gated by `AuthPresenceCommandScope` ("presence:command") — deliberately excluded from `AuthStandardClientScopes` (`packages/contracts/src/auth.ts:91-102`; only granted via `AuthDesktopOwnerScopes` at the desktop app's own bootstrap-seed mint site). **The web app's own session does not hold this scope.** Reusing it for the probe would make the settings panel in increment 3 unable to call its own probe — a real, previously-unnoticed break, not just "over-privileged" as the critique's milder framing put it.
- No scope at all is the filesystem-oracle the critique names: an endpoint reading `Packages/manifest.json`/`packages-lock.json` and stating `Temp/UnityLockfile` needs authentication regardless of write/read distinction.

**Decision: add `AuthPresenceReadScope = "presence:read"`** (`packages/contracts/src/auth.ts`, sibling to `AuthPresenceCommandScope`, same `<domain>:<verb>` convention already used for `access:read`/`access:write` and `relay:read`/`relay:write`). Add it to `AuthEnvironmentScope`'s literal union **and to `AuthStandardClientScopes`** — read-only project/CLI-state inspection is materially lower risk than commanding the Editor (no code executes, nothing changes), matching the existing precedent that a domain's `:read` scope is granted more broadly than its write/operate counterpart when the two diverge (`relay:read` is in `AuthStandardClientScopes`; `relay:write` is administrative-only, confirmed at `auth.ts:153-165`). This makes the probe callable from the browser app and every standard client by default, same as any other read capability, without touching `presence:command`'s deliberately narrow, desktop-owner-only grant.

**Path handling — the second half of F6, not fully closable tonight, principle fixed either way:** `POST /unity/command`'s existing `dispatchUnityCommand` takes `workspaceRoot` as a caller-supplied string straight from the request body (`UnityCommandInput`, no server-side validation against a known project set — confirmed by reading `UnityCommandRoute.ts:107-138`). That is only acceptable there because `presence:command` is desktop-owner-only, so a caller who holds it is already running locally with full filesystem access regardless of what path it names. The new probe does **not** get that cover — it is meant to be broadly reachable — so it must not mirror that pattern uncritically. Non-negotiable principle: the probe never trusts a bare caller-supplied path as-is; it validates it against whatever set of project roots the caller's session is already legitimately bound to before touching the filesystem. The exact registry to validate against is an implementation detail worth confirming at build time, not a research gap — added to §8 as item 7 below rather than left silent.

## 2. Every distinguishable state and its exact sentence

The four-tag contract (`ok`/`notReady`/`cliUnavailable`/`error`) is an owner ruling (`UnityCommandRoute.ts:24-32`, `packages/contracts/src/unity.ts:54-76`) — keep the tags, split `notReady` into a `reason` field. No tag is removed, so the contract holds.

| State | Detected by | Sentence shown |
|---|---|---|
| **S1 CLI not installed** | `isCommandAvailable` false, and no candidate binary found by a short probe list (see F11 fix below) | "Unity's command-line tool isn't installed on this machine. DevGame needs it to talk to the Editor." + **Install** |
| **S2 CLI installed but invisible to this app** | `isCommandAvailable` false, and a candidate binary WAS found off-PATH | "The Unity CLI is installed at `<discovered path>`, but DevGame can't find it on this app's PATH. Quit and reopen DevGame; if it persists, tell us — this is a DevGame bug, not a Unity one." |
| **S2′ CLI just installed this session, PATH not yet live** *(new — F5)* | Increment 4b's own install just succeeded in this process | "The Unity CLI is installed. Finishing setup…" — auto-resolves without restart; see §5 increment 4b for the mechanism. Never shown alongside S2's "this is a DevGame bug" copy. |
| **S3 Not signed in** (install actions only) | `unity auth status --json` → `loggedIn:false` | "You're not signed in to the Unity CLI. Run `unity auth login`, then try again." |
| **S4 Pipeline package missing, Unity confirmed open for this project** ← **the defect** | `packages-lock.json` has no `com.unity.pipeline` entry (embedded or otherwise); `pipeline list`'s own `isRunning:true` for the path-matched instance (see the liveness rule below — F13) | "Unity is open, but this project doesn't have Unity's Pipeline package — that's why Play doesn't work here. DevGame can add it to this project." + **Add package** |
| **S4′ Pipeline package missing, liveness not yet confirmed** *(new — F13)* | lockfile present but `pipeline list` hasn't been run yet this check cycle | Transient "Checking Unity's status…" — never commits to S4 or S6's sentence until `pipeline list` has actually run once for this check |
| **S5 Pipeline package missing, Unity closed** | lock has no entry; lockfile absent | "This project doesn't have Unity's Pipeline package, and Unity isn't open. Add the package, then open the project in Unity." |
| **S6 Pipeline installed, Unity not open** | lock entry present; lockfile absent, or `pipeline list` ran and found no matching live instance | "Unity isn't open for this project. Open it in the Unity Editor, then try again." — *today's sentence, but now only shown when it is true* |
| **S7a Pipeline installed, Unity open, Safe Mode** *(split from the old S7 — F2)* | `hasPipelinePackage:true`, `isReachable:false`, `pipeline list`'s `safeMode` field true for the matched instance | "Unity is in Safe Mode because of a compile error in this project. Fix the error in the Editor, then Unity will exit Safe Mode on its own." — does **not** promise auto-clearing on its own timeline |
| **S7b Pipeline installed, Unity open, not yet responding** *(the old S7, corrected — F2)* | `hasPipelinePackage:true`, `isReachable:false`, `safeMode` false or null | "Waiting for Unity to respond…" with a bounded retry (a few seconds, a handful of attempts). If it resolves: no message, controls enable. If it does **not** resolve within the retry budget: "Unity isn't responding to Play/Stop requests. This can happen during a script reload, or if the Pipeline server has stopped working — try clicking back into Unity, or restart it if this persists." Never asserted as a first-shot explanation; "reloading" is a description of what happened after recovery, not a promise made before it. |
| **S8 Pipeline out of date** | `updateAvailable:true` **and** `latestVersion` non-null, for a currently-running matched instance | "This project's Pipeline package is older than your Unity CLI expects. Update it to `<version>`?" + **Update** |
| **S8′ Update status unknown** *(new — F10)* | Unity closed (no running instance to ask), or `latestVersion` is null (registry lookup failed / offline) | Not shown at all — falls through to whichever of S6/S11 otherwise applies. Never inferred as "up to date" from a null signal. |
| **S9 Selection package missing** | lock has no `com.ironmind.editor-presence` entry (embedded-aware, same rule as S4/S5) | "Unity selection chips are off — this project doesn't have DevGame's selection package." + **Add package** |
| **S10 Selection package present, not paired** *(re-gated — F3)* | package present in lock **and** `pipeline list`/lockfile independently confirm a live Unity instance for this project (i.e., S6/S11's own liveness signal is already green) **and** no publisher registered in `EditorPresenceRegistry` for this workspace **and** the grace window below has elapsed | "Unity has DevGame's selection package but isn't paired with this app yet. Pair it from Settings > Connections." |
| **S10′ Checking pairing…** *(new — F3)* | same as S10's first three conditions, but within the grace window (see below) | "Checking Unity's connection…" — no action offered yet |
| **S11 Everything ready** | all above green | No message. Controls enabled. |
| **S12 Anything else** | CLI non-zero exit, unmatched message | *The CLI's own message, verbatim, unedited*, plus the command that produced it. |

**S10's grace window, spelled out (F3):** `EditorPresenceRegistry` is explicitly documented as ephemeral — `apps/server/src/editorPresence/EditorPresenceRegistry.ts:1-4`, *"Pure in-memory fan-out… Nothing on disk, nothing per-thread."* Absence of a publisher there means any of: not paired · Unity closed · mid-domain-reload · WebSocket dropped · **the DevGame server restarted since Unity last connected**. `EditorPresenceRegistry.ts:463` already carries `workspace: hello.workspace`, so the matching itself is sound — only the single-cause inference was wrong. Fix: track the server process's own start time; if a live Unity instance is confirmed for this project (S6/S11's liveness signal) and no publisher is registered, and less than a fixed grace period (proposal: 15s, tunable) has passed since server start, show S10′ instead of committing to S10. After the window, if still unpaired, S10 is genuinely the right call — Unity, once actually connected, re-handshakes well inside that window in the normal case.

**S4's liveness rule, spelled out (F13):** `probeUnityLockfilePresent` is a bare existence check (`UnityColdStart.ts:131-139`) whose own module doc asserts, not measures, that the lockfile exists "exactly while" an Editor has the project open (`UnityColdStart.ts:5-7`) — a crashed or force-quit Editor is the standard way that breaks. `pipeline list`'s `pid`/`isRunning` for the path-matched instance is the stronger signal and is **authoritative for liveness whenever it has actually been run this cycle.** The lockfile is used only as the cheap *ambient* pre-check that decides whether paying the ~400ms `pipeline list` cost is worth it at all — never as the final word once the authoritative check has run. This removes the old table's unresolved "lockfile present / isRunning:true" slash: S4′ covers the window where only the cheap signal has fired yet.

**S8's own version floor (F7 fix applies at read time, not classification):** see §7's failure-mode table for the wrong-package-floor fix — it affects the *install-refusal* path, not S8's detection above, which only reads `pipeline list`'s own `updateAvailable`/`latestVersion` fields.

## 3. Consent model

Non-negotiables: nothing is written without a click; a refusal always leaves a working manual path.

- **Per machine, asked once:** installing the Unity CLI (writes `~/.unity/`, appends to `~/.zshrc` — observed: `~/.unity/env` + `~/.zshrc:44`), and `unity auth login`.
- **Per project, asked per write:** every edit to `Packages/manifest.json`.
- **What the prompt shows (F4 — corrected):** the manifest line being added, named plainly. **It does not promise a computed diff of `packages-lock.json`.** The critique proved this can't be honest: `com.unity.pipeline@0.4.0-exp.1` pulls a real transitive closure (`com.unity.test-framework`, `com.unity.nuget.mono-cecil`, `com.unity.nuget.newtonsoft-json`, plus modules), and the owner's own project already resolves `com.unity.nuget.newtonsoft-json` at a *different* version (3.2.2, via naninovel) than Pipeline's own dependency line (3.0.2) — a live version-range interaction, not an append. The lockfile's true shape is the output of UPM's own resolver, which only runs *after* consent — there is no way to render it beforehand short of an install-into-a-scratch-copy dry run, which is out of scope for this increment. The prompt says so plainly: *"This will also update `Packages/packages-lock.json` — Unity's own dependency resolver decides its exact contents, which may include other package versions changing to satisfy Pipeline's requirements."*
- **The "nothing else appears in git" claim is dropped (F4).** It was checked against the owner's real project and is false: `Assets/NaninovelData/.nani/Transient/...` shows modified in `git status --porcelain` from ordinary Editor activity, unrelated to any install. Replaced with: *"Other files under `Assets/` may also show as changed — that's normal Unity Editor activity, not something this action caused."*
- **What "remember" means:** "Don't ask again for this project" suppresses re-asking *for the identical write only*. A version bump, a second package, or a different project re-asks. There is no global "always install into any project."
- **Editor-open warning is part of the prompt, not a separate toast:** "Unity is open. It will reimport this project and be unresponsive for a few seconds." Shown when the lockfile is present (subject to §2's liveness rule for whether it's actually true).
- **Refusal degrades to copy-paste, never to a dead end:** every action shows its exact equivalent command, **including the `--json --non-interactive` flags DevGame itself sends (F12)** — `unity pipeline install --project-path "<path>" --json --non-interactive` — with a copy button. The shown command must match what actually runs; showing a friendlier-looking but different command would violate the same "say the true thing" principle §1 exists for.
- **Bezi's precedent is the ceiling, not the floor:** Bezi requires a return-to-Editor consent click before install (docs.bezi.com/get-started/quickstart). We are asking *inside DevGame instead*, which is weaker — so the prompt must be explicit about files, not a generic "Install?".
- **Unsigned-package disclosure:** Unity 6.3 shows trust indicators for unsigned packages (`WhatsNewUnity63.html`). A git-URL package is unsigned. Say so in the S9 consent copy so the Editor's warning isn't a surprise.

## 4. Distribution of `com.ironmind.editor-presence`: **public git URL, tag-pinned**

```
"com.ironmind.editor-presence":
  "https://github.com/<org>/devgame-unity-presence.git#v0.2.0"
```

**Why, against each alternative:**

- **vs. `file:` absolute path** — breaks for every teammate who clones without an identically-pathed Ironmind install (digest lane 3 risk). Disqualifying.
- **vs. tarball shipped inside the .app** — same breakage plus two more: the manifest points into a bundle path that changes per machine and disappears on uninstall, and **no tarball-generation script exists in this repo** (digest lane 3 unknown), so `.meta` preservation would be an unverified promise.
- **vs. a scoped registry** — real infrastructure to run for one package. Revisit if there is ever a second.

**The `.meta`/GUID hazard for *consumers* is handled structurally, not by discipline.** All 20 files (10 content + 10 `.meta`) are git-tracked with real assigned GUIDs — verified: `git ls-files unity/com.ironmind.editor-presence`, `EditorPresenceConnection.cs.meta` guid `f7b87965513b64c1481bfa2e55d76d50`. UPM git resolution clones, so `.meta` files travel; a consumer's install has no copy step to get wrong.

**But publication is a copy step, and the plan previously elided it (F9).** §8's gate for this section already names *"a split, package-only repo mirrored on tag"* — that mirror **is** a copy step, run on every tag, and it is the one place `.meta` files can actually be dropped (a subtree split or export that doesn't carry dotfiles correctly, for instance). The structural guarantee above applies to consumers, not to whoever runs the mirror. §8-4's gate is expanded below to cover this explicitly: who runs the mirror, on what trigger, and what proves the `.meta` files survived it (a CI check comparing GUID sets pre/post-mirror is the obvious shape, not specified further here since it's implementation, not the open decision).

**Git-on-PATH is a real, previously unmentioned risk for this mechanism specifically (F9).** UPM git-URL resolution requires git on the *Unity Editor's own* PATH. The Editor is launched from Hub/Finder — the exact environment §7's own row already establishes is unreliable on this machine (`launchctl getenv PATH` observed empty). The plan spent a full row on that hazard for the `unity` CLI and did not apply it to the mechanism chosen for package distribution, which shares the same exposure. DevGame cannot fix Unity's own PATH from outside the Editor process, so this is a documented limitation, not something increment 4c can close: if S9's consent completes (the manifest write succeeds) but a later probe still shows the package absent from `packages-lock.json`, surface a distinct troubleshooting hint — *"the package was added to this project, but Unity hasn't resolved it yet — this can happen if `git` isn't on the Unity Editor's own PATH"* — rather than silently repeating S9's original message as if nothing happened.

**`documentationUrl` already points at a URL that will 404 for this plan's intended audience (F9).** The shipped `package.json`'s `documentationUrl` points at `https://github.com/piero-dev25/devgame/…` — a different repository than the `devgame-unity-presence` mirror this section proposes, and of unestablished public status. Added to §8-4's gate below: reconcile this URL (point it at the actual public mirror, once it exists) before 4c ships, not after.

**On app update:** the manifest pin does not move. Updating DevGame never silently changes a Unity project. Detection reports "your project has v0.2.0, this DevGame expects v0.3.0" and offers an explicit, consented pin bump.

**On a teammate's clone:** the git URL is machine-independent; UPM resolves it on first open (subject to the git-on-PATH caveat above). `packages-lock.json` keeps their resolved commit stable (`upm-conflicts-auto.html`).

**On a cold import:** a git-sourced package lives outside `Assets/`, so no new `.meta` files appear under `Assets/` and no scene/prefab references shift.

**Gate:** this requires the package to be reachable *without credentials*. `t3code-fork` is not obviously publishable. **Establish before building 4c:** owner decision on whether to publish a split, package-only repo mirrored on tag. If the answer is "must stay private," the recommendation changes — private git URLs need per-developer SSH auth and are hostile; the fallback would be a signed tarball hosted at a stable HTTPS URL, which then requires building the tarball pipeline that does not exist yet.

## 5. Order of work

**Phase 1 — detection only. Ships alone, writes nothing, blocked on nothing in §8.** This is the actual fix for the bug that started this plan; everything after it is a separate, later feature.

| # | Increment | Writes anything? | Proves |
|---|---|---|---|
| **0** | Correct `unity/README.md` (package rebuilt, not deleted) | repo only | Stops the next reader repeating lane 3's wrong conclusion |
| **1** | `UnitySetupProbe` — free probes + `pipeline list --json`, returning the S1–S12(+ variants) state; new `presence:read`-scoped route, server-resolved project path (§1) | no | The taxonomy is derivable from data we already have and currently throw away |
| **2** | Wire toolbar messages to the probe; retire substring classification; verbatim passthrough for S12 | no | **The owner's exact scenario now says the true sentence.** This is the ship-worthy half |
| **3** | Read-only "Set Up Integration" panel in `apps/web/src/components/settings/ConnectionsSettings.tsx`: per-item status + copy-paste command (flags included, per F12), no buttons that write | no | Honest reporting end to end; puts the copy in front of the owner before any mutation exists |

**Phase 2 — installation. Each increment individually blocked on §8; none of them block Phase 1.**

| # | Increment | Writes anything? | Proves |
|---|---|---|---|
| **4a** | Consented `unity pipeline install --project-path "<path>" --json --non-interactive` | project manifest, lockfile (whole resolved closure, not just the manifest line — §3) | One-click fixes the motivating failure |
| **4b** | Consented Unity CLI install, **plus splicing `~/.unity/bin` into this server process's own `process.env.PATH` on success** (F5 — see below) | `~/.unity`, `~/.zshrc`, this process's own env | Blocked on §8-3 |
| **4c** | Consented presence package add + pairing handoff | project manifest, EditorPrefs | Blocked on §8-4 |

**4b's PATH fix, spelled out (F5):** the existing PATH-repair mechanism (`DesktopApp.ts:226-231`, `installIntoProcess`) runs exactly once, at startup, before bootstrap — confirmed the only non-definition, non-test call site via `grep -rn "installIntoProcess" apps --include="*.ts"`. Without a fix, 4b installs the CLI to `~/.unity/bin`, appends the shell-rc sourcing line, and then the *running* server process's `PATH` is unchanged — `isCommandAvailable("unity")` stays false, and the plan's own S2 rule would fire, blaming DevGame for a problem DevGame's own success path just created. Fix: on 4b's install success, splice the discovered install path directly into `process.env.PATH` for the running process (no restart required) and show S2′ during the brief window before that completes. If for some concrete reason an in-process splice turns out not to be feasible, the fallback is a dedicated "installed — restart DevGame to finish" state, but that is the fallback, not the default design; 4b's own scope includes proving the splice works before shipping either way.

Increments 0–3 touch no user project at all and can merge independently.

**E2E gate (per owner doctrine, tracked open until closed):** increment 2 is not done on green tests. It is done when the owner's real `Mafia Game` Editor, open with Pipeline absent, produces S4's sentence in the live app — screenshot as evidence, naming the commit. Per the critique's own open question: this gate proves the sentence is *true*, not that it's the fix for the owner's *originally reported* symptom, since which action (`editor_play` vs `editor_status`) produced that original report was never re-confirmed. Settling that is listed in §8 as a should-check, not a blocker — the honest sentence ships either way.

## 6. What this is NOT building, and why

- **MCP setup UI** — already fully automatic (§0). Building it would be inventing work.
- **`unity mcp configure` from DevGame** — machine-global mutations to *other* products' configs for a capability DevGame doesn't use.
- **`unity auth login` inside DevGame** — browser OAuth. We print the command. (`--client-id/--client-secret` service-account mode exists in help text but was never exercised.)
- **A generic multi-engine wizard** — Godot (`godot/addons/`) and Unreal (`unreal/EditorPresence/`) install by entirely different mechanisms. Unity first; generalize on the second real case, not the first.
- **Auto-install on project open, or on a failed Play** — the app never edits a project because something failed.
- **Uninstall / rollback** — no uninstall hook exists and the EditorPrefs token is machine-wide, cleared only by the explicit "Forget token" button (`EditorPresenceSettingsProvider.cs:59-64`). We show the manifest line to delete. Nothing more.
- **Anything on Pipeline's `/api/exec` surface** — the first exec call of any kind deadlocked the Editor main thread, 3/3, on this exact version pairing. Play/Stop/Pause/status only. *(F8: this finding lives in a sibling repo's worktree — `.claude/worktrees/substrate-research/spikes/unity-testbed/REPORT.md` in `gamedev-workbench`, not a path inside `t3code-fork` — so it is unverifiable to anyone reading only this repo. Action item, not done here: copy the report's relevant section into `docs/workbench/` in this repo before this exclusion is relied on as load-bearing by anyone who only has `t3code-fork` checked out.)*

## 7. Failure modes: how each is detected and reported

| Failure | Detection | Report |
|---|---|---|
| **Offline during install** | non-zero exit from `unity pipeline install --json --non-interactive` (F12) | S12: CLI stderr verbatim + manual command. Exact error shape is UNKNOWN (§8-1) — until established, do **not** try to classify it |
| **Wrong Unity version** | read `ProjectSettings/ProjectVersion.txt` (free) against **Pipeline's own floor**, not this package's (F7 — `com.ironmind.editor-presence`'s `"unity": "6000.3"` is our own package's floor, confirmed in its `package.json`, and is the wrong number to gate Pipeline installs on; the plan's own parenthetical already says Pipeline is 6.0 LTS+, one version-line earlier than 6000.3). Primary: query `unity pipeline list-versions --json` (or Pipeline's own resolved `package.json` once known) for its actual floor. If that isn't queryable ahead of install, **do not gate at all** — attempt the install and surface Unity's own rejection verbatim through S12, the same philosophy §1 already applies everywhere else | Refuse to offer install only when a real Pipeline-specific floor is known and violated; name both versions: "This project is on `<x>`; the Pipeline package needs `<Pipeline's real floor>` or newer." |
| **Editor running during install** | `Temp/UnityLockfile` present (subject to §2's liveness rule — the authoritative `pipeline list` signal wins when available) | Warned in the consent prompt; after success: "Click back into Unity to let it pick up the change." Manual manifest edits are picked up on refocus, but the Package Manager window does not refresh itself (`cus-edit-manifest.html`) |
| **Concurrent installs** | serialize — one install in flight per project | Unity documents concurrent `Client.Add` as nondeterministic (`PackageManager.Client.Add.html`). Second click queues, it does not race |
| **Permissions / rc-file writes** | CLI installer touches `~/.unity` and shell rc | Blocked behind §8-3. Until then 4b shows the command only |
| **Packaged-app PATH** | S1 vs S2 split, now via a small candidate-path probe rather than one hardcoded location (F11 — see below) | The app names its own failure instead of blaming Unity. `DesktopShellEnvironment` repair was traced in source (`:277-296`, `:356-398`) but never observed in a real DMG launch — and `launchctl getenv PATH` is empty on this machine, so the entire mechanism rests on the 5-second `-ilc` probe |
| **CLI wording drift** | structured fields + verbatim passthrough (§1) | Already happened once. This is the class of bug being fixed, not a hypothetical |
| **Package added but Unity never resolves it** *(new — F9)* | a later probe still shows the package absent from `packages-lock.json` after a consented add | Distinct troubleshooting hint naming Unity's own git-on-PATH requirement (§4), not a repeat of the original "missing" sentence |

**F11 fix, spelled out:** the old S1/S2 split hardcoded `~/.unity/bin/unity` as *the* install location, grounded only in one machine's observed artifact (`~/.unity/env`'s comment plus mtime correlation) — the digest itself lists the installer's actual on-disk behavior as unexercised. A Windows/Linux user, or anyone whose installer honored a different prefix, would get S1 ("not installed") and be offered a duplicate install of a CLI they already have. Fix, using what already exists in this codebase: `unity doctor`/`resolveCommandPath`-style candidate-path probing — check a short list of plausible install locations (informed by the actual documented installer behavior, once §8-3 settles it) rather than one hardcoded path, and when a binary is found off-PATH, report the *discovered* path in S2's sentence, not an assumed canonical one. This also removes the plan's implicit macOS-only assumption.

## 8. Establish before building the install half

Items 1–5 each block a Phase 2 increment; none blocks increments 0–3. Item 6 is the one exception, and it's narrower than it looks: it blocks exposing increment 1's route to real, untrusted callers in production — not the detection/classification logic itself, which is fully specced in §2 and can be built and tested against a fixed, known project path immediately, same as everything else in Phase 1.

1. **Does `unity pipeline install` work with no Editor running?** The `--project-path` flag implies yes, but that is inference from help text — no install was ever observed. *Settle it:* copy a scratch project, close Unity, run it, diff `manifest.json` and `packages-lock.json`, and record the actual lock delta — this also settles F4's honest-diff-copy question with real numbers instead of the inferred ones above. **Blocks 4a's core promise** (if it needs a running Editor, the S5 flow is impossible as designed).
2. **Do local Play/Stop/status need `unity auth`?** *Settle it:* logged-out scratch environment — never the owner's real session. **Blocks whether S3 gates Play or only gates installs.** Until settled, S3 gates installs only.
3. **Is `install.sh` idempotent, does it need sudo, does it edit rc files unconditionally, and what path does it actually install to?** Only its URL was ever observed (in Hub's `app.asar`); it was never run. *Settle it:* a throwaway user account or container. **Blocks 4b, and directly informs F11's candidate-path list.**
4. **Public or private hosting for the presence package?** Owner decision. If public: who runs the tag-mirror, on what trigger, and what proves `.meta` survived it (F9)? Also reconcile the package's shipped `documentationUrl`, which currently points at an unrelated, possibly-private repo (F9). **Blocks 4c** and, if private, invalidates the §4 recommendation.
5. **Does `DesktopShellEnvironment.installIntoProcess` actually run in a packaged DMG?** *Settle it:* one real DMG launch with `unity` on PATH. **Downgrades S1/S2 confidence until done** — this is the difference between "correctly reports not installed" and "lies about a working install." Also settles whether 4b's in-process PATH splice (F5) needs the SAME repair mechanism reused, or a separate one.
6. **Which registry validates the new probe route's project path (§1, F6)?** Not a research unknown so much as an implementation check: confirm what set of project roots a `presence:read`-scoped session is already legitimately bound to, and validate the probe's path argument against it before any filesystem access. Blocks exposing increment 1's route to real, untrusted callers in production — the scope grant itself (§1) is decided, and the detection logic can be built and tested against a fixed project path before this is settled; this is the one remaining mechanical piece before that route goes live.
7. Cosmetic, note only: `unity/README.md:21` says ~130 Pipeline tools; the cross-repo spike report (§6, F8) says 140. Unresolved; harmless.

---

**Observed vs. inferred in this plan:** every file:line, command output, and package-state claim above is observed — re-verified against the critique's own re-verification pass (`c7e46ad86` at critique time), including the manifest/lock delta, the `safeMode` field, the `EditorPresenceRegistry` ephemerality doc comment, the `AuthPresenceCommandScope` grant restriction, the caller-supplied `workspaceRoot` in the existing command route, and the `documentationUrl` mismatch. The state taxonomy, distribution recommendation, consent model, scope decision, and work order are design proposals — inferred from that evidence, not observed anywhere.

---

## Critique resolution log

Every finding in `plan-setup-integration-critique.md` is resolved below. None were rejected — all 15 held up on inspection; each is addressed in the section named, not just noted here.

| Finding | Severity | Resolution |
|---|---|---|
| **F1** — manifest.json is not the state file | HIGH | ACCEPTED. §1: `packages-lock.json` is now the authoritative source; manifest read only for consent-prompt intent, never as the installed-check. Applies to S4/S5/S9 in §2. |
| **F2** — S7's sentence is a confident false statement; `safeMode` unused | HIGH | ACCEPTED. §2: S7 split into S7a (Safe Mode, distinct non-auto-clearing message) and S7b (bounded retry, "reloading" only claimed after recovery, never as first-shot). |
| **F3** — S10's absence-of-publisher has 4+ causes | HIGH | ACCEPTED. §2: S10 now gated on independently-confirmed liveness plus a server-start grace window (S10′ "checking" state during the window). |
| **F4** — consent model promises an uncomputable diff; "nothing else in git" is false | HIGH | ACCEPTED. §3: prompt now shows the manifest line only, states plainly that the lockfile will be re-resolved and may shift other entries, and drops the false "nothing else appears in git" claim. §8-1 now also settles this with real numbers before 4a ships. |
| **F5** — 4b manufactures S2 in the same session | HIGH | ACCEPTED. §5: 4b splices the install path into the running process's own `PATH` on success; new S2′ state covers the brief window; S2's "DevGame bug" copy never fires for 4b's own success path. |
| **F6** — new route, no stated auth scope | HIGH | ACCEPTED and decided, not deferred. §1: new `presence:read` scope, added to `AuthStandardClientScopes` (unlike `presence:command`), reachable from the web panel. Path-validation principle stated (never trust a bare caller-supplied path); the exact registry to validate against is the one item still flagged, as §8-6, not silently left open. |
| **F7** — version-floor check uses our package's floor for Unity's package | MEDIUM | ACCEPTED. §7: gate on Pipeline's own queryable floor; if unqueryable, don't gate at all and let Unity's own resolver report it via S12. |
| **F8** — citations point at a file outside this repo / a stale HEAD | MEDIUM | ACCEPTED. §0's HEAD citation replaced with the ancestry check itself (doesn't go stale). §6 now states the cross-repo path plainly and flags copying the report into this repo as a follow-up action, not performed in this revision. |
| **F9** — distribution defense contradicts itself on the mirror step; ignores git-on-PATH; `documentationUrl` mismatch | MEDIUM | ACCEPTED, all three. §4: acknowledges the mirror is the real copy step and expands §8-4's gate to cover it; documents the git-on-PATH risk with a dedicated troubleshooting state (§7); flags the `documentationUrl` mismatch as part of the same gate. |
| **F10** — S8 undetectable when Unity's closed; `updateAvailable:false` untrustworthy when `latestVersion` is null | MEDIUM | ACCEPTED. §2: new S8′ state — not evaluated at all (falls through, never asserted as "up to date") when Unity's closed or `latestVersion` is null. |
| **F11** — S1/S2 hardcode one machine's install path | MEDIUM | ACCEPTED. §7: candidate-path probing via existing `unity doctor`/`resolveCommandPath` machinery; S2 reports the actually-discovered path, not an assumed one. |
| **F12** — install command missing `--json`/`--non-interactive` | MEDIUM | ACCEPTED. §3, §5, §7: both flags added everywhere the command is constructed or shown to the user; shown command matches the run command. |
| **F13** — lockfile-as-liveness has no stale-lock handling; S4's detector was an unresolved OR | MEDIUM | ACCEPTED. §2: `pipeline list`'s `pid`/`isRunning` is authoritative whenever it has run; lockfile is the cheap ambient pre-check only. New S4′ covers the window before the authoritative check runs. |
| **F14** — path-matching should reuse the existing normalizer | LOW | ACCEPTED. §1: names `resolveProjectEditor.ts`'s normalizer explicitly as the required join key. |
| **F15** — citation line-number drift | LOW | ACCEPTED. §1: corrected to `shell.ts:601-609`. |

**Carried forward unchanged, per instruction:** MCP needs no setup at all (§0) — mounted unconditionally, server-issued token, zero user action. `unity pipeline list --json` already returns the full taxonomy and is called nowhere in the codebase (§1) — this is still the plan's central thesis and the critique did not challenge it.
