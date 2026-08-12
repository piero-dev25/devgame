# T3 fork architecture seams — what a GenerationService would attach to

Repo: `~/Projects/t3code-fork`, branch `workbench/upstream-20260806`. Read-only
survey. Feeds `GENERATION_ARCHITECTURE.md`; answers HANDOFF §68 step 1 and the
§66 architecture questions 32–39.

Every claim below carries a `file:line` citation. Where I could not establish
something by reading, it is listed under **Unknowns** at the end of the section
rather than guessed at.

Method note: the shell `grep` here is aliased to ugrep and silently skips
directories; every search behind these findings used `/usr/bin/grep`.

---

## 0. The 60-second summary

| Question                        | Short answer                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 32/33. Use T3's event system?   | It _can_ take a fourth aggregate — the fork already added a third (`space`) and the commit records exactly what that cost. But generation jobs are high-frequency, externally-owned mutable state; event-sourcing them buys replay you don't need and costs a serialized single-worker command queue you do care about. Recommended split below (§1.5). |
| 34. Project-scoped jobs?        | Yes, and the repo has a ratified trust model for it: the client sends an opaque `projectId`, the server resolves `workspace_root` from its own projection. Never accept a path from the wire.                                                                                                                                                           |
| 35. GeneratedAsset ↔ files      | Two existing seams: `attachmentsDir` (server state dir, thread-named ids) and signed asset URLs (`/api/assets`, HMAC, 1h TTL). Neither is project-scoped today.                                                                                                                                                                                         |
| 36. Credentials                 | `ServerSecretStore` = `<stateDir>/secrets/<name>.bin`, dir 0700, file 0600, server-side only. Provider env vars already ride it with a `sensitive`/`valueRedacted` wire-redaction protocol. `MESHY_API_KEY` should copy that exactly. No OS keychain on the server side.                                                                                |
| 37. Where local generation runs | The server process **is** the execution environment. `docs/internals/remote.md` states the invariant outright. Phone/web clients are transport-only.                                                                                                                                                                                                    |
| 38. MCP transport               | The server already hosts an MCP HTTP server at `/mcp`, and **all five** provider adapters already inject it into agent sessions. This is the single highest-leverage seam in the repo.                                                                                                                                                                  |
| 39. Canonical capability layer  | `McpCapability` exists but is a one-member type wired into a _preview-specific_ error schema. Adding a second capability is a real (small) refactor, not a one-line edit — see the #116 trap in §6.3.                                                                                                                                                   |

---

## 1. The event system, persistence, and what the fork's own additions did

### 1.1 Shape

The server is event-sourced. Clients dispatch typed commands; a decider turns
them into events; projections derive the read model. The canonical description is
`docs/internals/overview.md:60-83`.

The store is one SQLite table:

- `apps/server/src/persistence/Migrations/001_OrchestrationEvents.ts:8-23` —
  `orchestration_events(sequence AUTOINCREMENT, event_id, aggregate_kind,
stream_id, stream_version, event_type, occurred_at, command_id,
causation_event_id, correlation_id, actor_kind, payload_json, metadata_json)`.
  Unique index on `(aggregate_kind, stream_id, stream_version)` at `:26-28`.
- `apps/server/src/persistence/Layers/OrchestrationEventStore.ts:103-159` —
  append computes `stream_version` inside the INSERT with a correlated subquery.
  Read surface is `append` / `readFromSequence` / `readAll` only
  (`:264-268`). There is no per-stream read API.

Aggregates are a closed literal union:
`packages/contracts/src/orchestration.ts:1163` —
`Schema.Literals(["project", "thread", "space"])`. Stream ids are a closed union
too: `Schema.Union([ProjectId, ThreadId, SpaceId])`
(`OrchestrationEventStore.ts:39` and `orchestration.ts:1424-1428`).

The engine serializes everything through **one worker fiber** over an unbounded
queue: `apps/server/src/orchestration/Layers/OrchestrationEngine.ts:97`
(`commandQueue`), `:310` (`Effect.forever(Queue.take(...))`). Each envelope runs
receipt check → decider → _one SQL transaction_ that appends events, projects
them in-memory, projects them to tables, and writes the receipt
(`:176-220`), then publishes to a PubSub (`:224`).

Command→aggregate routing is a hand-written switch:
`OrchestrationEngine.ts:60-84`.

Projections are a named list of projector functions:
`apps/server/src/orchestration/Layers/ProjectionPipeline.ts:60-71`
(`ORCHESTRATION_PROJECTOR_NAMES`), each with `{name, apply}`
(`:98-105`). Projection tables in
`apps/server/src/persistence/Migrations/005_Projections.ts:8-33`
(`projection_projects(project_id, …, workspace_root, …, deleted_at)`,
`projection_threads(thread_id, project_id, …, worktree_path, …, deleted_at)`).

Migrations are a static import list plus a numbered entry table:
`apps/server/src/persistence/Migrations.ts:16-61` and `:73-121`.

### 1.2 The fork HAS already added an aggregate — this is the load-bearing precedent

Commit `79097c0e3` "feat(model): the space aggregate — a scope, not a container"
(Piero Herrera, 2026-08-02) added the `space` aggregate. Its stat block is the
honest price list for "add a fourth aggregate":

```
apps/server/src/orchestration/Layers/OrchestrationEngine.ts      | 11 +-
apps/server/src/orchestration/Layers/ProjectionPipeline.ts       | 79 +
apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts  | 266 +-
apps/server/src/orchestration/Schemas.ts                         |  5 +
apps/server/src/orchestration/commandInvariants.ts               | 80 +
apps/server/src/orchestration/decider.ts                         | 80 +
apps/server/src/orchestration/projector.ts                       | 49 +
apps/server/src/persistence/Layers/OrchestrationEventStore.ts    |  5 +-
apps/server/src/persistence/Layers/ProjectionSpaces.ts           | 123 +
apps/server/src/persistence/Layers/ProjectionThreads.ts          | 25 +
apps/server/src/persistence/Migrations.ts                        |  2 +
apps/server/src/persistence/Migrations/037_ProjectionSpaces.ts   | 32 +
apps/server/src/persistence/Services/ProjectionSpaces.ts         | 81 +
apps/server/src/ws.ts                                            |  2 +-
packages/contracts/src/baseSchemas.ts                            |  2 +
packages/contracts/src/orchestration.ts                          | 101 +
22 files changed, 1268 insertions(+)
```

