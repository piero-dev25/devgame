<!-- Produced by a 7-agent research workflow (wf_71dc8f4d-d70): five parallel
investigation lanes over this repo and this machine, one web lane on current
Unity documentation, an Opus synthesis, and a FRESH Opus adversarial critic.
The critique is preserved alongside the plan deliberately: it found the plan
reintroducing the same defect class the plan exists to fix. Read both. -->

# Set Up Integration — implementation plan (Unity first)

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

**Doc correction, do this first:** `unity/README.md:11-46` still says our package was deleted and "Unity selection is currently unimplemented." It was rebuilt (`git log unity/com.ironmind.editor-presence` → `6799b7b4b` after `33d6cc4d8`; HEAD `05b28ce7b` postdates both). One research lane already drew the wrong conclusion from that README. Fix the file before anyone else reads it.

## 1. Detection and installation are separate features. Ship detection alone.

**Yes — detection is worth shipping by itself, and should ship first.** It writes nothing to anyone's project, needs none of the open UNKNOWNs resolved, and it alone fixes the defect that started this. Installation depends on four unresolved questions (§8).

Confirmed dead giveaway that detection is the real gap: `pipeline list --json` already returns the exact taxonomy the UI needs (`isRunning` / `hasPipelinePackage` / `pipelineServer.isReachable` / `pipelineVersion` / `updateAvailable`) — and it is **called nowhere in the codebase**. Verified: `/usr/bin/grep -rn "hasPipelinePackage|pipeline list|pipeline install" apps packages --include="*.ts" --include="*.tsx"` → no hits.

### Detection inputs, cheapest first

| Tier | Probe | Cost | Cadence |
|---|---|---|---|
| Free | `isCommandAvailable("unity")` — PATH stat, no spawn (`packages/shared/src/shell.ts:513-568`) | sub-ms | ambient / every render |
| Free | `Temp/UnityLockfile` exists (`UnityColdStart.ts:59-61`) | sub-ms | ambient |
| Free | read `Packages/manifest.json` for the two package keys — precedent `EngineTypeResolver.ts:108-130` | sub-ms | ambient, 1-min TTL (`EngineTypeResolver.ts:49`) |
| ~400ms | `unity pipeline list --json` | measured 0.400s | on demand only: panel open, Play click, explicit refresh |
| ~285ms | `unity command editor_status --json` | measured 0.285s | already reactive; unchanged |

`pipeline list` has **no `--project-path` filter** and only sees Editors that are *currently running* (digest lane 1). So `manifest.json` is the authoritative "is the package installed" source and `pipeline list` is the corroborator for the live-Editor half — not the other way round.

### The classification rule that fixes the drift

Delete substring matching as the *classifier*. `NOT_READY_MESSAGE_PATTERNS` (`UnityPipelineClient.ts:126-134`) is already stale against CLI 1.0.0-beta.3: today's live message is `"No Unity Editor instances found with reachable Pipeline servers."`, which matches none of the three hardcoded strings — so the owner's scenario currently falls through to the generic error toast (`ChatView.tsx:1630-1636`). Replace with:

1. Classify from `pipeline list`'s structured booleans + the manifest read.
2. Keep the substring list only as a degraded fallback when `pipeline list` itself fails.
3. **When nothing matches, show the CLI's own message verbatim.** Never map an unrecognized CLI string onto a friendly sentence. The current bug is exactly that mapping.

## 2. Every distinguishable state and its exact sentence

The four-tag contract (`ok`/`notReady`/`cliUnavailable`/`error`) is an owner ruling (`UnityCommandRoute.ts:24-32`, `packages/contracts/src/unity.ts:54-76`) — keep the tags, split `notReady` into a `reason` field. No tag is removed, so the contract holds.

| State | Detected by | Sentence shown |
|---|---|---|
| **S1 CLI not installed** | `isCommandAvailable` false **and** `~/.unity/bin/unity` absent on disk | "Unity's command-line tool isn't installed on this machine. DevGame needs it to talk to the Editor." + **Install** |
| **S2 CLI installed but invisible to this app** | `isCommandAvailable` false **and** `~/.unity/bin/unity` present on disk | "The Unity CLI is installed at `~/.unity/bin/unity`, but DevGame can't find it on this app's PATH. Quit and reopen DevGame; if it persists, tell us — this is a DevGame bug, not a Unity one." |
| **S3 Not signed in** (install actions only) | `unity auth status --json` → `loggedIn:false` | "You're not signed in to the Unity CLI. Run `unity auth login`, then try again." |
| **S4 Pipeline package missing, Unity open** ← **the defect** | manifest has no `com.unity.pipeline`; lockfile present / `isRunning:true` | "Unity is open, but this project doesn't have Unity's Pipeline package — that's why Play doesn't work here. DevGame can add it to this project." + **Add package** |
| **S5 Pipeline package missing, Unity closed** | manifest key absent; lockfile absent | "This project doesn't have Unity's Pipeline package, and Unity isn't open. Add the package, then open the project in Unity." |
| **S6 Pipeline installed, Unity not open** | manifest key present; lockfile absent | "Unity isn't open for this project. Open it in the Unity Editor, then try again." — *today's sentence, but now only shown when it is true* |
| **S7 Pipeline installed, Unity open, server unreachable** | `hasPipelinePackage:true` + `isReachable:false` | "Unity is reloading scripts. This clears on its own in a few seconds." (retry path, not an error) |
| **S8 Pipeline out of date** | `updateAvailable:true` | "This project's Pipeline package is older than your Unity CLI expects. Update it to `<version>`?" + **Update** |
| **S9 Selection package missing** | manifest has no `com.ironmind.editor-presence` | "Unity selection chips are off — this project doesn't have DevGame's selection package." + **Add package** |
| **S10 Selection package present, not paired** | package in manifest, no publisher registered for this workspace root (`EditorPresenceRegistry`) | "Unity has DevGame's selection package but isn't paired with this app yet. Pair it from Settings > Connections." |
| **S11 Everything ready** | all above green | No message. Controls enabled. |
| **S12 Anything else** | CLI non-zero exit, unmatched message | *The CLI's own message, verbatim, unedited*, plus the command that produced it. |

