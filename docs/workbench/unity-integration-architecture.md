# Unity integration: what this repo already has, and where Unity status attaches

Architecture study of the DevGame fork at `/Users/pieroherrera/Projects/t3code-fork`
(branch `workbench/dock-port`). Investigation only — no code was changed.

**The checkout moved during this study.** It was at `ae793a86b` when I started and
`686481084` when I finished; two commits landed from concurrent lanes —
`da0d5d247` "Engine toolbar foundations: capabilities, per-project engine, editor match"
and `686481084` "feat(unity): Play/Stop command handling — warm path + play state +
cold-start plan (#49)". Where that changed a finding, I say so explicitly rather than
quietly restating it.

**Evidence discipline.** Every claim is labelled `VERIFIED` (I or a lane read the code and
cite `path:line`) or `INFERRED` (reasoned from what was read, not observed). Anything that
depends on Unity's own external behaviour — the CLI, `com.unity.pipeline` — is marked
`DEPENDS ON UNITY LANE` and is _not_ asserted here.

---

## 0. The short version

1. **Engine detection already exists, is correct, and should be extended, not replaced.**
   `EngineTypeResolver` detects Unity from `ProjectSettings/ProjectVersion.txt`; the result
   rides on the project contract as `OrchestrationProject.engineType`. As of `da0d5d247`
   (landed mid-study) it has its first client consumer — the per-project Play/Stop toolbar.
   A Unity status field belongs beside it, resolved by the same batched pattern.
2. **An exact install-with-progress precedent exists: `cloud.installRelayClient`.** A status
   union with a "can never work here" arm, a **streaming RPC** whose success channel is the
   progress event, typed failure reasons, an in-process semaphore plus a stale-reclaiming
   advisory lock file, a confirmation gate, and a stage-labelled dialog. Copy it (§3).
3. **The agent-facing seam already exists and already returns screenshots.** The in-app MCP
   server ships a `preview` toolkit whose `preview_snapshot` returns a base64 PNG in the tool
   result. A `unity` toolkit is the same shape with `EditorPresenceRegistry` in the broker seat.
   Caveat: the ACP protocol carries image content blocks, but this repo only ever _sends_
   them — nothing consumes an inbound one, and `AssistantTimelineRow` ignores attachments
   entirely (§5.4, §5.5).
4. **Checkpoints on Unity projects are already measured, and the owner already ruled.**
   Cost is repo hygiene (LFS drift), not T3's code. Two Unity-specific _correctness_ hazards
   are open — `.meta` orphaning on revert, and a large-scene diff limit whose exact
   behaviour I could not reconcile with a sibling lane's claim (§6.1).
5. **Plugin overlap — RESOLVED, and not the way I first argued.** I judged our plugin
   load-bearing because it is one of _three_ implementations of a protocol the registry,
   chip UI, capability table and toolbar all speak. The uniformity argument held; the
   verdict did not. The plugin was deleted (`33d6cc4d8`) on stronger evidence than I had —
   Pipeline round-tripped against a real running Editor, our plugin installed in the owner's
   project **nowhere**, and its NAT justification void (it defaults to `127.0.0.1`).
   Uniformity is instead preserved by a **server-side publisher** into the same
   `EditorPresenceRegistry` — better than the in-Editor adapter I proposed, because it keeps
   the user on one package. Recorded as direction, not tonight's task. **§9.0.**
6. **The nearest thing to a blocker is not Unity's package — it is our own last mile.** The
   toolbar component exists but is not mounted; `dispatchEditorCommand` has no RPC caller;
   nothing discovers the Unity binary. Three small gaps between built-and-tested pieces (§9.6).
7. **Two constraints that bound any design, both `VERIFIED`.** The Unity Editor must run on
   the same machine as `apps/server` — remoteness is connection-layer only, never a runtime
   split (§4.4.1). And "cancel" in this system asks the far side to stop; it does **not**
   kill a process (§4.4), so a `-batchmode` test run or build would need its own kill path.
8. **Three Unity-relevant defects found on the way**, now tracked as tasks #65/#66/#67:
   checkpoint diffs silently truncate at 10 MB with no channel for the fact to reach the
   client (§6.1); revert has no `.meta` pairing awareness (§6.2); assistant messages cannot
   display an image (§5.5). None was the object of this study.

---

## 1. The Add Project flow

### 1.1 Client → server

`VERIFIED`

Project writes do not have their own RPC. Everything goes through one method:

- `packages/contracts/src/orchestration.ts:29` — `ORCHESTRATION_WS_METHODS.dispatchCommand
= "orchestration.dispatchCommand"`. The full method set is only seven entries
  (`:28-36`): `dispatchCommand`, `getTurnDiff`, `getFullThreadDiff`, `searchThreads`,
  `getArchivedShellSnapshot`, `subscribeShell`, `subscribeThread`.

The add-project command:

```
packages/contracts/src/orchestration.ts:584-593
ProjectCreateCommand = {
  type: "project.create",
  commandId, projectId, title, workspaceRoot,
  createWorkspaceRootIfMissing?: boolean,
  defaultModelSelection?: ModelSelection | null,
  createdAt: IsoDateTime,
}
```

Siblings: `ProjectMetaUpdateCommand` (`:595-603`, carries `title`, `workspaceRoot`,
`defaultModelSelection`, `scripts`) and `ProjectDeleteCommand` (`:605-610`).

Events emitted: `project.created`, `project.meta-updated`, `project.deleted`
(`packages/contracts/src/orchestration.ts:1006-1008`, payload structs at `:1293-1305`).
Decider at `apps/server/src/orchestration/decider.ts`; projector at
`apps/server/src/orchestration/projector.ts`.

### 1.2 Persistence

`VERIFIED`

`apps/server/src/persistence/Migrations/005_Projections.ts:8-18`:

```sql
CREATE TABLE IF NOT EXISTS projection_projects (
  project_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  workspace_root TEXT NOT NULL,
  default_model TEXT,
  scripts_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
)
```

This is a **projection**, not a source of truth — the system is event-sourced
(`AGENTS.md`: "a pure _decider_ turns commands into persisted _events_, and a _projector_
derives the read model"). Note what is **absent**: no `engine_type` column, no
`repository_identity` column. Both are derived at read time (§2).

### 1.3 The client-facing project record

`VERIFIED` — `packages/contracts/src/orchestration.ts:215-231`:

```ts
OrchestrationProject = Schema.Struct({
  id: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  repositoryIdentity: optional(NullOr(RepositoryIdentity)),
  engineType: optional(NullOr(EngineType)), // ← :224, derived live, never persisted
  defaultModelSelection: NullOr(ModelSelection),
  scripts: Array(ProjectScript),
  createdAt,
  updatedAt,
  deletedAt,
});
```

A lighter `OrchestrationProjectShell` (`:449-461`) carries the same `engineType` field at
`:455` with the comment "See OrchestrationProject.engineType — same live-detection contract."

### 1.4 Per-project checked-in config

`VERIFIED` — `packages/contracts/src/t3ProjectFile.ts`

`T3_PROJECT_FILE_NAME = "devgame.json"` (`:7`), published JSON Schema at
`site/schema/devgame.json`, loader `apps/server/src/project/T3ProjectFileLoader.ts`.
Current fields: `$schema`, `iconPath`, `scripts[]` (`name`, `command`, `icon`,
`runOnWorktreeCreate`, `previewUrl`, `autoOpenPreview`). Best-effort: an invalid file is
treated as absent, not an error.

This is the file a _team_ shares. It is the right place for Unity **configuration**
(e.g. "which Unity editor version this project wants") and the wrong place for Unity
**status** (which is derived and machine-local).

### 1.5 Where a per-project "Unity integration status" attaches

**Recommendation: `OrchestrationProject.engineType`'s neighbour — a new derived field on
the same struct, computed by the same batched resolver pattern.**

`VERIFIED` that this is the established shape for exactly this kind of data:

- Declare in `packages/contracts/src/orchestration.ts`, immediately after `engineType`
  (`:224`), as `optional(NullOr(UnityIntegrationStatus))`. `optional` matters: the existing
  comment at `:222-223` records why — "Optional so servers/fixtures predating this field
  still decode."
- Mirror on `OrchestrationProjectShell` (`:455`) so the sidebar can render a badge without
  a full project read.
- Resolve in `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts` with a
  third `resolveXForProjects` helper alongside `resolveRepositoryIdentitiesForProjects`
  (`:343-373`) and `resolveEngineTypesForProjects` (`:381-411`) — batched, deduped by
  `workspaceRoot`, `concurrency: 4`. Five call sites already do this pairwise and would
  take a third argument: `:1451-1464`, `:1840-1858`, `:1989-2010`, `:2134-2147`, `:2172-2178`.
- Back it with a cached Effect service beside `EngineTypeResolver.ts` in
  `apps/server/src/project/`, using the same `Cache.makeWith` shape
  (`EngineTypeResolver.ts:279-285`).

**Alternative, and when to prefer it:** `EditorPresenceEntry`
(`apps/server/src/editorPresence/protocol.ts:172-190`) already carries per-editor
`capabilities` and `playState`, keyed by `session.id` with a `workspace.root`. If the
status you want is _"is a Unity editor live right now and what can it do"_, that is already
modelled and needs nothing new. Use `OrchestrationProject` for **on-disk facts** (package
present? which version? manifest parse failed?) and `EditorPresenceEntry` for **liveness**.
They answer different questions and both already exist.

**Do not** add a column to `projection_projects`. The existing comment at
`EngineTypeResolver.ts:6-10` states the reasoning that was already litigated here:
persisting derived detection "would require a migration plus touching the event schema,
decider, projector, and client contract, then go stale the moment someone adds an engine
to (or removes one from) an existing project folder."

### 1.5.1 The shape to copy: `ServerProvider`

`VERIFIED`. Separately from _where_ the field hangs, this repo already has a per-target
integration-status record with **exactly the fields the brief named** — installed / version
/ last-checked / an update job with status and error. It is `ServerProvider` in
`packages/contracts/src/server.ts`:

```ts
ServerProvider = Schema.Struct({
  instanceId, driver, displayName?, ...
  enabled: Boolean,
  installed: Boolean,                                  // ← detected / not-installed
  version: NullOr(TrimmedNonEmptyString),
  status: ServerProviderState,                         // "ready"|"warning"|"error"|"disabled"
  auth: ServerProviderAuth,                            // status: authenticated|unauthenticated|unknown
  checkedAt: IsoDateTime,                              // ← last-checked
  message: optional(TrimmedNonEmptyString),
  ...
  versionAdvisory: optionalKey(ServerProviderVersionAdvisory),
  updateState:     optionalKey(ServerProviderUpdateState),
})
```

with:

```ts
ServerProviderVersionAdvisory = {                       // server.ts:131-146
  status: "unknown"|"current"|"behind_latest",
  currentVersion, latestVersion, updateCommand,
  canUpdate: Boolean (decoding default false),
  checkedAt, message }

ServerProviderUpdateState = {                           // server.ts:~149-165
  status: "idle"|"queued"|"running"|"succeeded"|"failed"|"unchanged",
  startedAt, finishedAt, message,
  output: NullOr(String ≤ 10_000) }                     // ← captured stdout/stderr
```

Note `ServerProviderState` is a **separate** axis from `updateState.status`: "is this thing
healthy right now" is not "is an update job running". A Unity status model wants the same
split — do not collapse `installing` into the same enum as `detected`/`error`.

Supporting machinery, all reusable in spirit:
`apps/server/src/provider/providerMaintenance.ts` (capabilities + latest-version lookup,
`LATEST_VERSION_CACHE_TTL_MS = 1h`, `LATEST_VERSION_TIMEOUT_MS = 4s`, `:17-18`),
`providerMaintenanceRunner.ts`, `providerMaintenanceCommandCoordinator.ts`, and
`providerStatusCache.ts` — which persists a decoded `ServerProvider` snapshot to disk via
`writeFileStringAtomically` so a slow `--version` probe does not block first paint.

**Correction to an earlier draft of this section.** I initially wrote that provider status
reaches the client only through `server.getConfig` (request/response). That is wrong — a
lane traced the push path: `ProviderRegistry.streamChanges`
(`apps/server/src/provider/Layers/ProviderRegistry.ts:66-76`, a
`Stream<ReadonlyArray<ServerProvider>>`, updated by `setProviderMaintenanceActionState`)
surfaces to clients as `ServerConfigStreamProviderStatusesEvent`
(`packages/contracts/src/server.ts:501-507`) over the **`subscribeServerConfig` streaming
subscription**. So the delivery half is worth copying too — see §8.

The genuine wart is narrower: the triggering RPC `WsServerUpdateProviderRpc`
(`rpc.ts:304-308`) is plain request/response and **blocks until the whole command
finishes**, so the settings card's spinner is driven by a local boolean around that promise
(`apps/web/src/components/settings/SettingsPanels.tsx:1714`, `:1719-1721`, `:1785-1832`)
rather than by the finer server-pushed `updateState.status`. Only the sidebar pill
(`apps/web/src/components/sidebar/SidebarProviderUpdatePill.tsx:41-208`, via
`apps/web/src/components/ProviderUpdateLaunchNotification.logic.ts`) consumes the pushed
queued/running/terminal states. **Do not inherit that split**: drive one status feed.

**And the most useful negative finding in the whole study:**
`apps/web/src/components/settings/providerStatus.ts:45-49` renders `!provider.installed` as
headline "Not found" / detail "CLI not detected on PATH" — and
`ProviderInstanceCard.tsx` has **no `!installed` branch that renders any action at all**.
Only the `versionAdvisory: behind_latest` branch gets a button (`:651-663`). So this repo
already ships the exact UX we would be trying to avoid for Unity: _"the thing you need
isn't here"_ with no way to fix it from the app.

### 1.6 Folder picking and server-side validation

`VERIFIED`.

**Folder picking is server-side path browsing, not a native dialog.**
`packages/contracts/src/filesystem.ts`:

```ts
FilesystemBrowseInput  = { partialPath (≤512), cwd? (≤512) }        // :6-9
FilesystemBrowseEntry  = { name, fullPath }                          // :12-15
FilesystemBrowseResult = { parentPath, entries[] }                   // :18-21
FilesystemBrowseFailure = Literals([
  "windows_path_unsupported", "current_project_required", "read_directory_failed" ])  // :24-28
```

RPC `filesystem.browse` (`packages/contracts/src/rpc.ts:180`, `WsFilesystemBrowseRpc` at
`:474`); server side in `apps/server/src/workspace/WorkspaceEntries.ts` and `ws.ts`; client
side in `packages/client-runtime/src/state/filesystem.ts:79-80`. Because it is a wire call
rather than an Electron dialog, it works over the relay — consistent with AGENTS.md's
"remote ready" principle. `windows_path_unsupported` is a real, shipped failure literal.

**Server-side validation of a candidate folder** happens in one place:
`apps/server/src/orchestration/Normalizer.ts:65-90` —
`normalizeProjectWorkspaceRootForCreate` delegates to
`WorkspacePaths.normalizeWorkspaceRoot(workspaceRoot, { createIfMissing })`
(`apps/server/src/workspace/WorkspacePaths.ts:161-233`). Its typed failures (`:18-79`) are
the complete validation surface:

`WorkspaceRootNotExistsError`, `WorkspaceRootCreateFailedError`,
`WorkspaceRootStatFailedError`, `WorkspaceRootNotDirectoryError`,
`WorkspacePathOutsideRootError`.

So the checks are: **path normalizes, exists (or is created when
`createWorkspaceRootIfMissing`), and is a directory.** There is **no git-repository check**
and no engine check at add-project time — `VERIFIED` by reading the normalizer and the
decider branch. A Unity project and an empty folder are equally acceptable.

**Duplicate guards live in the decider**, `apps/server/src/orchestration/decider.ts:230-241`:

```ts
case "project.create": {
  yield* requireProjectAbsent({ ..., projectId: command.projectId });
  yield* requireActiveProjectWorkspaceRootAbsent({
    ..., workspaceRoot: command.workspaceRoot, exceptProjectId: command.projectId });
```

**This is a load-bearing invariant for §7: one active workspace root maps to at most one
project.** So "per-project" and "per-workspace-root" are the same scope, and a lock keyed by
either is keyed by both.

Clients set `createWorkspaceRootIfMissing: true` —
`packages/client-runtime/src/operations/projects.ts:223` and
`apps/web/src/components/CommandPalette.tsx:1594`.

The project-card components, sidebar list, per-project settings surface, and all four
add-project entry points are in **§11**.

---

## 2. Existing engine detection — extend it

`VERIFIED`, read in full: `apps/server/src/project/EngineTypeResolver.ts` (297 lines).

**What it is.** An Effect service, tag `"t3/project/EngineTypeResolver"` (`:73-85`), with
one method: `detect(cwd: string) => Effect.Effect<EngineType | null>`. **It never fails** —
every I/O error degrades to "not this engine" after a logged warning (`:12-16`, `:87-95`).

**What it detects** (`:264-276`, priority order is deliberate and documented at `:247-263`):

| engine    | marker                                      | check                                            |
| --------- | ------------------------------------------- | ------------------------------------------------ |
| `godot`   | `project.godot`                             | stat, must be a File                             |
| `unity`   | `ProjectSettings/ProjectVersion.txt`        | stat, must be a File                             |
| `unreal`  | `*.uproject` in root                        | readDirectory + stat each candidate (`:171-202`) |
| `threejs` | `package.json` deps/devDeps contain `three` | parse, malformed JSON = no (`:115-130`)          |

The ordering comment is worth reading before touching it: a Unity project routinely ships a
`package.json`, so the three.js heuristic must run last or it would misclassify.

**When it runs.** On every project-snapshot read, via
`ProjectionSnapshotQuery.resolveEngineTypesForProjects` (`:381-411`).

**Where the result is stored.** Nowhere. It is recomputed, behind a cache:
`Cache.makeWith`, capacity **512**, TTL **1 minute**, keyed on the raw `cwd`
(`EngineTypeResolver.ts:48-49`, `:279-285`); failures get `Duration.zero` TTL so they are
not cached. The rationale at `:43-47` is explicit — without the cache "every redraw
[becomes] 2-4 raw filesystem syscalls per unique workspace root, forever."

**Is it suitable to extend? Yes, and it is the only sane option.** `VERIFIED` reasons:

- Its contract is already the right one for Unity status: cheap marker checks, never fails,
  cached, batched, resolved per `workspaceRoot`.
- Its output already reaches the client contract. `engineType` is on
  `OrchestrationProject` (`:224`) and `OrchestrationProjectShell` (`:455`).
- **It now has a live client consumer.** When I began this study a grep for `engineType`
  across `apps/web/src`, `apps/desktop`, and `apps/mobile` returned zero hits — the value
  was computed, batched, cached, put on the wire, and rendered by nothing. Commit
  `da0d5d247` landed the first consumer while I was working:

  | file                                                  | role                                                                                                                                                                                 |
  | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
  | ~~`apps/web/src/engineSelectorStore.ts`~~             | **DELETED in `c49beccb3`** — see the note below the table                                                                                                                            |
  | `apps/web/src/components/EngineToolbar.logic.ts`      | pure `resolveEngineToolbarView({engineType, connectedEditor})` at `:64-87` → `{engineType, isThreeJs, hasConnectedEditor, availableActions, playState}`; `isPlayEngaged` at `:94-96` |
  | `apps/web/src/components/EngineToolbar.tsx`           | the rendered toolbar                                                                                                                                                                 |
  | `apps/web/src/editorPresence/resolveProjectEditor.ts` | matches a connected editor to a project                                                                                                                                              |

  `engineSelectorStore.ts` was a localStorage-persisted zustand store whose
  `overrideByProjectKey` let a client-side choice beat detection. The owner ruled the engine
  is **detected, never chosen**, so the store and its dropdown went in one change — deleting
  only the UI would have stranded overrides that still won, with nothing left to correct
  them. `ChatView.tsx` now reads `activeProject?.engineType` directly.

  This **strengthens** the recommendation rather than weakening it: the consumer that would
  render a Unity status badge now exists, is per-project, and already joins detected
  `engineType` to live presence. A second detection system would have to duplicate that join.

**One caveat that is not a reason to replace it** (`VERIFIED`): the detector answers
"is this a Unity project", not "which Unity version" or "is our package installed". Those
are additional reads of `ProjectSettings/ProjectVersion.txt` and `Packages/manifest.json`
respectively. Adding them is a new sibling resolver in the same directory using the same
`Cache.makeWith` shape — not a redesign. `INFERRED`: because `EngineTypeResolver` caches
on a 1-minute TTL and a package install changes the answer instantly, a status resolver
should expose an explicit invalidation path rather than relying on TTL expiry alone (§8).

**What no code in this repo knows about Unity today** (`VERIFIED`, exhaustive grep across
`apps/` and `packages/` for `Packages/manifest`, `packages-lock.json`, `ProjectVersion.txt`,
`UnityLockfile`, `.meta`):

- `ProjectSettings/ProjectVersion.txt` — the detection marker, existence only. Never parsed.
- `Temp/UnityLockfile` — `apps/server/src/editorPresence/UnityColdStart.ts:43`.

Nothing reads `Packages/manifest.json` or `Packages/packages-lock.json`. Nothing is
`.meta`-aware. There is **no Unity Hub / editor-binary discovery anywhere** —
`UnityColdStart.buildUnityColdStartArgs(unityEditorPath, projectRoot)` takes the editor path
as a parameter, and its only callers are its own tests. That is a real gap for any
"install / launch / upgrade Unity" flow.

---

## 3. "Dependency missing → install button" — the precedent exists, and it is exact

**Correction to my own §0 summary above: this app _does_ model install-with-progress, and
the match is close enough to copy wholesale.** It is `cloud.installRelayClient` — the
cloudflared relay-client installer. `VERIFIED`, read end to end.

### 3.1 The state union

`packages/contracts/src/relayClient.ts:3-21` — `RelayClientStatusSchema`, a three-way union:

```ts
| { status: "available";   executablePath, source: "override"|"managed"|"path", version }
| { status: "missing";     version }
| { status: "unsupported"; platform, arch, version }
```

Note the third arm: "this platform can never have it" is a _distinct_ state from "not
installed yet", so the UI can decline to offer a button that would always fail. A Unity
status union wants the same third arm (e.g. "no Unity editor found on this machine").

### 3.2 Progress

`relayClient.ts:23-44` — seven ordered stages, and a two-arm event union:

```ts
RelayClientInstallProgressStageSchema = Literals([
  "checking", "waiting_for_lock", "downloading",
  "verifying", "installing", "validating", "activating",
])
RelayClientInstallProgressEventSchema = Union([
  { type: "progress"; stage },
  { type: "complete"; status: RelayClientStatusSchema },
])
```

### 3.3 Transport: a **streaming RPC**, not events and not polling

`packages/contracts/src/rpc.ts:385-397`:

```ts
WsCloudGetRelayClientStatusRpc = Rpc.make(WS_METHODS.cloudGetRelayClientStatus, {
  payload: {},
  success: RelayClientStatusSchema,
  error: EnvironmentAuthorizationError,
});

WsCloudInstallRelayClientRpc = Rpc.make(WS_METHODS.cloudInstallRelayClient, {
  payload: {},
  success: RelayClientInstallProgressEventSchema,
  error: Union([RelayClientInstallFailedError, EnvironmentAuthorizationError]),
  stream: true,
}); // ← :396
```

Read status with one RPC; run the install with a second whose success channel _is_ the
progress stream. Server handler at `apps/server/src/ws.ts:1548-1550`. Scope:
`AuthRelayWriteScope` (`apps/server/src/auth/RpcAuthorization.ts:52`).

### 3.4 Errors — typed reasons, not strings

`relayClient.ts:46-63`:

```ts
RelayClientInstallFailureReasonSchema = Literals([
  "download_failed", "invalid_checksum", "install_locked",
  "override_missing", "unsupported_platform", "validation_failed", "write_failed" ])
class RelayClientInstallFailedError extends TaggedErrorClass(...)({ reason, message })
```

Retryability is decided per reason by the caller, not encoded in the error.

### 3.5 The install engine, and its two locks

`packages/shared/src/relayClient.ts` (476 lines) — `RelayClient` Effect service (`:134`),
`makeCloudflaredRelayClient` (`:172`):

- **In-process lock:** `const installSemaphore = yield* Semaphore.make(1)` (`:188`), applied
  at `:462` — `installSemaphore.withPermit(installUnlocked(...))`.
- **Cross-process advisory lock file:** `acquireInstallLock(lockPath)` (`:328-353`).
  `writeFileString(lockPath, "", { flag: "wx" })` — exclusive create; on collision it stats
  the lock and **reclaims it if `mtime` is older than `INSTALL_LOCK_STALE_MS`**
  (`:340-346`); after `INSTALL_LOCK_RETRY_COUNT` attempts it fails with
  `reason: "install_locked"` (`:349-352`). `lockPath = ${managedPath}.lock` (`:376`).
  Cleanup is `Effect.ensuring(fileSystem.remove(lockPath, { force: true }))` (`:447`).
- Progress is a plain callback threaded into the install:
  `installUnlocked(report: (stage) => Effect<void>)` (`:355-356`), e.g.
  `yield* report("waiting_for_lock")` (`:382`).

### 3.6 Client orchestration

`apps/web/src/cloud/linkEnvironment.ts:73-116` — the exact sequence to copy:

1. read status; if `unsupported`, fail with a message naming platform+arch (`:75-79`)
2. **ask the user** — `requestRelayClientInstallConfirmation(status.version)` (`:81-88`)
3. `runStream(WS_METHODS.cloudInstallRelayClient, {})` with
   `Stream.tap(event => reportRelayClientInstallProgress(event))` (`:92-96`)
4. `Stream.runLast` + `Effect.ensuring(finishRelayClientInstall)` (`:98-102`)
5. **verify the effect, not the call** — assert the last event is `type: "complete"` and
   its `status.status === "available"`, else fail (`:103-115`)

### 3.7 Client state machine and UI

`apps/web/src/cloud/relayClientInstallDialog.ts` — a framework-free external store:

```ts
RelayClientInstallDialogState =
  | { status: "idle" }
  | { status: "confirming"; version }
  | { status: "installing"; version; stage }
  | { status: "closing";    view: <the confirming|installing state> }   // :22-39
```

with `readRelayClientInstallDialogState` / `subscribeRelayClientInstallDialog` (`:53-62`),
and a `RelayClientInstallConfirmationConflictError` (`:8-20`) that makes "a second install
requested while one is active" a typed failure rather than a race.

UI: `apps/web/src/components/cloud/RelayClientInstallDialog.tsx` (123 lines) —
`useSyncExternalStore` (`:2`, `:35`), a literal `installSteps` array mapping each stage to a
human label (`:25-31`, e.g. `waiting_for_lock` → "Waiting for installer"), and the current
step derived by `installSteps.findIndex(({stage}) => stage === view.stage)` (`:44`).

### 3.8 Verdict

**This is the pattern to follow for "Unity package missing → Install", and it is a direct
structural match**: a per-target status union with a "can never work here" arm, a
read RPC plus a streaming install RPC, typed failure reasons, an in-process semaphore plus
a stale-reclaiming advisory lock file, a confirmation gate, and a stage-labelled dialog.

Two adaptations `INFERRED` as necessary:

- Relay-client status is **per environment** (payload `{}`); Unity status is **per project**.
  Both RPCs need a `projectId` or `workspaceRoot` payload, and the lock must be keyed by
  workspace root rather than being a single module-level semaphore.
- `DEPENDS ON UNITY LANE` — the stage list must match what Unity's installer actually
  reports. If package installation is a single opaque call with no progress, the honest
  design is fewer stages, not fabricated ones.

**Runner-up precedents, in order:**

1. **Provider CLI update** — `ServerProviderVersionAdvisory` + `ServerProviderUpdateState`
   (§1.5.1). _Structurally_ the best match, because it is **per-target** exactly as Unity
   status is per-project, and it models the update as a job with
   `idle|queued|running|succeeded|failed|unchanged` plus captured `output`. Its weakness is
   **delivery**: it rides `server.getConfig`, a request/response RPC, so the client learns
   about a state change only when it re-reads. Take its _record shape_; take
   `cloud.installRelayClient`'s _streaming transport_.
2. **Desktop self-update** — `errorContext: "check" | "download" | "install" | null`
   (`packages/contracts/src/ipc.ts:203`, `:231`), `installUpdate()` (`:1017`). Electron-only,
   so it does not generalise to the web surface.
3. **Pinned-runtime install** — `apps/server/src/cloud/pinnedRuntime.ts` guards an npm
   install of a pinned `t3@version` with `Semaphore.makeUnsafe(1)` (`:23`) applied as
   `pinnedRuntimeInstallLock.withPermit(installPinnedRuntime(input))` (`:221-222`), under a
   10-minute timeout (`:20`). No client-facing progress at all.

**Not a precedent, despite looking like one:** the engine-credential pairing flow
(`docs/workbench/engine-credential-flow.md`,
`unity/com.ironmind.editor-presence/Editor/EditorPresenceSettings.cs`,
`EditorPresenceSettingsProvider.cs`) — _not-paired → paste token → Pair → connected /
rejected-with-verbatim-reason → Retry now_. It is a **credential** state machine: no
progress, no long-running job, and it runs inside the Unity Editor rather than DevGame's UI.

---

## 4. Provider and execution architecture

### 4.1 Providers

`VERIFIED`. Five built-in drivers, registered in
`apps/server/src/provider/builtInDrivers.ts:23-52`: `CodexDriver`, `ClaudeDriver`,
`CursorDriver`, `GrokDriver`, `OpenCodeDriver` (each in
`apps/server/src/provider/Drivers/`). The driver contract is
`apps/server/src/provider/ProviderDriver.ts` — `ProviderInstance` (`:64-74`) bundles
`instanceId`, `driverKind`, `continuationIdentity`, `enabled`, a `snapshot`
(`ServerProviderShape`, §1.5.1), an `adapter`, and a `textGeneration` service.

**Two transports, not one** (`VERIFIED` by module layout):
`packages/effect-acp/` implements the Agent Client Protocol (`agent.ts`, `client.ts`,
`protocol.ts`, `rpc.ts`, `terminal.ts`), used via `apps/server/src/provider/acp/` — which
contains Cursor- and Grok-specific support (`CursorAcpSupport.ts`, `GrokAcpSupport.ts`,
`CursorAcpCliProbe.ts`, `GrokAcpCliProbe.ts`) and `AcpSessionRuntime.ts`.
`packages/effect-codex-app-server/` is a separate protocol client for Codex.
So "both providers the same way" is **false** — Codex has its own app-server protocol.

Process spawning goes through `apps/server/src/processRunner.ts` —
`ProcessRunInput { command, args, cwd, spawnCwd, timeout, env, stdin, maxOutputBytes,
outputMode: "error"|"truncate", truncatedMarker, timeoutBehavior }` (`:19-34`), built on
`effect/unstable/process/ChildProcess` + `ChildProcessSpawner`.

### 4.2 Terminals

`VERIFIED`. Real PTYs, server-owned:
`apps/server/src/terminal/{PtyAdapter,NodePtyAdapter,BunPtyAdapter,Manager}.ts`, with the
wire contract at `packages/contracts/src/terminal.ts`. Two adapters because the server can
run under Node or Bun.

### 4.3 Approvals

`VERIFIED`. `packages/contracts/src/providerRuntime.ts:135-145` —
`CanonicalRequestType` is the normalized set every driver's native approval maps onto:

```
command_execution_approval, file_read_approval, file_change_approval,
apply_patch_approval, exec_command_approval, tool_user_input,
dynamic_tool_call, auth_tokens_refresh, unknown
```

Lifecycle events are `ProviderRuntimeApprovalRequestedEvent` /
`ProviderRuntimeApprovalResolvedEvent`, which are **aliases** of the generic
`ProviderRuntimeRequestOpenedEvent` / `ProviderRuntimeRequestResolvedEvent` (`:1031-1034`).
Policy lives on `ProviderApprovalPolicy = ["untrusted","on-failure","on-request","never"]`
and `ProviderSandboxMode = ["read-only","workspace-write","danger-full-access"]`
(`packages/contracts/src/orchestration.ts:38-50`).

Where the decision is **persisted** (`VERIFIED` by lane): client command
`ThreadApprovalRespondCommand { threadId, requestId, decision }`
(`orchestration.ts:828-835`) → domain event `thread.approval-response-requested`
(`ThreadApprovalResponseRequestedPayload`, `:1213-1218`), durable in the SQLite event log
through the same transaction/projection pipeline as everything else. Dispatch:
`ProviderCommandReactor.processApprovalResponseRequested` (`:1145-1166`, `:1298-1299`) →
`providerService.respondToRequest(...)` → per adapter (`ClaudeAdapter.ts:3852-3866` resolves
a `Deferred`; Codex answers the pending `item/commandExecution/requestApproval`; ACP answers
`session/request_permission`).

**There is no server-side allowlist table.** `"acceptForSession"`
(`ProviderApprovalDecision`, `orchestration.ts:135-141`) is delegated to each provider's own
session memory — ACP maps it to `"allow-always"`
(`apps/server/src/provider/acp/AcpAdapterSupport.ts:46-56`); Claude feeds
`updatedPermissions: pendingApproval.suggestions` into the SDK's `PermissionResult`
(`ClaudeAdapter.ts:3464-3473`). Broader "stop asking" comes from the per-thread
`RuntimeMode` — `approval-required | auto-accept-edits | auto | full-access`, **default
`full-access`** (`orchestration.ts:120-127`), translated per provider
(Codex at `CodexSessionRuntime.ts:265-296`).

### 4.4 Cancellation — the process is **not** killed

`VERIFIED`, and this materially constrains any long-running Unity operation.

`thread.turn.interrupt` (`packages/contracts/src/orchestration.ts:821`) →
`thread.turn-interrupt-requested` (`:1024`, `:1383`) → terminal state `"interrupted"`
(`:293`, `:355`, `:1485`). The reactor is
`ProviderCommandReactor.processTurnInterruptRequested`
(`apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:1122-1142`, `:1295-1296`)
→ `providerService.interruptTurn({threadId})`. What each adapter then does:

| provider            | on interrupt                                                                                                                 | process                 |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| Codex               | JSON-RPC `turn/interrupt` over the still-open app-server connection — `CodexSessionRuntime.ts:1330-1341`                     | stays alive             |
| Claude              | `context.query.interrupt()`, the SDK's own abort — `ClaudeAdapter.ts:3825-3833`                                              | stays alive (SDK-owned) |
| Cursor / Grok (ACP) | ACP `session/cancel` **notification**, plus local settling of pending approvals as `"cancel"` — `CursorAdapter.ts:1061-1073` | stays alive             |

OS-process death happens **only on `Scope` close** — session stop, instance rebuild, or the
idle sweep in `ProviderSessionReaper` — because `ChildProcessSpawner.spawn` is scoped to
`runtimeScope` (`CodexSessionRuntime.ts:753`, `AcpSessionRuntime.ts:346`) and Effect's
structured concurrency finalizer kills the child on scope teardown.

**Consequence for Unity:** "cancel" in this system means _ask the far side to stop_, not
_kill it_. A Unity operation that can be asked to stop (exit Play Mode) fits the existing
model. One that cannot — a `-batchmode` test run, a build — would need its own kill path,
because nothing in the turn-interrupt chain will terminate a process this system spawned
outside a provider scope.

### 4.4.1 Server vs desktop, and remoteness

`VERIFIED` by lane, and the repo states it as doctrine: "T3 has one runtime boundary…
Remoteness is expressed at the connection layer, never by splitting the runtime"
(`docs/internals/remote.md:10-14`); "every provider process, terminal, git operation, and
filesystem read happens there, never in the client" (`docs/internals/overview.md:5-8`).

The Electron app is strictly required only for: spawning the server as a local child
process (`apps/desktop/src/backend/DesktopBackendManager.ts:1-24`), Tailscale serve
exposure, SSH-managed remote launch (`apps/desktop/src/ssh/DesktopSshEnvironment.ts`), and
the WSL backend (`apps/desktop/src/wsl/DesktopWslBackend.ts`). **No PTY, no provider code,
no orchestration lives in `apps/desktop`.**

**This is the constraint that bounds the whole Unity design**: the Unity Editor must run on
the same machine as `apps/server`. Remote access is access-only — direct `wss://`,
Tailscale, the T3 Connect relay, or desktop-managed SSH — never compute offload. That
matches the limitation our own spec already flagged
(`docs/workbench/spec-editor-presence.md:152`).

### 4.5 Tool output → thread, every hop

`VERIFIED` by lane:

1. **Event** — `ProviderRuntimeEvent` with `type: "item.started" | "item.updated" |
"item.completed"` and `payload.itemType: ToolLifecycleItemType` —
   `packages/contracts/src/providerRuntime.ts:104-119`, `:148-197`.
2. **Reducer** — `runtimeEventToActivities()` at
   `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:310`, switch cases at
   `:617-681`, producing `OrchestrationThreadActivity { kind: "tool.started" |
"tool.updated" | "tool.completed", tone: "tool" }`. Runs inside a `DrainableWorker`
   (`:1804`).
3. **Dispatch** — internal command `thread.activity.append` via
   `orchestrationEngine.dispatch()` (`ProviderRuntimeIngestion.ts:1768-1781`).
4. **Persist** — decider → `thread.activity-appended` domain event, one SQL transaction
   with the projection write (`decider.ts` + `projector.ts`; see
   `docs/internals/overview.md:71-80`).
5. **Transport** — Effect RPC over WebSocket, streaming method
   `orchestration.subscribeThread` (`packages/contracts/src/orchestration.ts:35`), served at
   `apps/server/src/ws.ts:1253-1310` (initial snapshot plus a live `Stream` from
   `orchestrationEngine.streamDomainEvents`). **Not** SSE, and **not** `spaceEvents`.
6. **Client** — `packages/client-runtime/src/state/threads.ts:245` subscribes;
   `apps/web/src/session-logic.ts` folds activities into timeline rows (tool cases at
   `:633`, `:647`, `:753`, `:785-791`, `:850`, `:1328`).
7. **Component** — `apps/web/src/components/chat/MessagesTimeline.tsx`:
   `WorkGroupSection` (`:1158-1195`) → **`SimpleWorkEntryRow`** (`:1931`, the per-tool-call
   row), with `buildToolCallExpandedBody` (`:1855`).

### 4.6 The piece a Unity integration would actually plug into

`VERIFIED`, and this is the important part of §4:

**The in-app MCP server is the agent-facing seam, and it already exists.** `VERIFIED`:

- `apps/server/src/mcp/McpHttpServer.ts` — hosts an MCP server over HTTP with bearer auth
  (`invalid_mcp_credential`, `:26-38`), built on `effect/unstable/ai`'s `McpServer`,
  `Tool`, `Toolkit`.
- Exactly one toolkit exists: `apps/server/src/mcp/toolkits/preview/tools.ts` — 14 tools
  (`preview_status`, `preview_open`, `preview_navigate`, `preview_resize`,
  `preview_set_appearance`, `preview_snapshot`, `preview_click`, `preview_type`,
  `preview_press`, `preview_scroll`, `preview_evaluate`, `preview_wait_for`,
  `preview_recording_start`, `preview_recording_stop`).
- `apps/server/src/mcp/PreviewAutomationBroker.ts` — a request/response broker to a
  connected external host, with `connect` (returns a `Stream`), `focusHost`, `respond`, and
  `invoke<A>(request) => Effect<A, PreviewAutomationError>`. Built on `SynchronizedRef`,
  `Deferred`, `Queue`.

**`INFERRED` (high confidence): `PreviewAutomationBroker` and `EditorPresenceRegistry` are
the same pattern.** Both hold a set of connected external hosts, address one by id, send it
a request, and await a correlated reply with a timeout. A `unity` toolkit
(`unity_play`, `unity_stop`, `unity_screenshot`, `unity_run_tests`, `unity_console`) would
sit on `EditorPresenceRegistry.sendCommand` exactly as the preview toolkit sits on
`PreviewAutomationBroker.invoke`. That is the lowest-new-infrastructure way to make Unity
_agent-drivable_ rather than only _button-drivable_.

**A long-running, cancellable, progress-streaming Unity operation** would plug into that
MCP tool seam, not into the orchestration turn loop. `VERIFIED` that the existing
`EditorPresenceRegistry.sendCommand` is _not_ built for it — it has a hard
`COMMAND_TIMEOUT_MS = 10_000` (`EditorPresenceRegistry.ts:58`) and a per-session rate limit
of 5 commands / 2 s (`:50-51`), and "never queues: a `sessionId` with no current record
fails immediately with `editor_not_connected`" (`:236-239`). A 40-second Unity test run
needs either a raised bound for that action or a job-plus-poll shape.

---

## 5. Artifacts in a thread

### 5.1 `PreviewAnnotationPayload`, traced end to end

`VERIFIED` by lane. Fields — `packages/contracts/src/ipc.ts:866-877`:

```
id, pageUrl, pageTitle: string|null, comment,
elements: PreviewAnnotationElementTarget[]  (:788)
regions:  PreviewAnnotationRegionTarget[]   (:801)
strokes:  PreviewAnnotationStrokeTarget[]   (:812)
styleChanges: PreviewAnnotationStyleChange[] (:829)
screenshot: PreviewAnnotationScreenshot|null (:846) = {dataUrl, width, height, cropRect}
createdAt
```

The screenshot is an **inline base64 data URL**, not a file reference.

Hops:

1. **Producer** — `apps/desktop/src/preview/PickPreload.ts:1206` builds the annotation with
   `screenshot: null`, sends at `:1226` via `ipcRenderer.send(ELEMENT_PICKED_CHANNEL, …)`.
   This runs inside the Electron `<webview>` guest preload.
2. **Main-process capture** — `apps/desktop/src/preview/Manager.ts:1791` (`pickElement`),
   validated by `isPreviewAnnotationPayload` at `:1842`
   (`apps/desktop/src/preview/PickedElementPayload.ts:70`), screenshot merged at
   `:1848-1851` via `captureAnnotationScreenshot` (`Manager.ts:285-317`, which calls
   `wc.capturePage(cropRect)` → `.toDataURL()` at `:316`).
3. **Bridge** — `DesktopPreviewBridge.pickElement` (`ipc.ts:1063`), wired at
   `apps/desktop/src/ipc/methods/preview.ts:227-233`.
4. **Web** — `apps/web/src/components/preview/PreviewView.tsx:509` (`handlePickElement`):
   `addPreviewAnnotation(threadRef, annotation)` (`:528`),
   `previewAnnotationScreenshotFile(annotation)` (`:529`, impl
   `apps/web/src/lib/previewAnnotation.ts:102`, dataUrl → Blob → File),
   `addImage(threadRef, {...})` (`:531`) — pushing into the **same
   `ComposerImageAttachment` list a pasted image uses** (`composerDraftStore.ts:90`).
5. **Text** — `buildPreviewAnnotationPrompt` (`previewAnnotation.ts:21`) /
   `appendPreviewAnnotationPrompt` (`:61`) wrap the _metadata_ (not the image) in a
   `<preview_annotation>` block appended to the outgoing prompt.
6. **Send** — `ChatView.tsx:4750` (`turnAttachmentsPromise`), `dataUrl: await
readFileAsDataUrl(image.file)` at `:4756` → `UploadChatImageAttachment`
   (`orchestration.ts:169-178`).
7. **Persist** — `apps/server/src/orchestration/Normalizer.ts`: `parseBase64DataUrl` (`:111`),
   `createAttachmentId` (`:125`), `resolveAttachmentPath` (`:140`),
   `fileSystem.writeFile(attachmentPath, bytes)` (`:158`).
8. **Render back** — `MessagesTimeline.tsx` `UserTimelineRow` (`:871`), splitting
   `previewImages` / `regularImages` by `name.startsWith("preview-annotation-")` (`:893-894`),
   rendering at `:902`; the text block is stripped by `extractTrailingPreviewAnnotation`
   (called at `:883`).

**The structural point:** the annotation flow has **no bespoke storage or serving path**. It
reuses the ordinary composer-image → attachment pipeline entirely. Only the capture
(`wc.capturePage`) and the metadata-to-text serialisation are annotation-specific.

### 5.2 Attachment store

`VERIFIED` by lane:

- Path safety — `apps/server/src/attachmentPaths.ts:4` `normalizeAttachmentRelativePath`
  (rejects `..` and `\0`), `:12` `resolveAttachmentRelativePath` (joins to root, re-verifies
  the prefix).
- IDs and layout — `apps/server/src/attachmentStore.ts:37` `createAttachmentId(threadId)` →
  `${safeThreadSegment}-${randomUUID()}`; `:57` `attachmentRelativePath`; `:69`
  `resolveAttachmentPath`; `:79` `resolveAttachmentPathById` (probes
  `SAFE_IMAGE_FILE_EXTENSIONS`).
- URL minting — `apps/server/src/assets/AssetAccess.ts:169` `issueAssetUrl`, `"attachment"`
  case at `:259-276`; signs `{version:1, kind:"attachment", attachmentId, expiresAt}` and
  returns `relativeUrl: "${ASSET_ROUTE_PREFIX}/${token}/${fileName}"` with
  `ASSET_ROUTE_PREFIX = "/api/assets"` (`:45`).
- Serving — `GET /api/assets/*` at `apps/server/src/http.ts:250` (`assetRouteLayer`) →
  `resolveAsset` (`AssetAccess.ts:385`), verifies the HMAC over the claims and
  **re-derives the path server-side rather than trusting client input**, streams via
  `HttpServerResponse.file` with `Cache-Control: private, max-age=3600` and
  `X-Content-Type-Options: nosniff`.
- Limits — `orchestration.ts:146-148`: `PROVIDER_SEND_TURN_MAX_ATTACHMENTS = 8`,
  `PROVIDER_SEND_TURN_MAX_IMAGE_BYTES = 10 * 1024 * 1024`,
  `PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_CHARS = 14_000_000`; `UploadChatImageAttachment`
  (`:169`) constrains `mimeType` to `/^image\//i`.
- MIME — `apps/server/src/imageMime.ts:3` `IMAGE_EXTENSION_BY_MIME_TYPE`, `:17`
  `SAFE_IMAGE_FILE_EXTENSIONS`, `:53` `parseBase64DataUrl` (hand-rolled, non-regex — the
  comment notes a regex over a multi-MB payload risks blowing V8's call stack), `:115`
  `inferImageExtension`.

### 5.3 Composer paste / drag-drop

`VERIFIED`: `ComposerImageAttachment` (`composerDraftStore.ts:90`), store actions
`addImage` / `addImages` (`:446-447`). `apps/web/src/components/composerInlineTokenPaste.ts:29`
returns `false` from the Lexical `PASTE_COMMAND` handler when
`event.clipboardData.files.length > 0`, deferring to a generic `onPaste` prop
(`ComposerPromptEditor.tsx:899`).

`INFERRED / open`: the lane could not locate the consumer wiring `onPaste` to
`addImage`, nor any import site for `apps/web/src/lib/imageCompression.ts` outside its own
test — despite that module's header (`:1-11`) describing itself as backing oversized pasted
images. Flagged as unresolved, not asserted as dead code.

### 5.4 Images from an agent

`VERIFIED` by lane, at the protocol level:
`packages/effect-acp/src/_generated/schema.gen.ts:1462` declares the `ContentBlock` union
with an `image` variant at `:1470-1477` (`{type:"image", data, mimeType, uri?}`), runtime
schema at `:1518-1532`; `ToolCallContent` at `:1598`, whose doc comment at `:1807` says
tool calls "can produce different types of content including standard content blocks (text,
images) or file diffs"; standalone `ImageContent` at `:6417-6438`.

**But the direction is one-way in practice.** The adapters construct `{type:"image", …}`
blocks only **outbound** (user attachment → model): `ClaudeAdapter.ts:920`,
`CursorAdapter.ts:963-992`, `GrokAdapter.ts:981-987`. The lane found **no code consuming an
inbound `image` ContentBlock** from an assistant or tool-call event into a `ChatAttachment`.
Combined with §5.5's `AssistantTimelineRow` gap, agent-initiated images are
**protocol-capable but not wired end to end**.

### 5.5 What I verified first-hand

**An agent can already receive a PNG.** `packages/contracts/src/previewAutomation.ts:535-551`:

```ts
PreviewAutomationSnapshot = Schema.Struct({
  url,
  title,
  loading,
  visibleText,
  interactiveElements,
  accessibilityTree,
  consoleEntries,
  networkEntries,
  actionTimeline,
  screenshot: Schema.Struct({
    mimeType: Schema.Literal("image/png"),
    data: Schema.String, // base64
    width: Schema.Int,
    height: Schema.Int,
  }),
});
```

Returned by `PreviewSnapshotTool` (`apps/server/src/mcp/toolkits/preview/tools.ts`,
`preview_snapshot`). So "a tool result carrying an image" is a shipped path, not new.

**Recorded artifacts have a file-path shape too.** `previewAutomation.ts:561-569`:
`PreviewAutomationRecordingArtifact { id, tabId, path, mimeType, sizeBytes, createdAt }` —
`preview_recording_stop` "save[s] it as a local evidence artifact".

**Any file inside the workspace can already become a URL.** `packages/contracts/src/assets.ts:7-18`:

```ts
AssetResource = Union([
  TaggedStruct("workspace-file", { threadId, path }),
  TaggedStruct("attachment", { attachmentId }),
  TaggedStruct("project-favicon", { cwd }),
]);
AssetCreateUrlResult = { relativeUrl, expiresAt };
```

**Lowest-new-infrastructure path for a Unity Game View screenshot** (`INFERRED`, grounded
in the above): the Unity plugin writes a PNG into the project tree, the server exposes it
via `AssetResource.workspace-file` or returns it base64 in a `unity_snapshot` MCP tool
result exactly as `preview_snapshot` does. No new storage, no new route, no contract change
beyond the new tool's own success schema.

**Two caveats, both `VERIFIED`, and the second is a real defect:**

1. `ChatAttachment = Schema.Union([ChatImageAttachment])`
   (`packages/contracts/src/orchestration.ts:180`) — message attachments are images only.
   A PNG fits; a `.unity` scene file or a log file would not.

2. **An image can reach the _agent_, but an assistant message cannot show one to the
   _user_.** `OrchestrationMessage.attachments` exists on the contract for every role
   (`orchestration.ts:255-265`), and `UserTimelineRow` renders it
   (`apps/web/src/components/chat/MessagesTimeline.tsx:873` `row.message.attachments ?? []`,
   rendered at `:902`). But `AssistantTimelineRow` (`:1025-1040`) reads only
   `row.message.text` and **never touches `row.message.attachments`** — the sole other
   reference in the file is a prop type on `UserMessagePreviewAnnotationCard` (`:1355`).
   So "server produces a PNG → it appears inline in the transcript as an assistant image"
   is **not** wired today. This is tracked as task #67.

   Distinguish carefully: a Unity screenshot returned in an **MCP tool result** (the
   `preview_snapshot` path) reaches the model regardless — that path does not go through
   `AssistantTimelineRow`. Only the "assistant message with an image attachment" rendering
   is missing. For a Unity integration whose goal is _the agent can see the game_, the tool-
   result path is sufficient and already works. For _the user can see what the agent saw_,
   `AssistantTimelineRow` needs the same few lines `UserTimelineRow` already has.

---

## 6. Checkpoints, diffs, reverts on a Unity project

`VERIFIED` — this has already been measured in this repo and ruled on by the owner.
Source: `docs/workbench/checkpoint-cost-measured.md`.

**Mechanism.** `apps/server/src/git/GitVcsDriver.ts:650-730` against an isolated
`GIT_INDEX_FILE`: `rev-parse` ×2, `read-tree HEAD`, `git add -A -- .`, `write-tree`,
`commit-tree`, `update-ref`. Triggers are in the orchestration layer, not the driver:
`apps/server/src/orchestration/Layers/CheckpointReactor.ts` at `:355`, `:428`, `:482`,
`:629` — roughly **two captures per turn** (a baseline at turn start, a real capture at
completion). A checkpoint is "a hidden git ref" (`AGENTS.md`).

**Root cause of cost.** `read-tree HEAD` populates the fresh temp index with zeroed stat
metadata, defeating git's mtime/size shortcut, so `add -A` re-hashes every tracked file
every time. Isolated: same index, no changes — **1.56 s then 0.01 s, 156×**.

**Measured** (M4 Max, NVMe): 224 MB → 0.36 s; 1.0 GB → 1.53 s; 2.0 GB → 3.09 s;
3.0 GB → 4.64 s. Linear at ~665 MB/s. **`VcsProcess.ts DEFAULT_TIMEOUT_MS = 30_000`** with
no checkpoint override, so past roughly 15–18 GB tracked a single `add -A` crosses it and
capture **hard-fails** as `checkpoint.capture.failed`. There is a cliff, not just a slope.

**`.gitignore` is the lever that already exists.** Capture uses git's native ignore engine.
On a 1 GB-tracked / 578 MB-ignored repo: with `Library/` + `Temp/` ignored, 1.53 s; with
`.gitignore` moved aside, 11.6 s. Unity's standard template ignores both.

**Owner's ruling, already made:** measured against two real projects on the same build —
Deepmind 227 MB tracked (49,650 files, 71 GB on disk, 100 % LFS pointers) → 0.3–0.4 s;
Rising Tides 1.2 GB tracked (11,709 files, 15 GB on disk, LFS drifted) → 1.5–1.9 s. A 4–5×
difference from repository hygiene alone. **"No change to `GitVcsDriver.ts`. Tree confirmed
stock."** The real finding was LFS drift on Rising Tides (479 of 579 PNGs still full blobs;
TGA and HDR rules that have never matched a file; WAV and FBX not in the rule at all).

**Restore is already cheap and is not the problem.** `restoreCheckpoint` is O(changed
bytes) — reverting a 20-file/90 MB change on the 1 GB tree takes 0.3 s.

**Unrelated but real:** `DrainableWorker.ts` is a single **process-wide serial queue**. One
slow checkpoint on a large project blocks checkpoint processing — and the
`thread.turn.diff.complete` dispatch that carries the file-change summary — for every other
active thread on the server.

### 6.1 Diff output limits — silent truncation at 10 MB

`VERIFIED`, traced myself:

- `apps/server/src/vcs/GitVcsDriver.ts:272` — `CHECKPOINT_DIFF_MAX_OUTPUT_BYTES = 10_000_000`,
  applied to the checkpoint `git diff --patch` at `:805-820`.
- `apps/server/src/vcs/VcsProcess.ts:110` hardcodes `outputMode: "truncate"` for **every**
  git invocation, and `:111` sets `truncatedMarker: input.appendTruncationMarker ? "\n\n[truncated]" : ""`.
- `apps/server/src/processRunner.ts:197` — `outputMode === "truncate"` truncates;
  only `"error"` raises `ProcessOutputLimitError` (`:220`). Since `VcsProcess` never passes
  `"error"`, `VcsProcessOutputLimitError` is mapped (`VcsProcess.ts:119-125`) but
  unreachable from this path.
- **The checkpoint diff call at `:805-820` never sets `appendTruncationMarker`** — unlike
  `:475` and `:567`, which both pass `appendTruncationMarker: true`.

**Consequence (`INFERRED` from the above): a checkpoint/turn diff whose patch exceeds 10 MB
is silently truncated with no marker at all.** A single large `.unity` scene or `.prefab`
rewrite can plausibly reach that, and the Diff panel would render a patch that simply stops
mid-file with nothing saying why. That is arguably worse than a hard failure.

**Discrepancy — now resolved, and the truth is worse than either of us first said.** Task
#66 was originally titled "Turn diffs hard-fail (no truncation) on large Unity scenes". The
lane that filed it re-checked against my reading and **withdrew the hard-fail claim**; the
task has been retitled. Root cause of the original error, in its own words: two different
`execute`/`collectOutput` implementations. `GitVcsDriverCore.ts`'s `collectOutput`
(serving the `GitVcsDriver` tag — status/commit/push) **does** hard-fail on over-limit with
`appendTruncationMarker: false` (`GitVcsDriverCore.ts:657-663`). But `checkpoints.*` ops
live in `makeVcsDriverShape` in `GitVcsDriver.ts` (serving the **`VcsDriver`** tag) and
close over a different `execute` → `VcsProcess.run` → `processRunner.ts`, which truncates.

The corrected, jointly-verified finding:

- `apps/server/src/stream/collectUint8StreamText.ts:36-58` slices at the byte cap, sets
  `truncated: true` internally, and never fails; `:64` appends marker text only
  `if (state.truncated && truncatedMarker.length > 0)` — and the marker is `""` here.
- **`diffCheckpoints` (`GitVcsDriver.ts:773-834`) ends with `return result.stdout;`,
  discarding `result.stdoutTruncated` entirely.** `VcsCheckpointOps.diffCheckpoints`
  (`VcsDriver.ts:49`) is typed to return a bare `string`, so **the truncation flag has no
  channel to reach `CheckpointDiffQuery` or the web client even in principle.**
- The Diff panel's truncation banner exists but explicitly excludes turn diffs:
  `apps/web/src/components/DiffPanel.tsx:417` —
  `isSelectedPatchTruncated = !selectedTurn && selectedGitSource?.truncated === true`,
  banner at `:833-838`. It is fed by the _review/branch_ path, which does propagate
  `truncated` (`REVIEW_DIFF_PATCH_MAX_OUTPUT_BYTES = 120_000` at `GitVcsDriverCore.ts:47`,
  `REVIEW_UNTRACKED_DIFF_MAX_OUTPUT_BYTES = 80_000` at `:48`, both called with
  `appendTruncationMarker: true`) into `ReviewDiffPreviewSource.truncated`
  (`packages/contracts/src/review.ts:24`).

So: **a large Unity scene or prefab checkpoint diff is silently cut at exactly 10,000,000
bytes — no error, no marker, no banner, and no type through which the fact could travel.**
The user sees a patch that stops mid-hunk. `apps/web/src/lib/diffRendering.ts:109-144`'s
`getRenderablePatch` raw-text fallback (`kind: "raw"`, triggered when `parsePatchFiles`
throws or yields zero files) is the likely observable symptom.

### 6.2 Revert and `.meta` (task #65)

`VERIFIED` by the checkpoint lane: `checkpoints.restoreCheckpoint`,
`apps/server/src/vcs/GitVcsDriver.ts:737-771`, runs three commands:

```
:753  git restore --source <commitOid> --worktree --staged -- .   # overlay; deletes nothing
:758  git clean -fd -- .                                          # deletes untracked, non-ignored
:766  git reset --quiet -- .                                      # index cleanup, gated on hasHeadCommit (:761-768)
```

None has any asset/`.meta` pairing awareness — they reproduce whatever partial state the
checkpoint tree happened to capture. A checkpoint taken between an asset being written and
Unity generating its `.meta` (or the reverse) restores that split verbatim. The Unity-side
consequence (GUID divergence breaking every reference to the asset) is `INFERRED`, not
tested here.

### 6.3 Binary, renames, ignore rules

`VERIFIED` by the checkpoint lane:

- **Binary**: no diff path passes `--binary`; all pass `--no-textconv`
  (`GitVcsDriver.ts:814`, `GitVcsDriverCore.ts:2168`, `:2204`). So a project's configured
  Unity YAML textconv / smart-merge filter is **bypassed**, and true binaries fall through
  to git's `Binary files ... differ` placeholder. For a `.unity` scene forced to binary
  serialization, the diff is useless by construction.
- **Renames**: parsed by `@pierre/diffs`' `parsePatchFiles`, consumed at
  `apps/web/src/lib/diffRendering.ts:119-127`; `FileDiffMetadata.type` includes
  `"rename-pure"` / `"rename-changed"` (`:165-167`). T3 never passes `-M` /
  `--find-renames` itself — **rename detection depends on ambient git `diff.renames`
  config.** Asset moves are extremely common in Unity work.
- **Ignore rules**: no hardcoded ignore list anywhere. All ignore behaviour is git's native
  engine — `git add -A -- .` (`GitVcsDriver.ts:684-687`),
  `git ls-files --cached --others --exclude-standard -z` (`:463-470`),
  `git check-ignore --no-index -z --stdin` (`:561`). This is why `.gitignore` quality is
  the whole mitigation (§6).

**Nothing in the repo special-cases Unity paths for checkpoint or diff purposes**
(`VERIFIED` by grep — see §2).

---

## 7. Concurrency

**Unity enforces its own project-level lock, and the repo already models it.**
`apps/server/src/editorPresence/UnityColdStart.ts` — `Temp/UnityLockfile` "exists exactly
while an Editor instance already has that project open — Unity's own mechanism, not EPP's"
(`:5-8`). `probeUnityLockfilePresent` (`:109-117`) degrades any I/O failure to "cold", a
direction chosen deliberately (`:96-108`). `resolveUnityLaunchPlan` (`:87-94`) returns
`{kind:"warm"}` or `{kind:"cold", args}`. **Zero production callers** — only tests.

**What already serialises commands to one editor** (`VERIFIED`,
`apps/server/src/editorPresence/EditorPresenceRegistry.ts`):

- Publishers are keyed by their own `session.id`; a second connection claiming the same id
  **supersedes** the first, which is then closed (`registerPublisher`, `RegisterPublisherResult`
  `:156-163`).
- `EditorPresenceConnectionToken` (`:111`, doc `:96-110`) — an opaque per-connection symbol
  that guards every mutation _and_ every command resolution, so "a superseded connection can
  neither resolve a command addressed to its replacement nor have its own in-flight commands
  silently reassigned."
- Per-session rate limit: `COMMAND_RATE_LIMIT_MAX = 5` per `COMMAND_RATE_LIMIT_WINDOW_MS = 2000`
  (`:50-51`), tracked as `commandTimestamps` on the publisher record (`:117-120`).
- `COMMAND_TIMEOUT_MS = 10_000` (`:58`). `sendCommand` never queues (`:236-239`).

**So for _commands_, a project-level lock is close to redundant.** `INFERRED`: what exists
already serialises per connected editor session, which is nearly the same scope given
Unity's own lockfile allows one editor per project, and commands are bounded at 10 s each
so nothing can hold the editor long. Two things are genuinely missing: (a) a bound on
_long-running_ operations — none exist today, which is exactly why nothing needed a lock
yet — and (b) workspace scoping on the presence route itself. The route's own doc admits
the second:

> `EditorPresenceRoute.ts:47-49` — "any session with the right role-scope can see
> (subscriber) or publish as (publisher) presence for every workspace, not just its own."

That is tracked as task #60 (in progress) and is a prerequisite for treating presence as a
per-project authority.

### 7.1 What a lane established that changes the picture

`VERIFIED`:

- **Threads on one project share one directory by default.** `ThreadEnvMode =
Literals(["local","worktree"])` (`packages/contracts/src/settings.ts:141-142`), and
  `defaultThreadEnvMode` decodes to **`"local"`** (`:489-490`). Every git/checkpoint/turn
  cwd goes through `resolveThreadWorkspaceCwd`
  (`apps/server/src/checkpointing/Utils.ts:12-28`): use `thread.worktreePath` if set, else
  `project.workspaceRoot`. Worktree isolation is opt-in per thread
  (`apps/web/src/hooks/useHandleNewThread.ts:247-258`), and
  `projection_threads.worktree_path` (`005_Projections.ts:27`) carries no constraint —
  `decider.ts:409-453` stores it verbatim. Several threads sharing one worktree path is an
  explicitly handled case (`apps/web/src/worktreeCleanup.ts:11-33`).
- **Two turns for the same project can run concurrently.** `OrchestrationEngine.ts:97` has
  one `Queue.unbounded<CommandEnvelope>`, drained by a single worker fiber
  (`:310-311`) — but that serialises **event persistence only**, not turn execution
  (`:319-328` offers and awaits a `Deferred`). `decider.ts:838-909` (`thread.turn.start`)
  checks only that the thread exists and a cross-project plan guard; there is **no
  `requireNoActiveTurn`**. `ProviderCommandReactor.ts` has zero `Semaphore`/
  `SynchronizedRef` hits; its `activeTurnId` bookkeeping guards re-starting the _same_
  thread, not sibling threads.
- **The server is a single process.** `serverRuntimeState.ts` writes
  `{pid,host,port,origin,startedAt}` for CLI discovery only (read at `cli/pair.ts:278`,
  `cli/connect.ts:288`, `cli/project.ts:352`) — it is **not** an instance guard, and there
  is no EADDRINUSE/"already running" check. No `node:cluster` or `worker_threads` anywhere.
  `serverActivation.ts` (26 lines) is a readiness barrier, not a lock.
- **`restoreCheckpoint` runs completely unlocked against the live working tree.**
  `GitVcsDriver.ts:737-771` issues `git restore --worktree --staged -- .`,
  `git clean -fd -- .`, `git reset -- .` directly at `input.cwd` with **no
  `GIT_INDEX_FILE` isolation** — unlike `captureCheckpoint` (`:650-730`), which at least
  uses an isolated temp index. Combined with the shared-workspace default above, that is a
  live unguarded race between a revert and any concurrent turn or editor write.
- **No per-repo git serialisation exists at all.** `GitVcsDriverCore.ts` (2,927 lines)
  contains exactly two `Semaphore` hits — `deltaMutex` at `:554-555`, guarding a Trace2
  log tail-read _inside one `execute()` call_. Concurrent git commands on the same cwd
  from two threads are not serialised.

### 7.2 Lock-shaped things that already exist

`VERIFIED`:

| where                                                                          | primitive                                                                                                                                                                                                              | guards                                                                          |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `apps/server/src/terminal/Manager.ts:1213`, `:1242-1264`                       | `SynchronizedRef<Map<string, Semaphore>>`, lazily `Semaphore.make(1)` per key; `withThreadLock(threadId, effect)`                                                                                                      | terminal mutations, **per thread** — the repo's existing keyed-lock-map pattern |
| `apps/server/src/provider/providerMaintenanceCommandCoordinator.ts` (81 lines) | `Ref<Set<string>>` fail-fast on `targetKey` (`:17`, `:20-29`) **plus** `Ref<Map<string, Semaphore>>` serialise on `lockKey` (`:18`, `:38-54`); composed in `withCommandLock` (`:56-75`), released in `Effect.ensuring` | provider install/update, used at `providerMaintenanceRunner.ts:210`, `:402`     |
| `packages/shared/src/relayClient.ts:188`, applied `:462`                       | `Semaphore.make(1)` + `withPermit`                                                                                                                                                                                     | relay-client install, in-process                                                |
| `packages/shared/src/relayClient.ts:328-353`                                   | advisory lock **file**, `flag: "wx"`, stale-reclaimed by `mtime`                                                                                                                                                       | relay-client install, cross-process                                             |
| `apps/server/src/cloud/pinnedRuntime.ts:23`, `:221-222`                        | `Semaphore.makeUnsafe(1)` — single module-level permit                                                                                                                                                                 | pinned-runtime npm install                                                      |
| `apps/server/src/editorPresence/EditorPresenceRegistry.ts:111`                 | connection **token** (opaque symbol)                                                                                                                                                                                   | stale-connection clobbering                                                     |
| `apps/server/src/editorPresence/EditorPresenceRegistry.ts:50-51`               | timestamp window                                                                                                                                                                                                       | command rate, per session                                                       |
| `packages/shared/src/KeyedCoalescingWorker.ts`                                 | `TxQueue` + `TxRef`, coalescing not queueing                                                                                                                                                                           | keyed single-flight — a different shape, not an acquire/hold lock               |
| Unity itself, probed at `UnityColdStart.ts:43`                                 | `Temp/UnityLockfile`                                                                                                                                                                                                   | one editor per project                                                          |

Also `BackgroundPolicy.ts:216`, `makeManagedServerProvider.ts:50`,
`ProviderRegistry.ts:305`, `CliTokenManager.ts:339`, `NodeSqliteClient.ts:264-267`.

### 7.3 Recommendation

**Copy `providerMaintenanceCommandCoordinator.ts`, not the relay client's semaphore.** It is
the only existing primitive with the semantics a Unity drive-lock actually wants:
**keyed** (so projects do not serialise against each other) and **fail-fast** (so a second
agent gets an immediate "another agent is driving Unity" rather than silently queueing
behind a 40-second test run — queueing is the wrong answer for an interactive editor, per
the same reasoning `EditorPresenceRegistry.sendCommand` already uses when it refuses to
queue commands). `terminal/Manager.ts:1213`'s keyed map is the fallback if wait-your-turn
turns out to be preferable for some action.

Key it by **`workspace.root`**, which §1.6 established is 1:1 with a project
(`requireActiveProjectWorkspaceRootAbsent`).

**In-memory is sufficient — do not add a lock file.** The server is single-process
(§7.1); `EditorPresenceRegistry` is already in-memory-only by design
(`docs/workbench/spec-editor-presence.md:97` — "Nothing on disk"); a restart already drops
every editor connection and every in-flight turn, so a lock resetting with it loses
nothing. The relay client needed a lock _file_ only because a separate CLI **process**
could race it. Unity's own `Temp/UnityLockfile` already covers the cross-process case.

**The bigger concurrency finding is not about Unity at all.** Given the shared-workspace
default and the unlocked `restoreCheckpoint`, the sharpest hazard for a game project is a
checkpoint revert running `git clean -fd` on a directory a Unity editor has open and is
actively regenerating. That is worth a separate look regardless of what the Unity
integration does.

---

## 8. Live status refresh

**Recommendation, revised after the lane report: add a `stream: true` RPC modelled on
`VcsStatusBroadcaster`. Do not extend `/space-events`, and do not build a transport.**

I initially recommended `/space-events` on the belief that the RPC layer was
request/response only and that the two raw WebSocket routes were the sole push channels.
**That was wrong**, and the correction changes the answer.

### 8.1 The RPC layer already does server push

`VERIFIED` by the live-push lane: `Rpc.make(WS_METHODS.x, { ..., stream: true })` is a
first-class subscription shape living inside the same `WsRpcGroup` / `WS_METHODS`
machinery as unary RPCs — so it inherits `RPC_REQUIRED_SCOPES`' compile-time scope check,
which the raw routes explicitly do **not**
(`apps/server/src/auth/RpcAuthorization.ts:103`; see the risk noted in
`docs/workbench/spec-editor-presence.md:153`). Existing examples in
`packages/contracts/src/rpc.ts`: `WsSubscribeVcsStatusRpc` (`:486-491`),
`WsSubscribeServerConfigRpc` (`:751-756`), `WsSubscribeServerLifecycleRpc` (`:758-763`),
`WsSubscribeTerminalMetadataRpc` (`:744-749`), `WsSubscribeAuthAccessRpc` (`:765-770`),
`WsTerminalAttachRpc` (`:575-580`), `WsPreviewAutomationConnectRpc` (`:647-652`).

Client side: no TanStack Query anywhere (grep: zero hits) — it is `@effect/atom-react`,
registry at `apps/web/src/rpc/atomRegistry.ts:5`. The two families in
`packages/client-runtime/src/state/runtime.ts` are
`createEnvironmentRpcQueryAtomFamily` (`:593-612`, SWR with an optional
`refreshIntervalMs` → `Atom.withRefresh` at `:528-531` — **no caller passes it today**) and
`createEnvironmentRpcSubscriptionAtomFamily` (`:614-644`), which folds a `stream: true` RPC
into a live atom via `followStreamInEnvironment` (`:469-478`). Worked example:
`packages/client-runtime/src/state/vcs.ts:273-285` subscribes `subscribeVcsStatus` and folds
events with `Stream.mapAccum` + `applyGitStatusStreamEvent`.

### 8.2 The precedent that fits Unity status almost exactly

`VERIFIED`: `apps/server/src/vcs/VcsStatusBroadcaster.ts` is a **demand-gated poll loop that
publishes as a push**:

- forked only while at least one subscriber exists — `retainRemotePoller` /
  `releaseRemotePoller` (`:465-554`)
- `DEFAULT_VCS_STATUS_REFRESH_INTERVAL = Duration.seconds(30)` (`:28`)
- exponential backoff on failure, 30 s base → 15 min cap (`:142-154`)
- **publishes to its `PubSub<VcsStatusChange>` only when a fingerprint changes**
  (`:203-303`)
- backs `WS_METHODS.subscribeVcsStatus`

That is the shape for a value derived from the filesystem that changes rarely: nobody pays
when nobody is looking, the client gets a push rather than a poll, and unchanged states
cost zero frames. A Unity-status broadcaster is the same module with a different probe.

### 8.3 Why not a filesystem watcher

`VERIFIED`: watching exists, but only for two config files. No `chokidar` anywhere; it is
Effect Platform `FileSystem.watch` at `apps/server/src/serverSettings.ts:511-548` and
`apps/server/src/keybindings.ts:572-619`, both **debounced 100 ms** with an explicit comment
(`serverSettings.ts:529-531`) that editors emit several events per save and `fs.watch` can
fire before content is flushed. (`GitVcsDriverCore.ts:585` watches a git trace file,
unrelated.) **Nothing watches project or engine files** — not `Packages/manifest.json`, not
`ProjectSettings/`, not `.uproject`, not `project.godot`.

Adding a watcher on a Unity project tree is the option I would avoid: `Library/` churns
constantly while the editor runs, which is exactly the noise the 100 ms debounce exists to
suppress at a far smaller scale.

### 8.4 The remaining case for the raw routes

`VERIFIED` findings that still stand:

- **The main live-push channel will not carry it.** `apps/server/src/ws.ts:539-571`
  `toShellStreamEvent` re-reads a project snapshot only on `project.created`,
  `project.meta-updated`, `project.deleted`; every other non-thread aggregate event falls
  through to `Option.none()` (`:566-568`). Since a Unity status change produces **no
  orchestration event at all** (it is a filesystem change), attaching status to
  `OrchestrationProject` gives you _correct-on-read_ but _stale-until-something-else-happens_.
- **A per-project push route already exists, and it is entirely ours.**
  `apps/server/src/spaceEvents/SpaceEventsRoute.ts` — `GET /space-events?projectId=<ProjectId>`,
  raw WebSocket, subscribe-only, per-project fan-out via `SpaceEventsRegistry.ts`,
  **level-style** frames (`protocol.ts:29 buildSpacesFrame` — "every broadcast carries the
  _complete_ current set", `:4-12`). Its doc (`:15-30`) explains why it lives outside
  `WsRpcGroup`/`WS_METHODS`: no new RPC method, no `packages/contracts` change, no `ws.ts`
  edit. It is the smallest possible addition that avoids editing vendor files — which is
  exactly the fork's stated rule (`docs/workbench/upstream-strategy.md`).
- **A second push channel already carries editor liveness.** `GET /editor-presence?role=subscriber`
  fans out `EditorPresenceEntry` including `capabilities` and `playState`
  (`apps/server/src/editorPresence/protocol.ts:172-190`) — but it is **global, not
  project-scoped** (see §7's task-#60 note).

### 8.5 The call

**On-disk Unity status → a new `stream: true` RPC** (`unity.subscribeStatus` or a project
-scoped `subscribeProjectStatus`), server side modelled on `VcsStatusBroadcaster`:
demand-gated, fingerprint-diffed, backing off on failure. Client side, one
`createEnvironmentRpcSubscriptionAtomFamily` entry, exactly as
`state/vcs.ts:273-285` does for git status.

Three reasons this beats extending `/space-events`, all `VERIFIED`:

1. It inherits the **compile-time scope check** in `RPC_REQUIRED_SCOPES`
   (`RpcAuthorization.ts:103`). The raw routes escape it — a documented risk in our own spec
   (`spec-editor-presence.md:153`) and the direct cause of the security gap tracked as
   task #60.
2. `VcsStatusBroadcaster` already solves the hard part (probe cheaply, publish only on
   change, never run with no subscribers). `/space-events` broadcasts on a domain event; a
   filesystem-derived value has no domain event to hang off.
3. The client fold pattern already exists and is in production use for git status.

The counter-argument, stated fairly: a new `WS_METHODS` entry touches
`packages/contracts` and `ws.ts`, which the fork's own strategy
(`docs/workbench/upstream-strategy.md`) says to minimise, and which is precisely why
`SpaceEventsRoute.ts:15-30` chose a raw route. That is a real cost — one enum entry plus one
handler. I judge it worth paying here because the alternative deliberately opts out of the
authorization type-check on a surface that will gate driving someone's editor. If the owner
weighs upstream-mergeability higher, `/space-events` remains a working second choice and
the rest of this section stands unchanged.

**Editor liveness stays where it already is** — `/editor-presence` already pushes
`capabilities` and `playState` per connected editor
(`apps/server/src/editorPresence/protocol.ts:172-190`). Do not duplicate it. Its real gap
is workspace scoping (task #60), not transport.

**Runner-up for the on-disk half:** `refreshIntervalMs` on
`createEnvironmentRpcQueryAtomFamily` (`runtime.ts:593-612`, `:528-531`) — the parameter
exists and **no caller uses it today**. Cheapest to write, worst to live with: stacked on
`EngineTypeResolver`'s 1-minute cache TTL, a user who just clicked Install could wait two
minutes to see it land.

**No new transport is needed either way.** `VERIFIED` — `stream: true` RPCs, two raw
upgrade routes, and `HttpServerRequest.upgrade` are all first-class here.

---

## 9. The plugin-overlap verdict — SUPERSEDED, see §9.0

### 9.0 Decision taken: the plugin was deleted

`VERIFIED`. Commit **`33d6cc4d8` "Delete our Unity plugin — Unity is served by
com.unity.pipeline"** landed after I wrote §9.1–§9.6. `unity/` now contains only
`README.md`; all 1,633 lines of C# are gone. `apps/server/src/unity/UnityPipelineClient.ts`
is the replacement.

**My "load-bearing" verdict is superseded by evidence I did not have.** §9.4 listed three
preconditions only the Unity lane could settle, and their live round-trip against a real
6000.3.14f1 Editor settled them. The decision is the owner's and it is made. §9.1–§9.6 are
left below unedited as the record of what was traded away, not as a live recommendation.

**Three facts I had wrong or lacked**, from the team lead's own verification:

1. **Pipeline is now the better-verified side.** A full round trip against a real running
   Editor — `playMode: stopped → editor_play → playing → editor_stop → stopped`, read back
   from editor state — plus a real 1280×720 Game View capture. §9.3 leaned on
   `unity-verified.md` being the only Unity code proven against a real editor. It no longer
   is, and the newer evidence is stronger: actual state transitions, not close codes.
2. **Our plugin was never installed in the owner's real project.** Zero `ironmind` entries in
   `~/Projects/Deepmind/Packages/manifest.json`; `com.unity.pipeline 0.4.0-exp.1` is there.
   Every claim I made about our plugin's capabilities was about code installed nowhere the
   owner actually works.
3. **The NAT / remote-Editor argument was never load-bearing.** Our plugin defaults to
   `127.0.0.1:3777`. I repeated that justification from
   `UnityPipelineClient.ts:12` without checking the default. Combined with §4.4.1's
   same-machine constraint, it never bought anything.

### 9.0.0 The resolved direction: a server-side publisher

The team lead's synthesis, which is better than the middle path I proposed and supersedes
it. My §9.4 suggested re-implementing our publisher as a thin adapter **inside the Editor**.
Correct instinct, wrong location — an in-Editor adapter still means the user installs two
packages, which is the exact onboarding cost the whole exercise exists to remove.

**Put the adapter server-side.** The server calls Pipeline and publishes into the _same_
`EditorPresenceRegistry` that Godot and Unreal publish into. That satisfies the uniformity
requirement of §9.2 — registry, chip row, capability table and toolbar all unchanged —
while maintaining zero Unity C# and keeping one package for the user.

**Sequencing, per the owner's call:** not immediately. Tonight Unity's Play is a direct
server-side CLI call — simple, proven, shippable. The registry unification is the recorded
direction, not the current task. Ship the working button; unify deliberately.

### 9.0.0.1 One trap the unification must avoid

`VERIFIED` against the registry, and worth knowing before the work starts, because it fails
in exactly the way this repo has been bitten twice.

`registerPublisher(sessionId, connectionToken, hello, close = noopClose, send = noopSend)`
(`EditorPresenceRegistry.ts:317-318`; `noopSend` at `:93`). Both handles are **optional and
default to no-ops** — which is right for a presence-only publisher and wrong for a
command-capable one.

A synthetic Unity publisher registered with the defaults would, on every Play press
(`sendCommand`, `:457-530`):

1. pass the record lookup and the 5-per-2s rate check (`:478-501`),
2. write the `command` frame to a no-op `send`,
3. block on a `Deferred` that only `resolveCommand` resolves — and `resolveCommand`
   (`:254-258`) is normally called by the route's read loop parsing an inbound
   `commandResult`, which a socketless publisher does not have,
4. hit `COMMAND_TIMEOUT_MS = 10_000` (`:58`) and return `{ ok: false, error: "timeout" }`.

**Every Play press: a ten-second hang, then a false failure.** That is verbatim the
"enabled Play button, a ten-second wait, and a timeout" outcome
`spec-editor-presence-commands.md:135` says the capability table exists to prevent.

So the server-side publisher must supply **both** halves explicitly:

- a real `send` that maps the command frame to `UnityPipelineClient.play` / `.stop` / `.pause`, and
- its own `resolveCommand(id, connectionToken, outcome)` call once Pipeline returns, since
  nothing else will.

One wrinkle worth designing around rather than discovering: `EditorPresencePublisherSend` is
`(frame: string) => Effect<void>` (`:91`) — a _wire_ contract. A non-wire publisher has to
serialize a frame via `buildCommandFrame` and immediately parse it back to learn the action
and id. Either accept that round-trip or widen the registry's publisher contract; both are
defensible, but it should be a decision rather than an accident.

The capability advertisement is the easy half: `registerPublisher`'s `hello.capabilities`
(`:194`) takes the array directly, so `UNITY_PIPELINE_CAPABILITIES = ["play","stop","pause"]`
(`UnityPipelineClient.ts:77`) flows straight through, and the toolbar's existing
capability filter then does the right thing without a special case.

**What the replacement provides** (`VERIFIED`, `UnityPipelineClient.ts`):
`isAvailable()` (`:208`), `status(workspaceRoot)` (`:209`), `play` / `stop` / `pause`
(`:214-216`); `UNITY_PIPELINE_CAPABILITIES = ["play","stop","pause"]` (`:77`);
`UnityEditorStatus { status, compiling, domainReloadInProgress, playMode, unityVersion }`
(`:82-91`).

### 9.0.1 Already handled — do not go fix these

I drafted three of these as gaps and was wrong on all three; the toolbar lane had already
solved them. Recording them so nobody is sent after a non-problem:

- **`step` removal is handled.** `EngineToolbar.logic.ts:78` —
  `UNITY_CLI_ACTIONS = ["play","pause","stop"]`, with a doc comment citing the live
  verification against `com.unity.pipeline 0.4.0-exp.1` and noting Pipeline has no scriptable
  step API.
- **Unity toolbar rendering is handled.** `EngineDispatchBackend =
"editor-presence" | "unity-cli" | "threejs-script"` (`:49`), `resolveEngineDispatchBackend`
  (`:58-68`, exhaustive switch, no `default`, so a fifth engine is a compile error).
  `hasConnectedEditor: false` is correct-by-design for `"unity-cli"`, not a bug (`:94-101`).
- **Scope gating is handled.** `requiresPresenceCommandScope` is per-backend (`:89-93`) —
  Unity and three.js are explicitly never disabled over `presence:command`.

### 9.0.2 Genuinely open

1. **`UnityPipelineClient` has no server wiring at all.** `VERIFIED`: grep for
   `UnityPipelineClient` outside its own file and tests returns nothing — no route, no RPC,
   no layer registration. `play` / `stop` / `pause` / `status` (`:209`, `:214-216`) have zero
   callers. This is the same "built and tested, not connected" pattern §9.6 found for
   `dispatchEditorCommand`, now reproduced on the Unity path.
2. **Play state is a pull where the design needs a level — and the toolbar is already
   waiting for it.** `resolveEngineToolbarView` takes `unityPlayState?: ... | null` whose own
   doc says it is `null` "until a server endpoint exists to query Unity CLI play state" and
   instructs callers not to guess `"stopped"`. `spec-unity-play-stop.md:56-78` ruled play
   state must be a level _because_ a domain reload kills the connection mid-command.
   Pipeline's `status(workspaceRoot)` is request/response, so something must convert pull
   back into push. **§8.2's `VcsStatusBroadcaster` is the fit** — demand-gated poll, publish
   only on fingerprint change. `UnityEditorStatus.domainReloadInProgress` (`:90`) and
   `.compiling` (`:88`) are better raw material for a correct "reloading, hold on" state than
   the old plugin had, but only if something reads them on a cadence.
3. **Selection is unimplemented** (task #68). The affected surface is wider than the chip:
   `editorSelectionContext.ts` serialises selection into the outgoing prompt and the pin store
   (`store.ts:72`) retains pinned items — both now have no Unity producer.
4. **`UNITY_COLD_START_EXECUTE_METHOD` is a dangling string.** `UnityColdStart.ts:51-52`
   still exports
   `"Ironmind.EditorPresence.EditorPresenceColdStartEntryPoint.EnterPlaymodeOnLaunch"`;
   grepping that class across every `*.cs` returns nothing. `buildUnityColdStartArgs` feeds it
   to `-executeMethod`, which Unity fails when it cannot resolve the method. Latent **only**
   because `UnityColdStart` still has zero production callers — a trap primed for whoever
   wires the cold path. Delete it or repoint it at Pipeline's launch path.
5. **A comment now asserts the opposite of the truth.** `UnityPipelineClient.ts:12` reads
   _"Editor Presence's C# plugin … is not deleted — it stays the answer for an Editor that
   can't reach this server directly (behind NAT, remote box)."_ It is deleted. That sentence
   also names a capability the deletion removed; §4.4.1's same-machine constraint blunts how
   much it mattered, but it deserves an explicit ruling rather than an inherited assumption.
6. **The frozen specs still describe the deleted package** — `spec-unity-play-stop.md:17`,
   `spec-editor-presence.md:115`, `:145`, `:165`. Both specs carry their own rule: _"if the
   code disagrees with this spec, correct the spec rather than diverging from it silently."_

**Cross-engine symmetry, as fact rather than argument:** Godot still speaks EPP including
commands (`epp_client.gd:278`, `:288`, `:324`) and Unreal's publisher is still in the tree.
Unity is now reached by a different mechanism — the cost §9.2 priced, now paid deliberately,
and absorbed cleanly by the backend split rather than leaking into the view logic.

---

## 9 (original). The plugin-overlap verdict

**Question: if Unity ships an official package that reports editor status, runs tests,
captures screenshots and drives Play Mode, is `unity/com.ironmind.editor-presence/`
redundant, complementary, or load-bearing?**

**Answer: load-bearing — and the reason has nothing to do with our plugin being better.**

### 9.1 What our plugin actually is

`VERIFIED` by reading all 11 `.cs` files (1,633 lines):

| does                                                         | file                                                                        |
| ------------------------------------------------------------ | --------------------------------------------------------------------------- |
| selection presence (GameObjects + Project assets)            | `EditorPresenceSelectionWatcher.cs`, `EditorPresenceItemBuilder.cs`         |
| play / stop / pause / step commands                          | `EditorPresenceCommandDispatcher.cs`, `EditorPresencePlayModeController.cs` |
| play-state reporting as a _level_                            | `EditorPresencePlayModeController.cs:54-61`                                 |
| connection status UI (Scene-view Overlay + Preferences page) | `EditorPresenceStatusOverlay.cs`, `EditorPresenceSettingsProvider.cs`       |
| bearer pairing redemption                                    | `EditorPresenceSettings.cs`                                                 |
| `-executeMethod` cold-start entry point                      | `EditorPresenceColdStartEntryPoint.cs`                                      |
| WebSocket + reconnect + domain-reload survival               | `EditorPresenceConnection.cs` (486 lines)                                   |

**Does not do** (`VERIFIED` — grep for `logMessageReceived`, `LogEntries`, `TestRunner`,
`ScreenCapture`, `CaptureScreenshot`, `RenderTexture`, `BuildPipeline`,
`UnityEditor.PackageManager` returns **nothing**): console/compile-error capture, test
running, screenshots, package installation, builds, any scene/prefab inspection richer than
a label. The spec is explicit that these are out of scope
(`docs/workbench/spec-editor-presence.md:99-109`).

So the overlap surface with a hypothetical official package is: **editor status and Play
Mode driving.** Tests, screenshots and console capture are things Unity might ship that we
**do not have** — those are pure gain, not duplication.

### 9.2 It is not one plugin; it is one third of a protocol

`VERIFIED` — three publishers implement the same wire protocol, and the server, registry,
web chip row and (in-progress) toolbar are all written against it, not against Unity:

| implementation                                              | lines (non-test) | commands?                                                                                        | live-verified                                |
| ----------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| Unity C# — `unity/com.ironmind.editor-presence/Editor/`     | 1,633            | play/stop/pause/**step**                                                                         | **yes** (§9.3)                               |
| Godot GDScript — `godot/addons/editor_presence/`            | 924              | yes — `epp_client.gd:278` `capabilities`, `:288` `commandResult`, `:324` `_handle_command_frame` | **yes** (Play/Stop live, commit `2ee856135`) |
| Unreal Python — `unreal/EditorPresence/Content/Python/epp/` | 2,298            | not yet (task #50)                                                                               | no (no Unreal on the machine)                |
| server — `apps/server/src/editorPresence/`                  | 1,749            | —                                                                                                | —                                            |
| web — `apps/web/src/editorPresence/`                        | 1,113            | —                                                                                                | —                                            |

Deleting the Unity publisher does not delete a Unity feature. It makes Unity the one engine
of three that does not speak the protocol the rest of the product is built on — so the chip
row, the capability table
(`docs/workbench/spec-editor-presence-commands.md:115-119`), the `playState` level, the
per-editor `capabilities` advertisement and the Play/Stop toolbar would each need a second,
Unity-shaped code path. `INFERRED`, but the capability table and the three-publisher
structure make it hard to see how it could be otherwise.

### 9.3 It is verified, which is rarer here than it sounds

`VERIFIED` — `docs/workbench/unity-verified.md`. Against a real Unity **6000.3.14f1** in
`-batchmode -executeMethod`, in a throwaway project:

- clean compile, zero `CS####` errors, four launches
- `Selection.selectionChanged` fires and _our watcher_ runs — proven by the `SessionState`
  sequence counter (written only by `EditorPresenceSelectionWatcher.PublishCurrentSelection`)
  going 1→2→3→4 across four real selections
- frames reach the server — an independent Node subscriber on a separate bearer token
  logged every `presence` frame, items byte-identical to what Unity produced
- `ClientWebSocket` works inside Mono — full connect/send/receive/close, repeatedly
- a **real 4401** was forced with a garbage token; `LastErrorMessage` came back exactly
  `invalid_credential`; `_credentialRejected` set; **zero** auto-retries over 5 s;
  `Retry()` reconnected in ~50 ms
- **the load-bearing claim confirmed:** a real domain reload via
  `EditorUtility.RequestScriptReload()` — sequence 3 before, 3 after; same `session.id`
  re-claimed its registry record, old entry removed first, no duplicate chip

Still unexercised, stated honestly in that doc: the unrecognised `>= 4000` close-code branch,
IMGUI/UI-Toolkit redraw behaviour, nested prefabs and the 64-item truncation path, a full
editor restart, and **the pixel** — nobody has confirmed the frame renders as a literal chip
in the browser composer.

### 9.4 The case for deleting it, made properly

I was asked for this, so here it is without hedging. Delete our Unity plugin if **all** of
the following turn out to be true:

1. `DEPENDS ON UNITY LANE` — the official package exposes a **subscribable** editor status
   (selection, play state) rather than request/response only. Our whole design rests on
   presence being a pushed _level_ (`spec-editor-presence.md:72`); a polling-only official
   API is a different product.
2. `DEPENDS ON UNITY LANE` — it survives a **domain reload** and republishes state on the
   far side. This is the single hazard that dominated our build
   (`spec-unity-play-stop.md:38-90`) and consumed most of `EditorPresenceConnection.cs`.
   Domain reload fires on every Play press and every script compile in the owner's own
   project (`EditorSettings.asset:27-28`, cited in `spec-editor-presence.md:17`).
3. `DEPENDS ON UNITY LANE` — its auth model can be pointed at a **local, user-owned server**
   with a bearer credential. Ours is a paired device
   (`docs/workbench/engine-credential-flow.md`). An official package that only talks to
   Unity's cloud is not a substitute.
4. Ours is the _only_ publisher — i.e. Godot and Unreal support is abandoned. If they stay,
   deleting the Unity publisher costs more than it saves (§9.2).

If (1)–(3) hold and (4) does not, the honest outcome is **not** deletion — it is
**re-implementing our Unity publisher as a thin adapter on top of the official package**:
keep the EPP frames, drop our WebSocket/reconnect/domain-reload code (the expensive
1,633 lines), and let Unity's package be the transport underneath. That preserves the
cross-engine protocol and deletes the part that was hardest to get right. `INFERRED`, and
it is the outcome I would bet on.

### 9.5 Where it is genuinely complementary

`DEPENDS ON UNITY LANE` for what the official package actually offers, but from our side
the gaps are unambiguous (`VERIFIED` absent, §9.1): **test running, screenshots, console/
compile-error capture, and package installation.** If Unity ships those, we should consume
them rather than build them — that is the owner's "integrate, don't own" rule applied
exactly. Console capture in particular is the highest-value missing piece for an _agent_:
today an agent driving Unity cannot see a compile error.

### 9.6 The immediate, doctrine-independent finding

Our own Unity work is **not finished**, regardless of what Unity ships. The gap narrowed
during this study, so here is the state at `686481084` (`VERIFIED`):

| piece                                                  | status at `686481084`                                                                                                          |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Unity warm-path Play/Stop in the plugin                | **shipped** (`686481084`, task #49)                                                                                            |
| `engineType` → client modules                          | **landed** (`da0d5d247`): store, pure view logic, component, editor-matching                                                   |
| `EngineToolbar` mounted in the app                     | **no** — grep finds no render site outside its own file and test                                                               |
| `onAction` → anything                                  | **no caller** (`EngineToolbar.tsx:123`, `:209` pass it down; nothing supplies it)                                              |
| `dispatchEditorCommand` (`EditorPresenceRoute.ts:437`) | still **zero production callers** — only doc comments in `protocol.ts:96` and `packages/contracts/src/auth.ts:87` reference it |
| `UnityColdStart.ts`                                    | still **zero production callers**                                                                                              |
| Unity editor-binary discovery                          | **does not exist** — `unityEditorPath` has no supplier, so the cold path cannot be invoked even once a caller is written       |

So the remaining gap is narrow and specific: **mount the toolbar, add an RPC that lets a
client reach `dispatchEditorCommand`, and find the Unity binary.** Everything either side
of those is built and tested. The wire protocol, the plugin, the registry, the scope, the
capability filtering and the pure view logic all exist; the button is not connected to the
socket.

Whatever the Unity lane reports, none of it removes those three gaps, and closing them is
cheaper than any alternative on the table.

---

## 10. Dependencies on the sibling Unity lane

Every recommendation above that is contingent, in one place:

| §   | what I need from them                                                                                                                                                                                     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2   | Does `com.unity.pipeline` (or the CLI) expose "is package X installed / at version Y" in a way cheaper than parsing `Packages/manifest.json` ourselves?                                                   |
| 3   | Is package installation scriptable headlessly (CLI or `UnityEditor.PackageManager.Client.Add`), and does it report progress? This decides whether an install button is a job with progress or a one-shot. |
| 4   | Can the official package run Test Runner and stream results? Long-running-operation shape depends on it.                                                                                                  |
| 5   | Can it capture the Game View to a PNG on demand, in the editor, without a build?                                                                                                                          |
| 6   | Nothing — the checkpoint findings are filesystem-level and engine-independent.                                                                                                                            |
| 7   | Does it hold or respect `Temp/UnityLockfile` semantics, or does it introduce its own concurrency model?                                                                                                   |
| 8   | Does it push (subscribe) or only pull (request/response)? Decides the liveness half of §8. The on-disk half is settled either way.                                                                        |
| 9.4 | All three deletion preconditions (1)–(3).                                                                                                                                                                 |

One question they cannot answer, which the owner should: **§4.4 established that "cancel"
here asks a provider to stop and never kills a process.** If Unity integration is meant to
include anything long-running and non-interruptible — a `-batchmode` test run, a build —
that needs its own kill path, and that is a scope decision, not a Unity fact.

---

## 11. Add Project: the remaining UI surfaces

`VERIFIED` by lane, completing §1.

**Project cards / list.** `SidebarProjectItem` — `apps/web/src/components/Sidebar.tsx:1074`;
alternate row `SidebarProjectListRow` — `:2481`. Snapshots built at `:3091-3092`; icon
render at `:2259` → `apps/web/src/components/ProjectFavicon.tsx:12-24`. Data hook
`useProjects()` — `apps/web/src/state/entities.ts:111`;
`EnvironmentProject extends OrchestrationProjectShell` —
`packages/client-runtime/src/state/models.ts:11-13`.

**Per-project settings.** Two stores, and they are different in kind:

- **Checked in, team-shared** — `devgame.json` (§1.4); mutable through
  `ProjectScriptsControl` (`apps/web/src/components/ProjectScriptsControl.tsx:129`), saved
  via `project.meta.update` (`decider.ts:263-297`) into the `scripts_json` / `default_model`
  columns.
- **Client-local, per user** — ~~the engine override in
  `apps/web/src/engineSelectorStore.ts`~~. **This option no longer exists.** The store
  landed in `da0d5d247` and was deleted in `c49beccb3` when the owner ruled the engine is
  **detected, never chosen**.

That would have given a **third** attachment option beyond §1.5's two, and the reasoning
below still holds for a genuine _user preference_ about Unity (e.g. "which editor version
this project should use") as opposed to a _derived fact_ about it. But note what the
deletion taught: engine type looked like a preference and was not — it is derived from the
project on disk, and letting a client-side choice beat detection only created a way for the
two to disagree with no way to reconcile them. **Check that a candidate is really a
preference before reaching for this pattern.**

**Lifecycle / status state: none exists.** `VERIFIED` — no project lifecycle state anywhere.
The nearest analogue is the thread-activity dot: `resolveProjectStatusIndicator`
(`apps/web/src/components/Sidebar.logic.ts:641-656`, type at `:116-127`, rendered at
`Sidebar.tsx:2231-2250`). It is about thread activity, not the project's own health — but it
is the existing visual vocabulary a Unity status badge should match rather than invent.

**Add-project entry points**, all funnelling into the same palette-driven `project.create`:

- sidebar button — `Sidebar.tsx:2891-2897` (`data-testid="sidebar-add-project-trigger"`)
- command palette — `CommandPalette.tsx:374`, `:1278`, `:1309`
- empty-state route — `apps/web/src/routes/_chat.index.tsx:108`, `:123-125`
- draft hero — `apps/web/src/components/chat/DraftHeroHeadline.tsx:43`, `:131`, `:140-143`

---

## 12. Does never-persist hold for Unity status? — measured

The owner's question, and the one that shapes the first PR. **Answer: yes, keep it live —
but the premise that status is expensive is measurably wrong for two of its three inputs,
and the one input that _is_ expensive is also unnecessary.**

### 12.1 Cost, measured not guessed

Benchmarked against the owner's real Unity project `~/Projects/Deepmind`
(`ProjectSettings/ProjectVersion.txt` 85 B, `Packages/manifest.json` 2.5 KB,
`packages-lock.json` 17 KB, `Temp/UnityLockfile` present). 200 iterations each, warm page
cache, local NVMe. Script: `/Users/pieroherrera/.claude/jobs/d1eda764/tmp/unity-arch/probe-bench.mjs`.

| probe                                                                | ms/op      | running total | vs today    |
| -------------------------------------------------------------------- | ---------- | ------------- | ----------- |
| **today** — stat `project.godot` (miss) + `ProjectVersion.txt` (hit) | 0.0065     | 0.0065        | 1×          |
| + read+parse `Packages/manifest.json`                                | +0.0147    |               |             |
| + read+parse `ProjectVersion.txt` (extract editor version)           | +0.0090    |               |             |
| + stat `Temp/UnityLockfile` (is an editor holding it)                | +0.0012    | **0.0313**    | **~5×**     |
| + `readdir /Applications/Unity/Hub/Editor`                           | +0.0088    | 0.0402        | ~6×         |
| + **`pgrep -x Unity`** (process scan)                                | **+23.81** | **23.85**     | **~3,700×** |

(`packages-lock.json`, at 0.0439 ms, is the one on-disk read worth avoiding — and it is not
needed: `manifest.json` is the file that says what the project _declares_.)

**Reading the manifest and the version file is not expensive.** Together with the lockfile
stat they cost 0.031 ms — five times a probe the codebase already runs on its hottest read
path behind a one-minute cache. That is the same order of magnitude, not a different one.

**The process scan is 600× everything else combined — and it is unnecessary.** Two cheaper
sources already answer the question it would ask:

- _Is an editor holding this project?_ → `Temp/UnityLockfile`, 0.0012 ms, already
  implemented as `probeUnityLockfilePresent` (`UnityColdStart.ts:109-117`).
- _Is an editor connected to us?_ → `EditorPresenceRegistry`, in-memory, free.

The existing design already made this call: `UnityColdStart.ts:26` states "Choose by
probing the lockfile, not by remembering what we launched." **A process scan must not enter
the read path.**

### 12.2 Snapshot frequency, verified

Two paths with very different blast radius, and the distinction is most of the answer.

**`getShellSnapshot()` resolves `engineType` for _every_ project** (`ProjectionSnapshotQuery.ts:1840`):

| caller                                                          | when                                                                                                                                                                 |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/ws.ts:1155` (`subscribeShell`)                 | once per client subscription — connect / reconnect                                                                                                                   |
| `apps/server/src/orchestration/http.ts:55` (`shellSnapshot`)    | once per HTTP request                                                                                                                                                |
| `apps/server/src/relay/AgentAwarenessRelay.ts:528`              | **startup only** — forked once after a 1 s sleep, and gated on relay publishing being enabled                                                                        |
| `apps/server/src/orchestration/Layers/CheckpointReactor.ts:593` | inside `followWorktreeBranchDrift`, behind an early return requiring `thread.worktreePath !== null && === input.cwd` plus a drifted branch — **not** a per-turn path |

**`getProjectShellById()` resolves it for _one_ project** (`:2134`, `:2172`):

| caller                                                         | when                                                                                       |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `ws.ts:1726`                                                   | **asset URL minting** — every project favicon, every attachment image. The hottest caller. |
| `ProviderCommandReactor.ts:374` (`resolveProject`)             | per turn                                                                                   |
| `CheckpointReactor.ts:175` (`resolveThreadProjects`)           | per checkpoint (≈2 per turn)                                                               |
| `ws.ts:603` (`projectUpsertOrRemove`)                          | only on `project.created` / `.meta-updated` / `.deleted`                                   |
| `ProjectSetupScriptRunner.ts:95`, `AgentAwarenessRelay.ts:409` | worktree setup; per coalesced thread publish                                               |

**The feared case does not occur.** A thread event never rebuilds the project list:
`ws.ts:539-571`'s `toShellStreamEvent` routes every thread event to `threadUpsertOrRemove`,
which reads a _thread_ shell. Per-turn and per-checkpoint traffic touches the
**single-project** path only. The all-projects path is bounded by client subscriptions and
explicit HTTP reads.

Scaling (arithmetic, not measurement — see §12.5): at 0.031 ms per project the all-projects
path costs ~1.5 ms of filesystem work across 50 projects, deduped by `workspaceRoot` and run
at `concurrency: 4`.

### 12.3 Verdict: stay live, do not persist

1. **Cost does not justify it.** 5× a probe already deemed cheap enough for the favicon path.
2. **The expensive input is excluded by design**, not by caching (§12.1).
3. **Staleness is worse here, not better.** `EngineTypeResolver.ts:6-10` argues persistence
   "would go stale the moment someone adds an engine to an existing project folder." Unity
   _status_ goes stale more readily, not less: the user opens Unity's own Package Manager,
   hand-edits `manifest.json`, switches branches, or runs `git clean`. Every one of those
   changes the answer with no event we can observe. A persisted value would be confidently
   wrong; a live value is merely up to 60 s late.
4. **The migration cost is real** — the same "event schema, decider, projector, and client
   contract" the existing comment enumerates.

**If the owner overrules this**, the destination is _not_ `projection_projects`. It is
`apps/server/src/provider/providerStatusCache.ts`'s pattern: a decoded snapshot written to
T3 home via `writeFileStringAtomically`, outside the event-sourced projection, treated as a
warm-start hint that is always re-derived. Event schema untouched; staleness becomes a
cache miss rather than a lie.

### 12.4 Three ways the live design must differ from `engineType`

This is where "just do what `engineType` does" is not sufficient.

**(a) Split by scope and cadence.** Three things with three lifetimes are being conflated:

| fact                                                        | scope           | cadence                                                                                                                                                                                                                                   |
| ----------------------------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| manifest contents, declared editor version                  | per project     | live, 1-min TTL — exactly today's shape                                                                                                                                                                                                   |
| is a Unity editor installed on this machine, which versions | **per machine** | one cached probe, reused by every project — belongs beside `providerMaintenance.ts`'s `LATEST_VERSION_CACHE_TTL_MS` (`:17`) and `isCommandAvailable`/`resolveCommandPath` from `@t3tools/shared/shell`, **not** in a per-project resolver |
| is an editor open / connected                               | per project     | never cached — lockfile stat + `EditorPresenceRegistry`                                                                                                                                                                                   |

**(b) Add explicit invalidation — the single most important difference.**
`EngineTypeResolver` exposes only `detect` (`:83`). Effect's `Cache` already provides
`invalidate` (`effect/dist/Cache.d.ts:1470`), `refresh` (`:1855`), `set` (`:956`) — none
surfaced. For `engineType` that is fine, because the app never causes the change. **For
Unity status the app _is_ the cause**: our own install flow writes the manifest. A status
resolver must expose `invalidate(workspaceRoot)` so Install → status-flips is immediate.
Waiting out a 60 s TTL after the user clicks Install is the difference between the feature
feeling instant and feeling broken.

**(c) Keep anything genuinely expensive off the read path.** If a future need requires a
`unity -version` spawn or a Hub query, it belongs in a demand-gated broadcaster
(`VcsStatusBroadcaster`, §8.2) or an explicit user-triggered refresh — never inside
`getProjectShellById`, which fires on every favicon.

### 12.5 What I could not measure

- Numbers are **warm page cache on local NVMe**. Cold cache, a network-mounted workspace, or
  a spinning disk would all be worse — but equally so for the two stats already shipping, and
  the **5× ratio** is what the decision rests on, not the absolute.
- I could not read the live project count: `sqlite3 -readonly ~/.t3/userdata/state.sqlite`
  failed to open (error 14), and I did not force it against the owner's live database. The
  all-projects scaling in §12.2 is therefore arithmetic, not measurement.
- `pgrep`'s 23.8 ms is dominated by process spawn. An in-process enumeration would be
  cheaper — still orders above the file probes, and still unnecessary.

### 12.6 Two loose props now have suppliers

Following up the precedents handed to me — both of `EngineToolbar`'s unwired props already
have a source in the file where it would mount:

- `hasPresenceCommandScope` ← `usePrimarySessionState()`
  (`apps/web/src/environments/primary/sessionState.ts:21`), already imported and called in
  `ChatView.tsx:218`, `:1678`. Check for `AuthPresenceCommandScope` — `"presence:command"`,
  `packages/contracts/src/auth.ts:102`, deliberately excluded from
  `AuthStandardClientScopes` (`:187-193`).
- `onOpenConnectionsSettings` ← `ConnectionsSettings.tsx`, which uses the same hook at
  `:1745` and already contains the consent-granting dialog. The toolbar should point at it
  rather than build a second grant path — which is what its own doc comment already says.

---

## 13. Things checked and confirmed absent

Negative findings matter as much as positive ones here, because each is a place someone
would otherwise go looking for a pattern to copy. All `VERIFIED` by grep plus reading:

| looked for                                                    | result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP **client** config/install UI                              | absent. `apps/server/src/mcp/*` is T3's **outbound** MCP server (exposing T3's tools to external editors), not a client that installs third-party MCP servers. No `mcp.*` entries in `WS_METHODS`.                                                                                                                                                                                                                                                                                                                                                |
| devcontainer setup flow                                       | absent. Only `.devcontainer/devcontainer.json`, for developing T3 itself.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Tailscale / SSH install flow                                  | absent. `packages/tailscale`, `packages/ssh` only _use_ an already-present binary. The one install-adjacent string is a remote-bootstrap shell one-liner printed on failure (`packages/ssh/src/tunnel.ts:420`, `:434`, `:465`).                                                                                                                                                                                                                                                                                                                   |
| in-app provider **auth** (login → button → OAuth → connected) | absent, and this is the clearest negative in the study. `ServerProviderAuthStatus` (`server.ts:48-52`) is purely descriptive with no transition schema. `AuthStatusPayload { isAuthenticating?, output?, error? }` (`providerRuntime.ts:525-530`) is the only in-progress auth shape and **no React component consumes `isAuthenticating`** (grep: zero). The entire UX is a banner reading "Sign in via the CLI to authenticate again" (`apps/web/src/components/chat/ProviderStatusBanner.tsx:34-39`). No `startAuth`/`oauth` WS method exists. |
| an install button for a **missing** provider CLI              | absent. `providerStatus.ts:45-49` renders "Not found / CLI not detected on PATH"; `ProviderInstanceCard.tsx` has no `!installed` action branch.                                                                                                                                                                                                                                                                                                                                                                                                   |
| filesystem watcher on project/engine files                    | absent. Watching exists only for the settings and keybindings config files (§8.3).                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| hardcoded ignore list for checkpoint/diff                     | absent. All ignore behaviour is git's native engine (§6.3).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| per-repo git serialisation                                    | absent (§7.1).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Unity awareness beyond two paths                              | absent. Only `ProjectSettings/ProjectVersion.txt` and `Temp/UnityLockfile` (§2).                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