Four findings from that commit message worth carrying forward verbatim:

1. **Seven closed `project|thread` unions had to be widened**, not the three the
   author estimated. One of them was not a rename: `commandToAggregateRef` would
   have fallen through to `command.threadId`, which does not exist on a space
   command. (Confirmed still hand-written at `OrchestrationEngine.ts:78-83`.)
2. **Both event tables store the discriminator as plain TEXT with no CHECK**, so
   a new stream kind is genuinely additive at the SQL level.
3. **A replay test caught a real ordering bug.** Bootstrap runs each projector as
   its own full sequential pass over history, not interleaved. Cross-aggregate
   writes must live in the projector that owns the _target_ table, not the one
   that owns the triggering event. The fix and its reasoning are still in the
   code: `ProjectionPipeline.ts:577-590` and `:651-663`.
4. **Boot-time hydration is mandatory**: spaces are wired into
   `getCommandReadModel` deliberately — omitting it makes every reference fail
   after a server restart (`OrchestrationEngine.ts:308`).

There is also a live hazard in the id space: `Migrations.ts:106-120` records that
the fork and upstream both minted migration ids 36–38 independently, and that a
database produced by stock T3 Code would silently skip the fork's space
migrations. Any generation migration must be appended after 40 and must not
assume the fork owns its numeric range.

### 1.3 What the fork's OTHER additions did — and they all declined persistence

Three fork-added subsystems, three deliberate non-uses of the event store:

**Editor presence registry** — `apps/server/src/editorPresence/EditorPresenceRegistry.ts:1-19`
opens with: _"Pure in-memory fan-out … with last-known-state retention per
publisher session. Nothing on disk, nothing per-thread."_ State is a single
`Ref<RegistryState>` (`:336`) holding `publishers`/`subscribers`/`pendingCommands`
maps (`:167-171`). Presence is modelled as a **level** (every frame carries full
state, self-healing on reconnect); commands are **edges**, delivered once, never
queued, never replayed (`:13-18`). Reconnect identity is guarded by a per-connection
symbol token plus the claimant's `AuthenticatedSession.sessionId` (`:112-154`).

**Space events** — `apps/server/src/spaceEvents/SpaceEventsRegistry.ts:1-12`:
_"Pure in-memory fan-out for Space Events, keyed by project. Nothing on disk …
See `EditorPresenceRegistry` for the same shape."_ Keyed
`Map<ProjectId, Set<send>>` (`:21-23`) with a `hasSubscribers(projectId)` check so
a broadcast for an unwatched project skips the read-model query entirely
(`:35-38`).

**Unity setup probe** — `apps/server/src/unity/UnitySetupProbe.ts:1-14`: a
read-only probe run on demand; the only retained state is `serverStartedAtMs`,
captured once at layer construction, with an explicit comment that _"no separate
lifecycle event or persisted timestamp is needed for a value that only ever needs
to survive for the life of this one process"_ (`:100-112`).

**Engine type detection** states the cost model most explicitly of all —
`apps/server/src/project/EngineTypeResolver.ts:5-12`:

> Detection always runs LIVE on demand and is never persisted: a few file checks
> are cheap, and storing the result would require a migration plus touching the
> event schema, decider, projector, and client contract, then go stale the moment
> someone adds an engine to (or removes one from) an existing project folder.

**Precedent set:** the fork uses the event store for _identity and ownership_
(the space aggregate) and refuses it for _observed, derived, or ephemeral runtime
state_ (presence, probes, engine detection). A `GenerationJob` is both — which is
why it wants a split.

### 1.4 What the event system would and would not give a GenerationJob

Gives you, for free:

- durable, ordered history with causation/correlation ids
  (`001_OrchestrationEvents.ts:16-18`) — provenance (HANDOFF §12) almost falls out
- idempotent command retry via durable receipts (`OrchestrationEngine.ts:145-158`)
- one transaction covering event + projection, so the read model cannot durably
  disagree (`:176-220`)
- a live push channel to every subscriber (`:224`, `:336-338`)

Costs you:

- **total ordering through a single worker fiber** (`:310`). Every provider delta,
  every checkpoint, every thread turn already queues here. A 3D job emitting
  progress percentages would contend with agent streaming on the same queue.
- an append per state change, forever — provider progress polling is a firehose
- widening ~7 closed unions plus contracts, decider, projector, snapshot query,
  ws.ts (§1.2)
- replay semantics you must then honour: a projector pass replays _all_ history
  (`ProjectionPipeline.ts:577-590`), so any "call the provider" side effect must
  live outside the projector

### 1.5 Recommendation (for GENERATION_ARCHITECTURE.md to accept or reject)

Split by mutability rate, following what the fork already did:

- **Event-sourced (new `generation` aggregate, or reuse `project`):** the small
  set of _decisions_ — `generation.requested`, `generation.settled` (terminal:
  succeeded/failed/cancelled), `generated-asset.recorded`,
  `generated-asset.imported`, `generated-asset.selected`. These are low-frequency,
  need provenance, and must survive restart. Reusing the existing `project`
  aggregate stream is cheaper than a fourth stream kind — a project-scoped
  `generation.*` event has `aggregateKind: "project"` and needs zero union
  widening; the cost is that `projection_projects` replay grows.