## 3. Consent model

Non-negotiables: nothing is written without a click; a refusal always leaves a working manual path.

- **Per machine, asked once:** installing the Unity CLI (writes `~/.unity/`, appends to `~/.zshrc` — observed: `~/.unity/env` + `~/.zshrc:44`), and `unity auth login`.
- **Per project, asked per write:** every edit to `Packages/manifest.json`. The prompt names the project path and shows the literal diff it will apply — the two lines added, the two files touched (`Packages/manifest.json`, `Packages/packages-lock.json`; `Library/` is gitignored so nothing else appears in git — observed against `Mafia Game/.gitignore` + `git ls-files`).
- **What "remember" means:** "Don't ask again for this project" suppresses re-asking *for the identical write only*. A version bump, a second package, or a different project re-asks. There is no global "always install into any project."
- **Editor-open warning is part of the prompt, not a separate toast:** "Unity is open. It will reimport this project and be unresponsive for a few seconds." Shown when the lockfile is present.
- **Refusal degrades to copy-paste, never to a dead end:** every action shows its exact equivalent command (`unity pipeline install --project-path "<path>"`) with a copy button.
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

**The `.meta`/GUID hazard is handled structurally, not by discipline.** All 20 files (10 content + 10 `.meta`) are git-tracked with real assigned GUIDs — verified: `git ls-files unity/com.ironmind.editor-presence`, `EditorPresenceConnection.cs.meta` guid `f7b87965513b64c1481bfa2e55d76d50`. UPM git resolution clones, so `.meta` files travel; there is no copy step to get wrong. (The blast radius is small today anyway — no `MonoBehaviour`/`ScriptableObject` in the package, digest lane 3 — but that is a property of today's code, not a guarantee.)

**On app update:** the manifest pin does not move. Updating DevGame never silently changes a Unity project. Detection reports "your project has v0.2.0, this DevGame expects v0.3.0" and offers an explicit, consented pin bump.

**On a teammate's clone:** the git URL is machine-independent; UPM resolves it on first open. `packages-lock.json` keeps their resolved commit stable (`upm-conflicts-auto.html`).

**On a cold import:** a git-sourced package lives outside `Assets/`, so no new `.meta` files appear under `Assets/` and no scene/prefab references shift.

**Gate:** this requires the package to be reachable *without credentials*. `t3code-fork` is not obviously publishable. **Establish before building 4c:** owner decision on whether to publish a split, package-only repo mirrored on tag. If the answer is "must stay private," the recommendation changes — private git URLs need per-developer SSH auth and are hostile; the fallback would be a signed tarball hosted at a stable HTTPS URL, which then requires building the tarball pipeline that does not exist yet.

## 5. Order of work

| # | Increment | Writes anything? | Proves |
|---|---|---|---|
| **0** | Correct `unity/README.md` (package rebuilt, not deleted) | repo only | Stops the next reader repeating lane 3's wrong conclusion |
| **1** | `UnitySetupProbe` — free probes + `pipeline list --json`, returning the S1–S12 state | no | The taxonomy is derivable from data we already have and currently throw away |
| **2** | Wire toolbar messages to the probe; retire substring classification; verbatim passthrough for S12 | no | **The owner's exact scenario now says the true sentence.** This is the ship-worthy half |
| **3** | Read-only "Set Up Integration" panel in `apps/web/src/components/settings/ConnectionsSettings.tsx`: per-item status + copy-paste command, no buttons that write | no | Honest reporting end to end; puts the copy in front of the owner before any mutation exists |
| **4a** | Consented `unity pipeline install --project-path` | project manifest | One-click fixes the motivating failure |
| **4b** | Consented Unity CLI install | `~/.unity`, `~/.zshrc` | Blocked on §8-3 |
| **4c** | Consented presence package add + pairing handoff | project manifest, EditorPrefs | Blocked on §8-4 |

Increments 0–3 touch no user project at all and can merge independently.

**E2E gate (per owner doctrine, tracked open until closed):** increment 2 is not done on green tests. It is done when the owner's real `Mafia Game` Editor, open with Pipeline absent, produces S4's sentence in the live app — screenshot as evidence, naming the commit.

## 6. What this is NOT building, and why

- **MCP setup UI** — already fully automatic (§0). Building it would be inventing work.
- **`unity mcp configure` from DevGame** — machine-global mutations to *other* products' configs for a capability DevGame doesn't use.
- **`unity auth login` inside DevGame** — browser OAuth. We print the command. (`--client-id/--client-secret` service-account mode exists in help text but was never exercised.)
- **A generic multi-engine wizard** — Godot (`godot/addons/`) and Unreal (`unreal/EditorPresence/`) install by entirely different mechanisms. Unity first; generalize on the second real case, not the first.
- **Auto-install on project open, or on a failed Play** — the app never edits a project because something failed.
- **Uninstall / rollback** — no uninstall hook exists and the EditorPrefs token is machine-wide, cleared only by the explicit "Forget token" button (`EditorPresenceSettingsProvider.cs:59-64`). We show the manifest line to delete. Nothing more.
- **Anything on Pipeline's `/api/exec` surface** — the first exec call of any kind deadlocked the Editor main thread, 3/3, on this exact version pairing (`spikes/unity-testbed/REPORT.md:1-20`). Play/Stop/Pause/status only.

## 7. Failure modes: how each is detected and reported

| Failure | Detection | Report |
|---|---|---|
| **Offline during install** | non-zero exit from `unity pipeline install` | S12: CLI stderr verbatim + manual command. Exact error shape is UNKNOWN (§8-1) — until established, do **not** try to classify it |
| **Wrong Unity version** | read `ProjectSettings/ProjectVersion.txt` (free) against the package floor (`package.json` `"unity": "6000.3"`; Pipeline is 6.0 LTS+ per Unity's docs) | Refuse to offer install; name both versions: "This project is on `<x>`; the Pipeline package needs 6000.3 or newer." |
| **Editor running during install** | `Temp/UnityLockfile` present | Warned in the consent prompt; after success: "Click back into Unity to let it pick up the change." Manual manifest edits are picked up on refocus, but the Package Manager window does not refresh itself (`cus-edit-manifest.html`) |
| **Concurrent installs** | serialize — one install in flight per project | Unity documents concurrent `Client.Add` as nondeterministic (`PackageManager.Client.Add.html`). Second click queues, it does not race |
| **Permissions / rc-file writes** | CLI installer touches `~/.unity` and shell rc | Blocked behind §8-3. Until then 4b shows the command only |
| **Packaged-app PATH** | S1 vs S2 split (disk probe of `~/.unity/bin/unity`) | The app names its own failure instead of blaming Unity. `DesktopShellEnvironment` repair was traced in source (`:277-296`, `:356-398`) but never observed in a real DMG launch — and `launchctl getenv PATH` is empty on this machine, so the entire mechanism rests on the 5-second `-ilc` probe |
| **CLI wording drift** | structured fields + verbatim passthrough (§1) | Already happened once. This is the class of bug being fixed, not a hypothetical |

## 8. Establish before building the install half

Each blocks a specific increment. None blocks increments 0–3.

1. **Does `unity pipeline install` work with no Editor running?** The `--project-path` flag implies yes, but that is inference from help text — no install was ever observed. *Settle it:* copy a scratch project, close Unity, run it, diff `manifest.json`. **Blocks 4a's core promise** (if it needs a running Editor, the S5 flow is impossible as designed).
2. **Do local Play/Stop/status need `unity auth`?** *Settle it:* logged-out scratch environment — never the owner's real session. **Blocks whether S3 gates Play or only gates installs.** Until settled, S3 gates installs only.
3. **Is `install.sh` idempotent, does it need sudo, does it edit rc files unconditionally?** Only its URL was ever observed (in Hub's `app.asar`); it was never run. *Settle it:* a throwaway user account or container. **Blocks 4b.**
4. **Public or private hosting for the presence package?** Owner decision. **Blocks 4c** and, if private, invalidates the §4 recommendation.
5. **Does `DesktopShellEnvironment.installIntoProcess` actually run in a packaged DMG?** *Settle it:* one real DMG launch with `unity` on PATH. **Downgrades S1/S2 confidence until done** — this is the difference between "correctly reports not installed" and "lies about a working install."
6. Cosmetic, note only: `unity/README.md:21` says ~130 Pipeline tools, `spikes/unity-testbed/REPORT.md:12` says 140. Unresolved; harmless.

---

**Observed vs. inferred in this plan:** every file:line, command output, and package-state claim above is observed (re-verified this session for `ChatView.tsx:1609-1636`, `UnityPipelineClient.ts:99-134`, the absent `pipeline list` usage, the rebuilt package on disk, and the stale README). The state taxonomy, distribution recommendation, consent model, and work order are design proposals — inferred from that evidence, not observed anywhere.