- **Not event-sourced:** in-flight progress, provider polling cursors, byte
  counts, ETA — an in-memory registry in the shape of
  `SpaceEventsRegistry`/`EditorPresenceRegistry`, project-keyed, level-broadcast,
  self-healing on reconnect. Crash = jobs come back from the terminal events plus
  a provider re-poll, not from a replayed progress log.
- **Separate table, not the event store, for `GeneratedAsset` file rows** if the
  asset catalog needs indexed queries by modality/project — a projection table is
  the existing idiom (`005_Projections.ts`).

**Unknown:** whether `Migrator` tolerates a new migration whose projector needs a
backfill pass over `orchestration_events` — migrations 024 and 025 do backfills
(`024_BackfillProjectionThreadShellSummary.ts`), but I did not read them.

---

## 2. Project scoping: the `projectId → workspace_root` trust model

### 2.1 The model, and the fact that it is already ratified in writing

`docs/specs/unity-project-scoped-routes.md` is a shipped spec that exists purely
to establish this rule. Its "The design (ratified — do not re-litigate)" section:

> Copy the Diff panel's trust model, the strongest precedent in the repo: the
> client sends an **opaque server-issued identifier**, the server resolves the
> filesystem path from its own store, and **no path ever crosses the wire**.

It records the live defect that forced it: the packaged desktop app serves every
project from one process whose cwd is the user's home directory, so
`serverConfig.cwd`-reading routes produced _"Not a Unity project:
/Users/pieroherrera"_. It also explicitly **rejects** caller-supplied
`workspaceRoot` for any route that writes to disk.

The implementation:

- `apps/server/src/unity/UnitySetupProbeRoute.ts:10-13` — _"Takes only an opaque
  `projectId`; the canonical filesystem root is resolved from the server's
  projection store and never crosses the wire."_
- `:64-95` — `ProjectionSnapshotQuery.getProjectShellById(projectId)` → unknown
  id becomes a typed `{_tag:"error"}` result, never a cwd fallback; the lookup
  failure is logged before being collapsed so SQL failure stays distinguishable
  from unknown-id in triage.
- `:88-93` — resolve to the **canonical** `project.workspaceRoot`, deliberately
  **not** `thread.worktreePath ?? workspaceRoot`: the Unity Editor binds to the
  canonical root, so a worktree copy would target a project no Editor has open.
- Server-side resolver: `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts:2412`.
- Scope gate: `AuthPresenceReadScope` for read-only probes vs
  `AuthPresenceCommandScope` for anything that executes
  (`UnitySetupProbeRoute.ts:16-24`, `packages/contracts/src/auth.ts:102,121`).

The Diff-panel precedent it copies: `OrchestrationGetTurnDiffInput` carries only
`threadId`; the server joins `projection_threads → projection_projects` selecting
`workspace_root`.

**For generation this means:** `generate_3d` must take `projectId` (or derive it
from the MCP invocation scope, §6.4) and never a path. The one deviation to
consider is worktrees — the Unity rule (canonical root) is right for engine
binding; for _writing a generated file into the repo_ the Diff rule
(`worktreePath ?? workspaceRoot`) may be the correct one instead, since the agent
is working in the worktree. **This is a genuine open decision, not a settled
precedent.**

### 2.2 Identity triple: environment, project, thread

- `environmentId` is one running server, persisted at `<stateDir>/environment-id`
  and generated on first start (`docs/internals/remote.md:36-39`,
  `apps/server/src/environment/ServerEnvironment.ts`).
- Client-side, a project is addressed as a `ScopedProjectRef = (environmentId,
projectId)` — `apps/web/src/state/entities.ts:133`,
  `packages/client-runtime/src/state/projectEntities.ts:103`.
- The Unity spec §3 makes the cache-key consequence explicit: _"Probe identity
  becomes (environmentId, projectId)"_ — keying anything project-scoped on
  environmentId alone means two projects in one environment serve each other's
  cached answers. `scopedProjectKey` in `packages/client-runtime` is the existing
  utility. **A generation cache/atom family must key on both.**

### 2.3 Project-owned, thread-referenced state (HANDOFF §34, §72)

The demand is: generation belongs to the PROJECT and survives thread deletion,
agent switch, and restart. What the repo gives you:

- `projection_threads.project_id` (`005_Projections.ts:23`) — the thread→project
  edge already exists and is queryable.
- Thread deletion is a **soft delete**: `deleted_at` column on both
  `projection_projects` and `projection_threads` (`005_Projections.ts:16,31`).
  The `ThreadDeletionReactor` cleans up only the provider session and terminals
  (`apps/server/src/orchestration/Layers/ThreadDeletionReactor.ts:60-64`). It does
  **not** delete rows or chase file artifacts.
- The **space aggregate is the exact template** for "referenced, never owned".
  From `79097c0e3`'s message: _"Delete never cascades, proven and
  mutation-proven … Cross-project references work and are meant to — a space is
  context, and context is not owned by a directory. The decider never inspects,
  cascades to, or rejects on referencing threads."_ The implementation clears the
  _reference_ (`projection_threads.space_id → NULL`) and leaves the referring rows
  alive: `ProjectionPipeline.ts:661-663` (`clearSpaceReferences`), with the
  ordering rationale at `:651-660`.
  A `thread.generation_ref` would follow this exact shape.

**The one thing that does NOT survive thread identity today: attachments.**
`apps/server/src/attachmentStore.ts:36-42` mints attachment ids as
`<safe-thread-segment>-<uuid>`, and the projection pipeline prunes attachment
files by thread (`ProjectionPipeline.ts:107-110`, `AttachmentSideEffects` with
`deletedThreadIds`). So the existing image-attachment plumbing is structurally
thread-owned. **A `GeneratedAsset` must not reuse `attachmentsDir` as its primary
home** — it would inherit thread-scoped lifetime, which is exactly what HANDOFF
§72 forbids. It may _additionally_ publish a thread attachment for inline chat
display, but the durable copy belongs elsewhere (project-scoped directory under
`stateDir`, or in the workspace itself).

**Unknown:** whether the fork's live databases actually hard-delete thread rows
anywhere (I read the reactor and the projector, not every repository method).

---

## 3. Credentials

### 3.1 The server-side secret store — this is the pattern to copy

`apps/server/src/auth/ServerSecretStore.ts`:

- Backed by the filesystem, not an OS keychain: `<stateDir>/secrets/<name>.bin`
  (`:169`, `apps/server/src/config.ts:131`).
- Directory created `0o700` at layer construction (`:158-167`); every file
  written `0o600` via write-temp → chmod → rename → chmod (`:187-222`).
- `create` uses `flag: "wx"` so a concurrent creator loses the race
  deterministically; `getOrCreateRandom` handles `AlreadyExists` by re-reading
  (`:224-287`).
- API: `get / set / create / getOrCreateRandom / remove` (`:138-150`).

`stateDir` itself is `<baseDir>/userdata` (or `<baseDir>/dev` when a dev URL is
set) — `config.ts:105-108`.

### 3.2 Provider API keys today: `sensitive` env vars with wire redaction

This is the closest existing analogue to `MESHY_API_KEY`, and it is a complete,
working protocol:

- Contract: `packages/contracts/src/providerInstance.ts:104-113` —
  `ProviderInstanceEnvironmentVariable { name, value, sensitive, valueRedacted? }`;
  a provider instance carries an array of them (`:124-131`).
- On save, `apps/server/src/serverSettings.ts:395-445`: a `sensitive` variable's
  value is written into `ServerSecretStore` under the key
  `provider-env-<b64url(instanceId)>-<b64url(name)>` (`:78-84`), and what lands in
  `settings.json` is `{value: "", valueRedacted: true}`. Clearing the value
  removes the secret.
- On load, `:316-340` (`materializeProviderEnvironmentSecrets`) re-hydrates the
  real value from the secret store for server-side use only.
- On the wire, `redactServerSettingsForClient` (`:100-112`) blanks every sensitive
  value, and it is applied at **every** client-facing exit:
  `apps/server/src/ws.ts:992`, `:1477`, `:1488`, `:2039`.

### 3.3 Client-side secrets are a different mechanism, and are NOT this

The desktop app encrypts its saved _bearer tokens for environments_ with Electron
`safeStorage` (`apps/desktop/src/electron/ElectronSafeStorage.ts:54-66`,
`apps/desktop/src/settings/DesktopSavedEnvironments.ts:26-27,54`). That is the
client's credential for reaching a server. It is not, and must not become, where
provider API keys live: a phone or hosted-web client would then need the Meshy key
to make the app work.

### 3.4 What this means for `MESHY_API_KEY`-class secrets

1. Store server-side in `ServerSecretStore` under a namespaced key
   (`generation-provider-<providerId>-<credentialName>`), mirroring
   `providerEnvironmentSecretName`.
2. Model it in settings as `{name, value, sensitive: true}` so the existing
   save/redact/materialize protocol applies unchanged.
3. Redact on every read path — copy the discipline of the four `ws.ts` call
   sites, and add a test asserting the raw value never appears in a client-facing
   payload. (`serverSettings.ts:86-98` is the function to reuse, not to
   re-implement.)
4. HANDOFF §45's four requirements map cleanly: _never in the game project_
   (it's in `stateDir`, not `workspaceRoot`); _protected_ (0600/0700);
   _environment-specific_ (stateDir is per-environment); _remote-client safe_
   (the key never crosses the wire — the remote client asks the host to generate,
   it does not hold the key).

**Unknowns:** (a) whether `stateDir` is ever synced/backed up by the desktop app —
if so, 0600 files travel; (b) whether any diagnostics/telemetry path dumps
settings unredacted (I checked `ws.ts` exits only, not the diagnostics bundle).

---

## 4. Remote model, and what it dictates about where generation executes

### 4.1 The invariant is already written down

`docs/internals/remote.md:12-14`:

> T3 has one runtime boundary: a client talks to a T3 server over HTTP and
> WebSocket, and the server owns orchestration, providers, terminals, git, and
> filesystem operations. **Remoteness is expressed at the connection layer, never
> by splitting the runtime.**

And `docs/internals/overview.md:5-8`: _"The server is the execution boundary:
every provider process, terminal, git operation, and filesystem read happens
there, never in the client."_

Access methods (`remote.md:47-56`): `PrimaryConnectionTarget` (platform-managed
local), `BearerConnectionTarget` (direct, incl. Tailscale), `RelayConnectionTarget`
(managed tunnel), `SshConnectionTarget` (desktop-managed SSH). The hosted web app
_does not proxy_ HTTP or WS — the backend must be directly reachable
(`remote.md:110-113`).

**This settles HANDOFF §44 with no design work required:** generation executes on
the environment/project host, because that is where every other capability already
executes. Nothing about local generation may depend on the viewing device. A
phone client's role is: dispatch, subscribe, render.

### 4.2 There IS a counter-example in the repo, and it is the shape to avoid

Preview automation inverts this: the _client's browser_ is the execution surface
and the server is a broker. `apps/server/src/mcp/PreviewAutomationBroker.ts:44-58`
exposes `connect(host)` (a client registers as an automation host and receives a
stream), `respond(response)`, and `invoke(request)` — the server queues a request
to a connected client and awaits the client's answer, with errors for
`NoAvailableHost`, `ClientDisconnected`, `UnsupportedClient`, `RemoteUnavailable`
(`packages/contracts/src/previewAutomation.ts:860-874`).

That model exists because browsers can only be driven from inside a browser. It
does not apply to generation, and copying it would make local generation depend on
the remote viewing device — precisely what §44 forbids.

### 4.3 How progress would stream to a remote client

Three existing transports, in increasing order of divergence cost:

1. **RPC server-streams** — `packages/contracts/src/rpc.ts:168` (`WS_METHODS`),
   with `stream: true` members (e.g. `:321-327`). Mounted by
   `apps/server/src/ws.ts`; per-method scope enforcement in
   `apps/server/src/auth/RpcAuthorization.ts:23-46` (adding an RPC without
   declaring a scope is a **type error**, `:44` — `satisfies Record<WsRpcMethod,
AuthEnvironmentScope>`). Cost: edits `packages/contracts` **and** `ws.ts`, both
   vendor files → permanent merge conflict surface.
2. **A dedicated raw WS route** — the fork's own answer, and it explains itself:
   `apps/server/src/spaceEvents/SpaceEventsRoute.ts:15-30`:

   > This route exists entirely outside `WsRpcGroup` / `WS_METHODS` — no new RPC
   > method, no `packages/contracts` change, no `../ws.ts` edit — for the same
   > reason `EditorPresenceRoute.ts` does: `WsRpcGroup` mounts every WS_METHODS
   > handler together in one object, so its router's type requirement is the union
   > of all of them, and there is no way to bolt on a project-scoped subscription
   > without editing either vendor file.

   `GET /space-events?projectId=<ProjectId>`, subscribe-only, level-style
   broadcasts, project-keyed fan-out. Auth: accept the upgrade, authenticate
   inside `onOpen`, close with an application code ≥4000 on failure, because a
   browser's native `WebSocket` cannot read a rejected upgrade's HTTP status
   either (`:36-52`). Retry semantics are credential-class (4400/4401 = stop) vs
   server-fault (4500 = retry).

3. **Existing orchestration event stream** — free if generation events are real
   orchestration events, but note `subscribeShell` narrows to `project`/`thread`
   and drops everything else (quoted at `SpaceEventsRoute.ts:5-10`), which is the
   exact gap that forced route #2 into existence.

**Recommendation:** `GET /generation-events?projectId=…`, modelled byte-for-byte
on `SpaceEventsRoute` + `SpaceEventsRegistry`. Level broadcasts (full job list per
frame) make reconnect self-healing and make "what happened while the phone was
asleep" a non-question — the same argument `EditorPresenceRegistry.ts:6-11` makes
for presence.

### 4.4 Getting the media itself to a remote client

`AssetAccess` already solves "server-side file → URL a remote browser can load":

- `apps/server/src/assets/AssetAccess.ts:45` — `ASSET_ROUTE_PREFIX = "/api/assets"`.
- Signed with an HMAC over base64url claims, key from
  `ServerSecretStore.getOrCreateRandom("asset-access-signing-key", 32)` (`:47,361`),
  verified timing-safe (`:393-401`), TTL 1 hour (`:48`).
- Resource kinds are a closed union: `packages/contracts/src/assets.ts:7-18` —
  `workspace-file{threadId,path}`, `attachment{attachmentId}`,
  `project-favicon{cwd}`.
- Minted over RPC: `assets.createUrl` (`packages/contracts/src/rpc.ts:184,484`,
  handler `apps/server/src/ws.ts:1726`).

Adding a `generated-asset{assetId}` (or project-scoped `project-file`) variant to
`AssetResource` is the natural move — but note it edits `packages/contracts` and
`AssetAccess.ts`, both vendor files. **Open question for the architecture doc:**
whether to extend `AssetResource` or to serve generated media from a new
fork-owned signed route. Extending is smaller code; a new route is smaller merge
debt.

---

## 5. The dock/rightPanel surface model

### 5.1 There are two panel systems; the dock is the live one

`apps/web/src/rightPanelStore.ts` and `components/RightPanelTabs.tsx` still exist,
but the surfaces were promoted into a dockview-based dock. The dock lives in
`apps/web/src/dock/` (`DockviewLayout.tsx` 1587 lines, `ChatDock.tsx` 652 lines,
plus `lib/`).

### 5.2 Registering a panel is a catalog entry plus a component — nothing else

`apps/web/src/dock/lib/panelRegistry.ts:27-33` states the contract:

> The panel catalog: panels register by id into one registry, and the registry is
> what dockview's panel factory instantiates from. **Adding a panel type is a
> registry entry plus a component — never a change to the layout engine.**

`PanelDefinition` (`apps/web/src/dock/lib/types.ts:60-100`):
`{id, title, icon, component, defaultLocation?: "centre"|"right"|"bottom"|"left",
minWidth?, minHeight?, singleton?, closeable?}`.
`closeable` is the single source of truth read by three call sites (preset
builder, context-menu close gate, "Add tab" re-add) — `:78-99` documents the two
bugs that existed when it was a per-instance dockview string instead.

Registration happens at **module scope**, once, not per render — `ChatDock.tsx:136-146`
explains why (`createPanelRegistry()` throws on duplicate ids, so module scope is
the natural guard). The five existing registrations are the pattern to copy:
`ChatDock.tsx:173` (Sidebar, `left`, `singleton`, `closeable:false`), `:211` (Chat,
`centre`), `:268` (Diff, `right`, singleton), `:291` (Files, `right`, singleton),
`:317` (Terminal, `right`, singleton), `:343` (Browser, `right`, singleton).

A **Generation panel** would be:

```ts
chatDockPanelRegistry.register({
  id: GENERATION_PANEL_ID,
  title: "Generation",
  icon: Sparkles, // any lucide-react component
  component: GenerationDockPanel,
  defaultLocation: "right", // or "bottom", per HANDOFF §32's mock
  singleton: true,
});
```

plus an entry in the default preset (`ChatDock.tsx:425-473`, both the grid `views`
array and the `panels` map via `presetPanelEntry`).

### 5.3 The migration trap is already solved — do not re-open it

`ChatDock.tsx:98-131` records a real data-loss incident: a newly registered panel
used to be handled by bumping `CHAT_DOCK_WORKSPACE_ID`, which does not migrate
anything — it points storage at a fresh empty key and silently discards the user's
saved arrangement. It happened twice.

The fix is `apps/web/src/dock/lib/layoutMigration.ts:24-60`: `LayoutFile.knownPanelIds`
records which ids the catalog knew about at save time, so "newly registered since
this layout was saved" (migrate it in, at the position the current preset would put
it) is distinguishable from "the user closed it on purpose" (leave it closed). Both
look identical in the raw grid data.

**Consequence: registering a Generation panel requires no workspace-id bump and no
user-visible layout reset.** `CHAT_DOCK_WORKSPACE_ID` stays `"chat-dock-v2"`
(`ChatDock.tsx:132`, with `CHAT_DOCK_STALE_WORKSPACE_IDS` purging the dead keys at
`:133`).

### 5.4 Opening/toggling it programmatically

`apps/web/src/dock/lib/openPanel.ts`:

- `openPanelInDock(id, {api, panelRegistry})` — get-or-add-then-activate; unknown
  id is a silent no-op (`:23-41`)
- `togglePanelInDock` (`:66-73`) — the Cmd+D shape
- `togglePanelGroupVisibility` / `isPanelGroupVisible` / `subscribePanelGroupVisibility`
  (`:104-127`) — group **hide**, not close: `setVisible` sizes the group to zero
  and restores it, keeping the React content mounted. Load-bearing for the sidebar
  because its window keydown listeners exist only while mounted. A Generation panel
  running a long job may want the same guarantee if the panel owns any subscription.

Notification affordance (HANDOFF §58, "Generation tab ● 1"): the tab renderer is
`apps/web/src/dock/reactTabRenderer.tsx` — **I did not verify whether it supports a
badge slot.** Flagged as unknown.

### 5.5 Where inline chat cards render from (UX trial C)

The timeline is row-based. Row union: `apps/web/src/components/chat/MessagesTimeline.logic.ts:163-211` —
`"work" | "work-toggle" | "turn-fold" | "message" | "proposed-plan" | "turn-plan" | "working"`.
Rows are built from thread messages + activities in `buildRows` (`:455-640`).
Rendering is a flat switch: `MessagesTimeline.tsx:950-959`.

The closest existing precedent to a generation card is **`proposed-plan`**: a
server-projected domain object (`projection_thread_proposed_plans`, migration 013)
becomes a row kind (`MessagesTimeline.logic.ts:200,578`) rendered as a real card
component (`ProposedPlanCard`, mounted at `MessagesTimeline.tsx:1213`). That is the
whole path for "server state → inline chat card", and it is ~3 files.

Two other relevant surfaces:

- **Assistant images already render inline.** `ChatImageAttachment` exists in the
  contract (`packages/contracts/src/orchestration.ts:161-168`), assistant messages
  carry `attachments` (`:1050`, `:1333`), the server persists provider-emitted
  images to disk (`apps/server/src/orchestration/AssistantImageAttachmentPersistence.ts:25-70`),
  and the timeline renders them role-agnostically (`MessagesTimeline.tsx:1144-1149`,
  with `ExpandedImagePreview`/`ExpandedImageDialog`). **An image generation result
  can appear in chat today with zero new UI.**
- **Selection → agent context already exists** for preview annotations:
  `ComposerPreviewAnnotationCards.tsx` renders removable chips in the composer for
  user-selected page regions, each carrying an image plus element context. Siblings:
  `ComposerPendingElementContexts.tsx`, `ComposerPendingTerminalContexts.tsx`,
  `ComposerPendingReviewComments.tsx`. **HANDOFF §61 ("agent should receive
  selectedGenerationId with the message") has a working template here** — a
  `ComposerPendingGenerationContexts` chip in exactly this family.
- Tool calls render as compact work rows, not cards: `MessagesTimeline.tsx:2081-2085`
  (`mcp_tool_call` + `toolData` → an expandable JSON block), icon mapping at
  `:2125-2131` (`mcp_tool_call → wrench`). So an MCP-delivered generation would, by
  default, look like a wrench row — **UX trial C requires deliberately promoting it
  to a card**, it will not happen for free.

---

## 6. Where a harness-owned MCP/tool server would live

### 6.1 The server already IS an MCP server

`apps/server/src/mcp/McpHttpServer.ts:219-226`:

```ts
const McpTransportLive = McpServer.layerHttp({
  name: "DevGame",
  version: packageJson.version,
  path: "/mcp",
  protocols: [McpProtocol.v2025_06_18],
}).pipe(Layer.provide(McpAuthMiddlewareLive));

export const layer = PreviewToolkitRegistrationLive.pipe(Layer.provideMerge(McpTransportLive));
```

Built on `effect/unstable/ai`'s `McpServer` / `Tool` / `Toolkit`. Mounted in
`apps/server/src/server.ts:583` inside `makeRoutesLayer`. Auth is a router
middleware resolving a bearer token through `McpSessionRegistry`
(`McpHttpServer.ts:66-97`); an unusable credential is logged, not silently
dropped, because _"the only symptom of a dead credential is the agent quietly
losing the whole `devgame` toolkit for the rest of its session"_ (`:78-80`).

Two registration idioms exist side by side:

- declarative toolkit → `McpServer.toolkit(PreviewStandardToolkit)` (`:206-208`)
- manual `server.addTool({...})` for tools returning **image content** —
  `registerPreviewSnapshot` (`:130-204`) hand-builds a `CallToolResult` with a
  `{type:"image", data: Uint8Array, mimeType}` block alongside the structured
  JSON (`:185-198`). **This is the exact mechanism a `generate_image` /
  `inspect_generation` tool needs to hand pixels back to the agent** (HANDOFF §22,
  §48) — and it is already proven working against real agents.

Tools are declared with `Tool.make(name, {description, parameters, success,
failure, dependencies})` plus annotations (`Tool.Title`, `Readonly`, `Destructive`,
`Idempotent`, `OpenWorld`) — `apps/server/src/mcp/toolkits/preview/tools.ts:41-52`.
A generation toolkit would be a sibling directory: `apps/server/src/mcp/toolkits/generation/`.

### 6.2 The `mcpServers` injection seam — documented precisely

**Credential minting.** `apps/server/src/mcp/McpSessionRegistry.ts:120-150`:
`issue({threadId, providerInstanceId})` generates a UUID `providerSessionId` and 32
random bytes as the raw token, stores only its SHA-256 hash, and returns
`{environmentId, threadId, providerSessionId, providerInstanceId, endpoint,
authorizationHeader: "Bearer <raw>"}`. The endpoint is computed from the live
`HttpServer` address, rewriting `0.0.0.0`/`::` to `127.0.0.1` (`:80-104`).
Credentials expire 24h after the last sign of life (`:73`), refreshed both by MCP
traffic (`resolve`, `:152-166`) and by every provider turn (`touch`, `:168-182`).
The bound matters because _"`/mcp` is mounted outside the environment auth stack …
so this token is the only thing guarding the preview toolkit on a remote-reachable
server"_ (`:69-72`).

**Hand-off to the adapter.** `apps/server/src/mcp/McpProviderSession.ts` is a
14-line module-level `Map<ThreadId, McpProviderSessionConfig>` with
`set/read/clear/clearAll`. Deliberately a plain module global, not a service —
adapters read it synchronously while building spawn options.

**Lifecycle.** `apps/server/src/provider/Layers/ProviderService.ts:218-228`:
`prepareMcpSession` issues (revoking any prior thread credential first,
`McpSessionRegistry.ts:225-232`) and calls `setMcpProviderSession`;
`clearMcpSession` revokes and clears. Every turn calls
`touchActiveMcpThread` (`:703`), with the comment that the credential _"is minted
once at session start and cannot be rotated into an already-spawned agent
process"_ (`:699-702`).

**Injection, per driver — all five already do it:**

| Driver   | Site                                              | Mechanism                                                                                                                                                       |
| -------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude   | `provider/Layers/ClaudeAdapter.ts:4175,4200-4212` | query option `mcpServers: { devgame: {type:"http", url, headers:{Authorization}} }`                                                                             |
| Codex    | `provider/Layers/CodexAdapter.ts:1665,1680-1696`  | env `DEVGAME_MCP_BEARER_TOKEN` + `appServerArgs: ["-c","mcp_servers.devgame.url=…","-c",'mcp_servers.devgame.bearer_token_env_var="DEVGAME_MCP_BEARER_TOKEN"']` |
| Cursor   | `provider/Layers/CursorAdapter.ts:535,543-558`    | ACP `mcpServers: [{type:"http", name:"devgame", url, headers:[{name:"Authorization",…}]}]`                                                                      |
| Grok     | `provider/Layers/GrokAdapter.ts:573,581-595`      | same ACP array shape                                                                                                                                            |
| OpenCode | `provider/Layers/OpenCodeAdapter.ts:1217-1227`    | injected into the OpenCode server config, guarded by `!server.external`                                                                                         |

The shared ACP plumbing is `provider/acp/AcpSessionRuntime.ts:73,571,644`
(`mcpServers?: ReadonlyArray<EffectAcpSchema.McpServer>`).

**This is the answer to HANDOFF §66 Q4 and §17's "strong hypothesis to test":
one canonical tool server across all agents is not a hypothesis in this codebase,
it is shipped infrastructure.** The remaining work for generation is a toolkit,
not a transport. It also answers §16 (how do agents access custom tools) and
constrains §51 vs §52: a _provider_ MCP (Meshy's own) would have to be injected
into the same `mcpServers` slot, which means either replacing the `devgame` entry
or extending each of the five injection sites — five vendor-file edits versus one
new toolkit directory.

### 6.3 The #116 trap: `McpCapability` is one member and the error schema hardcodes it

`apps/server/src/mcp/McpInvocationContext.ts:10`:

```ts
export type McpCapability = "preview";
```

`:26-40`:

```ts
export const requireMcpCapability = Effect.fn("mcp.requireCapability")(function* (
  capability: McpCapability,
) {
  const invocation = yield* McpInvocationContext;
  if (!invocation.capabilities.has(capability)) {
    return yield* new PreviewAutomationUnavailableError({
      capability,
      environmentId,
      threadId,
      providerSessionId,
      providerInstanceId,
    });
  }
  return invocation;
});
```

And the error's own field, `packages/contracts/src/previewAutomation.ts:634-647`:

```ts
export class PreviewAutomationUnavailableError extends Schema.TaggedErrorClass<…>()(
  "PreviewAutomationUnavailableError",
  {
    capability: Schema.Literal("preview"),   // ← line 637
    …
```

**The trap, concretely.** Widening `McpCapability` to `"preview" | "generation"`
makes `requireMcpCapability`'s constructor call ill-typed: it passes a
`"preview"|"generation"` into a field declared `Schema.Literal("preview")`. The
two apparent fixes each have a cost:

- Widen the contract field to `Schema.Literals(["preview","generation"])` — this
  changes a schema that is a member of the `PreviewAutomationError` union
  (`previewAutomation.ts:860`), which is the declared `failure` type of **every**
  preview tool (`toolkits/preview/tools.ts:45,58,72,…`) and is matched by tag in
  `PreviewAutomationBroker.ts:275`. It also edits a vendor contracts file, i.e.
  permanent merge surface. Any client decoding the old literal keeps working
  (widening a literal is decode-compatible), but the _name_ becomes a lie: a
  generation capability failure would surface to the agent as a
  `PreviewAutomationUnavailableError`.
- Introduce a fork-owned `McpCapabilityUnavailableError` and have
  `requireMcpCapability` return it — cleaner, but it changes the error type of the
  one existing call site (`toolkits/preview/handlers.ts:40`), which flows into the
  preview tools' declared `failure` schema. That is the "breaks existing preview
  call sites" the trap warns about.

Also: `McpSessionRegistry.issue` hardcodes `capabilities: new Set(["preview"])`
(`McpSessionRegistry.ts:131`). Every credential currently grants preview and
nothing else, unconditionally. A generation capability needs a decision about
whether it is granted to every agent session by default (simplest, matches today)
or gated per-thread/per-project (needed if HANDOFF §47's permission model —
"Allow paid cloud generation: ask" — is to have any teeth at this layer).

**Recommendation for the architecture doc:** treat the capability widening as its
own small, reviewed change with a red-first test, landed _before_ any generation
tool. Do not let it ride along inside a feature PR — it touches a vendor contract
in the blast radius of the entire preview toolkit.

### 6.4 What the tool handler gets for free

`McpInvocationScope` (`McpInvocationContext.ts:12-19`) carries `environmentId`,
`threadId`, `providerSessionId`, `providerInstanceId`, `capabilities`, `issuedAt`.

**It does NOT carry `projectId` or `workspaceRoot`.** A generation tool needs one
of them (§2). Options, cheapest first: (a) resolve `threadId → projection_threads.project_id
→ projection_projects.workspace_root` through `ProjectionSnapshotQuery` inside the
handler — no contract change, matches the Diff-panel precedent exactly; (b) add
`projectId` to `McpInvocationScope` at mint time in
`McpSessionRegistry.issue` — but `issue` is called from `ProviderService` with only
`{threadId, providerInstanceId}` (`ProviderService.ts:218`), so this needs a
lookup somewhere regardless. **(a) is the smaller change and the one with
precedent.**

---

## 7. Consolidated answers to §66 Q32–39

**32. Does GenerationService use T3's event system?** Partially. Use it for the
durable decisions (requested/settled/asset-recorded/imported/selected); do not use
it for progress. Adding a whole new aggregate kind is ~1,270 lines by the fork's
own measurement (`79097c0e3`); reusing the `project` aggregate avoids all of the
union-widening.

**33. Separate persistence?** Yes for two things: (a) an in-memory project-keyed
registry for in-flight job state, shaped like `SpaceEventsRegistry`; (b) a
projection table for the asset catalog if it needs indexed queries. Secrets go to
`ServerSecretStore`, never to either.

**34. Project-scoped jobs?** Yes, and non-negotiably: `docs/specs/unity-project-scoped-routes.md`
ratifies opaque-`projectId`-in, server-resolves-path. Client-side identity is
`(environmentId, projectId)`.

**35. `GeneratedAsset` ↔ files?** Do **not** reuse `attachmentsDir` as the durable
home — attachment ids are thread-named (`attachmentStore.ts:36-42`) and pruned by
thread (`ProjectionPipeline.ts:107-110`), which violates HANDOFF §72. Use a
project-scoped location and serve it through the existing signed-URL machinery
(`AssetAccess.ts`), extending `AssetResource` (`contracts/assets.ts:7-18`) or
adding a fork-owned signed route. A thread attachment may be published
_additionally_ for inline chat rendering.

**36. Credentials?** `ServerSecretStore` (`<stateDir>/secrets/*.bin`, 0700/0600),
surfaced as `sensitive` settings values with the existing
save-to-secret-store / `valueRedacted` / redact-on-every-wire-exit protocol
(`serverSettings.ts:78-112,316-445`; `ws.ts:992,1477,1488,2039`).

**37. Local generation on project hosts?** By construction — the server is the
execution boundary (`remote.md:12-14`, `overview.md:5-8`). Do not copy the
`PreviewAutomationBroker` inversion.

**38. How much transport should MCP handle?** MCP handles the _agent→harness_
leg, and that leg is already built and wired into all five drivers. The
_harness→provider_ leg should be plain HTTP/SDK inside the server: routing a
provider's own MCP through the agent's `mcpServers` slot means fighting five
injection sites and losing the harness's view of the job (HANDOFF §18's
disadvantage list).

**39. What does our canonical capability layer need?** A second `McpCapability`
member, decoupled from the preview error schema (§6.3); a per-session grant
decision in `McpSessionRegistry.issue`; and `projectId` resolution inside the
handler (§6.4). Everything else — bearer minting, liveness, revocation on session
stop, per-tool annotations, image-bearing tool results — already exists.

---

## 8. Open questions this survey could not close

1. **Worktree vs canonical root for generated files.** Unity routes deliberately
   resolve the canonical root; the Diff panel deliberately prefers
   `worktreePath ?? workspaceRoot`. Writing a generated asset into the repo is
   arguably the Diff case. Undecided — needs an owner ruling.
2. **Extend `AssetResource` vs new fork-owned signed route** (§4.4): smaller code
   vs smaller merge debt.
3. **Capability grant policy** — every MCP credential currently gets `{"preview"}`
   unconditionally (`McpSessionRegistry.ts:131`). Whether generation is granted the
   same way or gated is a product decision with a security consequence.
4. **Dock tab badge support** — HANDOFF §58 wants "Generation ● 1". I did not read
   `reactTabRenderer.tsx` closely enough to say whether a badge slot exists.
5. **Progress-event volume** — no measurement exists of how much traffic a Meshy
   poll loop would add to whichever channel carries it.
6. **Backfill migrations over the event log** — migrations 024/025 appear to do
   backfills; I did not read them, so "can a generation projector be backfilled
   from history" is unverified.
7. **Does `stateDir` get synced or included in any diagnostics bundle?** If yes,
   0600 secret files travel with it. Unchecked.
