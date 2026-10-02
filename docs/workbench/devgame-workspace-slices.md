# DevGame workspace, Kaigen and Mr. Mak slices — post-sync mount map

Step U3 of the 2026-10-02 plan: each planned slice re-mapped from August
paths to the merged source at `codex/upstream-sync-2026-10-02`. Workers start
from this file. Acceptance behavior is unchanged from the plan.

## Server conventions

Nothing in this tree implements any of the planned slices yet. I searched for projectWorkspace, workspace.json, runProfile, RunService, mrmak and kaigen and found no hits. docs/workbench/integration-checkpoint.md:13 also records M3 'PRs 1–8 and M1–M4' as 'Not started'.

The closest existing work to copy:

- The read-only Generation dock panel, which has a route, contract, web fetcher and atom.
- The Unity setup-probe route, cold-start route and command route.
- Upstream project scripts. These are the `devgame.json` "scripts", which run a shell command in a PTY terminal (packages/contracts/src/t3ProjectFile.ts:9,29-35; packages/contracts/src/orchestration.ts:424-448). They do not fit run profiles: they have no argv array, no PID owned by us and no outputs.

ROUTES (mirror these exactly)

- Fork routes are plain `HttpRouter.add` routes, not RPC methods in ws.ts or EnvironmentHttpApi. Templates:
  - apps/server/src/generation/GenerationListRoute.ts:60-168 (read-only, scope check, opaque projectId)
  - apps/server/src/unity/UnitySetupProbeRoute.ts:53-149
- Shape of each route:
  - Authenticate with `EnvironmentAuth.authenticateHttpRequest`, then the two `catchIf` mappings to `failEnvironmentAuthInvalid` / `failEnvironmentInternal` (GenerationListRoute.ts:133-145).
  - Decode the body with `Schema.decodeUnknownEffect(Input)`. A failed decode returns 400.
  - Call an exported `dispatchX(session, input)` that returns `{_tag:'ok', value} | {_tag:'insufficientScope'}`. A missing scope returns 403.
  - Return `HttpServerResponse.json(value)`.
  - Finish with `catchTags({EnvironmentAuthInvalidError, EnvironmentInternalError: HttpServerRespondable.toResponse})` (GenerationListRoute.ts:162-167).
- Project resolution happens on the server. The client sends only `projectId`. `ProjectionSnapshotQuery.getProjectShellById(projectId)` gives `workspaceRoot` (apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts:209-211). Log the lookup failure and map it to `{_tag:'error', message:'Could not resolve project.'}`. Map `Option.none` to 'Project not found.' (GenerationListRoute.ts:75-93).
- The Unity probe deliberately uses the canonical root, never a thread worktree (UnitySetupProbeRoute.ts:93-96).
- Thread to project and worktree, with checkpoints: `getThreadCheckpointContext(threadId)` returns projectId, workspaceRoot, worktreePath and checkpoints (ProjectionSnapshotQuery.ts:52-58,257-259). The cwd rule is `resolveThreadWorkspaceCwd`: worktreePath ?? workspaceRoot (apps/server/src/checkpointing/Utils.ts:12-29).
- Environment selection happens on the client. Each environment is its own server, and the web code picks the `PreparedConnection` for `ScopedProjectRef{environmentId, projectId}` (apps/web/src/generation/generationListAtom.ts:92,164; apps/web/src/dock/GenerationDockPanel.tsx:133-141). A projectId from environment A sent to environment B gets 'Project not found.' That is the isolation guarantee.

MOUNTING

- Add the route layer to `makeRoutesLayer`'s inner `Layer.mergeAll` (apps/server/src/server.ts:727-766, next to `generationListRouteLayer` at :764).
- Ambient services do not need `provideRequest`. Services inside `RuntimeDependenciesLive` (server.ts:648-716) are already available to routes after `HttpRouter.serve` (server.ts:1152-1157); ProjectionSnapshotQuery and EnvironmentAuth already work this way.
- Put new services in that runtime chain:
  - Stateless reader: add to `WorkspaceLayerLive` (server.ts:564-568).
  - Stateful singleton such as RunService: add next to `TerminalLayerLive` at server.ts:648.
- Do not discharge a stateful service per route with `HttpRouter.provideRequest`. Each `provideRequest` builds in a forked memo map, so two routes would get two registries. server.ts:776-815 documents this, and `GenerationServiceRegistrySharing.test.ts` proves it.
- Any new route requirement must also be provided in apps/server/src/server.test.ts. It composes `makeRoutesLayer` at :775 and provides the workspace layers at :728 and mocks at :963.

PATHS AND DEV PROXY

- Single-origin dev proxies only `DEV_PROXIED_PATH_PREFIXES` (packages/shared/src/devProxy.ts:11-35).
- Either put the new routes under `/api/...`, which is already proxied (precedent: `/api/generation-assets/*`, GenerationAssetRoute.ts:327-329), or add a prefix there plus a case in devProxy.test.ts.
- Never hardcode an origin. The web side posts through `postForkEnvironmentRoute` (apps/web/src/lib/forkEnvironmentRoute.ts:1-31), which resolves the remote URL and DPoP itself.

SCOPES (packages/contracts/src/auth.ts)

- `AuthStandardClientScopes` (:178-185) includes orchestration:read and operate, terminal:operate and presence:read. `presence:command` is desktop-owner only (:107,:216-219), so remote and mobile clients never hold it.
- Existing RPC mapping: projects.readFile uses orchestration:read, projects.writeFile uses orchestration:operate, terminal.open uses terminal:operate (apps/server/src/auth/RpcAuthorization.ts:114,117,145).
- Recommendation:
  - Workspace read and import plan: AuthOrchestrationReadScope. GenerationList uses presence:read; either is in the standard set.
  - Run start and stop: AuthTerminalOperateScope, because a terminal can already run anything. presence:command would break remote launch.
  - Import apply: AuthOrchestrationOperateScope.

CONTRACTS

- Wire schemas go in packages/contracts/src/<area>.ts as an Input/Result/PATH trio. The template is packages/contracts/src/generation/index.ts:339-391:
  - `Input = Struct({projectId: ProjectId})`
  - `Result = Union([Success, TaggedStruct('error', {message})])`
  - `PATH` constant next to the schemas.
- Export the file from packages/contracts/src/index.ts (:48-53).
- Web fetcher template: apps/web/src/generation/fetchGenerationList.ts:27-71. It decodes the response and never casts it, and it distinguishes results with `'_tag' in result`.
- Atom template: apps/web/src/generation/generationListAtom.ts:92-170.
- These fetchers exist only on web. Mobile does not call fork routes; record that per-surface decision.

EFFECT SERVICES (docs/internals/effect-services.md)

- One module per service, in this order: errors as `Schema.TaggedError` with a fixed message, then the `Context.Service` tag with its interface inline, then `make`, then `export const layer = Layer.effect(...)`.
- Dependencies come from `yield*`. Consumers import the module as a namespace.
- Transports only decode, call one method, and map errors.
- Templates: apps/server/src/project/T3ProjectFileLoader.ts:24-109 (load a JSON file at the root; missing is `Option.none`; decode through `fromLenientJson`, packages/shared/src/schemaJson.ts:216) and apps/server/src/workspace/WorkspacePaths.ts:92-227.
- knip fails on unused exports, so every new `layer` or export needs an importer in the same PR.

FILESYSTEM SAFETY

- `WorkspacePaths.resolveRelativePathWithinRoot` rejects absolute paths and `..` (WorkspacePaths.ts:107-117,191-224).
- `WorkspaceFileSystem.readFile` adds realpath containment for symlink escapes, a non-blocking open, a not-a-file check, a binary check and a 1 MiB cap with a `truncated` flag (apps/server/src/workspace/WorkspaceFileSystem.ts:31,145-209,212-296).
- Pitfall: an ABSOLUTE `relativePath` bypasses the root check (:149-163). Never pass absolute paths through it.
- Atomic write: `writeFileStringAtomically` writes to a temp file in the same directory, then renames (apps/server/src/atomicWrite.ts:5-25).
- Server state dir: `ServerConfig.stateDir` (apps/server/src/config.ts:35). Precedent for per-project output: `stateDir/generated/<projectId>/...` (apps/server/src/generation/GenerationService.ts:242).

PROCESSES

- `ProcessRunner.run` runs a command to completion and collects its output (apps/server/src/processRunner.ts:20-62). `onStdoutChunk` exposes raw Uint8Array chunks (:29), and there is a `detached` option (:39-51). It is unsuitable for long-lived runs.
- Owned long-lived child template: `opencodeRuntime.startOpenCodeServerProcess` (apps/server/src/provider/opencodeRuntime.ts:663-741):
  - `spawner.spawn(ChildProcess.make(cmd, args, {detached: hostPlatform !== 'win32', cwd, ...}))` inside a scope the service owns (:690-722).
  - A process-group kill, `process.kill(-pid, signal)`, with a win32 fallback (:724-734).
  - SIGTERM, then a grace period, then SIGKILL, registered with `Scope.addFinalizer` (:735-741).
- The terminal manager is PTY and shell only (TerminalOpenInput, packages/contracts/src/terminal.ts:40-48), so it does not fit argv runs. Its kill escalation is at apps/server/src/terminal/Manager.ts:1639-1680.
- `UnityColdStart` only builds an argv; it does not spawn (apps/server/src/editorPresence/UnityColdStart.ts:57-118).

RECEIPTS

- `RuntimeReceiptBus` is for orchestration checkpoints only (apps/server/src/orchestration/Services/RuntimeReceiptBus.ts:1-80). Do not extend it.
- Give each new service its own PubSub-backed `events` Stream and have tests await the typed receipt. Never sleep or poll (AGENTS.md "Verifying").

GIT AND VCS

- `GitVcsDriver.GitVcsDriver.execute({operation, cwd, args, maxOutputBytes, allowNonZeroExit})` returns string stdout (apps/server/src/vcs/GitVcsDriver.ts:43-60,289).
- `listWorkspaceFiles(cwd)` runs `git ls-files --cached --others --exclude-standard -z`, so it honours .gitignore (GitVcsDriver.ts:574-613).
- `filterIgnoredPaths` is defined in the VcsDriver interface (apps/server/src/vcs/VcsDriver.ts:86).
- The `git show rev:path` pattern returns a string (apps/server/src/vcs/GitVcsDriverCore.ts:2623-2637). For binary blobs, use `ProcessRunner` `onStdoutChunk` with `git cat-file blob <oid>` instead.
- Both are ambient in the runtime (server.ts:389-392,1173).

NEW PROJECT

- `NewProject.createNewProjectFolder` claims a folder, writes starter files, inits git and makes the first commit (apps/server/src/project/NewProject.ts:102-140).
- Project registration lives in the ws.ts handler `createNewProject` (apps/server/src/ws.ts:2027-2060) behind `WS_METHODS.projectsCreateNew` (:3301). The client should create the comparison project through this existing RPC, then import into the returned projectId.

PROVIDER SKILL DISCOVERY

- Claude scans `<configDir>/skills` (user scope) and `<cwd>/.claude/skills` (project scope). It does not read `.agents/skills`; this was verified against the CLI (apps/server/src/provider/Drivers/ClaudeSkills.ts:1-13, discoverClaudeSkills :308).
- Codex asks its app-server `skills/list` with `cwds:[cwd]` (apps/server/src/provider/Layers/CodexProvider.ts:449,489-499; parse :299). Codex discovers repo `.agents/skills`.
- Antigravity treats `.agents/skills` as project scope (apps/server/src/provider/Drivers/AntigravitySkills.ts:34-38). Cursor and Grok have their own probes (CursorSkills.ts, GrokSkills.ts:5-12).
- Session cwd is `resolveThreadWorkspaceCwd` (ProviderCommandReactor.ts:715-745), followed by `providerRegistry.refreshWorkspaceSnapshot({instanceId, cwd, fresh})` (apps/server/src/provider/Services/ProviderRegistry.ts:57; Layers/ProviderRegistry.ts:862,947; ws.ts:2657-2662). That method is the server-side way to check discovery for a cwd.

TEST HARNESS

- `@effect/vitest`: `it.layer(TestLayer, {excludeTestServices:true})` plus `it.effect`.
  - Real filesystem: `NodeServices.layer`, temp dirs from `fileSystem.makeTempDirectoryScoped`, and the `symlinksSupported` guard from `@t3tools/shared/testing/symlinks` (apps/server/src/workspace/WorkspaceFileSystem.test.ts:1-60).
  - Dispatch tests: a fake `ProjectionSnapshotQuery` whose every other method `Effect.die`s, a `makeSession(scopes)` helper and an `OrchestrationProjectShell` decoded fixture (apps/server/src/generation/GenerationListRoute.test.ts:36-80).
  - Fake child process: `ChildProcessSpawner.makeHandle({pid, exitCode, isRunning, kill, stdout, stderr, ...})` with `ChildProcessSpawner.make(f)` provided through `Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)` (apps/server/src/processRunner.test.ts:31-80). For delayed exits, see apps/server/src/provider/providerMaintenanceRunner.test.ts:694,773, where `exitCode` waits on a promise the test releases.
- Checks run per file or package only (docs/operations/development.md:99-107):
  - `vp test run <files>`
  - `vp lint <files>`
  - `vp run --filter <pkg> typecheck`, with package names t3 (server), @t3tools/contracts and @t3tools/web.
  - No repo-wide checks.
- Toolchain: ~/.local/share/devgame-toolchain (integration-checkpoint.md:28-30).

EXTERNAL FACTS USED

- Mr. Mak trial at /Users/pieroherrera/Documents/Projects/mr-mak-workspace-trial:
  - workspace/workspace.json has one top-level key, `entities`: 4 entities, all of type 'group'.
  - Step paths are relative to `workspace/<folder>/`. HTML steps link `../_shared/*.css`.
  - .agents/skills: 20 skills, 386 files.
  - .claude/skills: 375 files. The difference is dot-directories such as img2threejs/.github, which `scripts/sync-skills.mjs:15-19` skips along with `__pycache__`, `node_modules` and `*.pyc`/`*.pyo`.
  - Its .gitignore excludes .env*, `**/auth.json`, `**/token(s).json`, `**/credentials.json`, .claude/settings.local.json, .codex/auth.json, .mrmak/, node_modules/, dist/, .cache/, inbox/*, public/workspace, and `**/job.json`, `**/result.json`, `**/upload.json`.
  - The working tree has modified app-code files (desktop/, src/, package.json).
- Kaigen at /Users/pieroherrera/Documents/Projects/Wellness Orbit/KaigenHordeSpike:
  - The binary Runtime/out/macos/debug/kaigen-horde-spike exists. Runtime/out/ and work/ are gitignored.
  - The capture contract is tools/capture_kaigen_vfx.sh:13-90 and Runtime/README.md:65-78.
  - tools/capture_kaigen_transfer_pair.py:26-361 already writes a provenance JSON with the runtime_binary sha256.

## Web conventions

Repo root: /Users/pieroherrera/Documents/Projects/devgame/.claude/worktrees/upstream-sync. All paths below are relative to it. I made no edits.

ALREADY IMPLEMENTED: none of PR3, PR4, PR7, PR8 (web half) or M4. A grep for workspace.json, mrmak, runProfile, kaigen and contextPacket under apps/, packages/ and docs/ finds no code. docs/workbench/integration-checkpoint.md:11 lists "M3 PRs 1–8 and M1–M4: Not started".

DOCK (closest precedent: the Generation panel)

- Panel ids. A panel id that something outside the dock has to open goes in apps/web/src/dock/chatDockHandle.ts:43-67, which already holds DIFF/FILES/TERMINAL/BROWSER. CHAT_PANEL_ID is currently local to ChatDock.tsx:78 and must move to chatDockHandle.ts so "Use in chat" can call openChatDockPanel(CHAT_PANEL_ID). GENERATION_PANEL_ID stays local (ChatDock.tsx:86-97) because nothing opens it from code.
- Registration. Each panel is registered once at module scope: chatDockPanelRegistry.register({ id, title, icon (lucide), component, defaultLocation: "right", singleton: true }) at ChatDock.tsx:387-394. Panels are closeable by default; re-adding a closed panel already works through tabContextMenu.ts:93 ("Add tab"). The types are in dock/lib/types.ts:60-125 (PanelDefinition, PanelProps).
- Preset. Each panel needs its own single-view leaf in buildChatDockPreset (ChatDock.tsx:452-540) plus an entry from presetPanelEntry(id, title) (ChatDock.tsx:442-450).
- Layout migration. lib/layoutMigration.ts:174-200 only grafts a new panel whose leaf has views.length===1. It appends that panel at the END of saved layouts (edge "end", line 197), so existing users see a new panel in the right-most column, wherever it sits in the preset. Never bump CHAT_DOCK_WORKSPACE_ID (ChatDock.tsx:99-155).
- Opening a panel from code: openChatDockPanel(id) / toggleChatDockPanel(id) in chatDockHandle.ts:98-118, which calls lib/openPanel.ts:22-41.
- Default landing panel. ChatDock passes activateOnChangeId={CHAT_PANEL_ID} (ChatDock.tsx:714) to DockviewLayout. It acts only as a FALLBACK: restoreActivePanelForKey (lib/restoreActivePanel.ts:72-94) brings back the thread's remembered panel first, using dockActiveSelectionStore.ts. It fires only when activationKey changes (DockviewLayout.tsx:526-553) and on the initial mount (DockviewLayout.tsx:1098). There is no per-project or per-preset landing concept today; the preset registry has a single preset (ChatDock.tsx:542-558).

HOW PANELS FIND THE PROJECT AND ENVIRONMENT

- Server threads only: useParams + resolveThreadRouteRef (threadRoutes.ts:58), then useThread (state/entities.ts:128) to get projectId and environmentId. Precedent: GenerationDockPanel.tsx:127-143.
- Server and draft threads: useContext(ThreadRouteContext) (dock/ChatPanel.tsx:18, 69), which carries routeKind. Precedent: FilesDockPanel.tsx:37-48 with the pure resolver dock/resolveFilesDockPanelView.ts. For a draft, projectId comes from composerDraftStore getDraftSession(draftId) (composerDraftStore.ts:439-443, store at :4086).
- Project record: useProject(ref) (state/entities.ts:95).
- Game detection: resolveEngineChipState(project) returns "unknown" | "none" | EngineType (components/ChatView.logic.ts:76-110). The wire field is OrchestrationProject.engineType (packages/contracts/src/orchestration.ts:552). The EngineType values are unity, unreal, godot and threejs (packages/contracts/src/project.ts:23).

AUTHENTICATED FETCH FROM THE CLIENT

- Fetchers: postForkEnvironmentRoute({ prepared, path, body, timeoutMs }) (apps/web/src/lib/forkEnvironmentRoute.ts:99-151). It wraps upstream's executeAuthenticatedEnvironmentHttpRequest, handles DPoP and cookie auth, and builds a remote-compatible URL with environmentEndpointUrl. Decode the response with Schema.decodeUnknownEffect; never cast it. Run at runtime.runPromise. Reference fetchers: generation/fetchGenerationList.ts:27-71 (read) and unity/postUnityRaise.ts:15-43 (command).
- Reactive query: generation/generationListAtom.ts:92-167 is a factory atom. It takes preparedConnectionAtom and fetchList as test seams, waits reactively with get.some(preparedConnectionValueAtom) behind a timeout, polls on a module-scope signal (Atom.makeRefreshOnSignal), and adds refreshOnWindowFocus only when typeof window is defined.
- Panel side: useEnvironmentQuery (state/query.ts:26-40) and usePreparedConnection (state/session.ts:16) for httpBaseUrl.
- TRAP: useEnvironmentQuery.data is AsyncResult.value, which returns previousSuccess on Failure (.repos/effect-smol/packages/effect/src/unstable/reactivity/AsyncResult.ts:416-423). After a disconnect, data still holds the last good value, so check error first.

OPENING FILES IN EXISTING SURFACES

- openFileInDock(threadRef, relativePath, line?) (components/ChatMarkdown.tsx:207-210) calls fileExplorerStore.openFile (fileExplorerStore.ts:105) and then openChatDockPanel(FILES_PANEL_ID).
- The Files panel's FilePreviewPanel already previews markdown (FileMarkdownPreview), image, video, audio and PDF, and HTML in a sandboxed iframe with an opaque origin (components/files/FilePreviewPanel.tsx:184-228 and :937-944; BrowserDocumentFrame.tsx:13-40).
- The asset URL resource is keyed by threadId ("workspace-file" or "media-file"), so a draft has nothing to open. Precedent: resolveFilesDockPanelView "draft-empty".
- The Browser panel (browser/openFileInPreview.ts:88-139) works only on desktop (isPreviewSupportedInRuntime). Do not make it the default for reports.

COMPOSER CONTEXT RECORDS (editor selection, already ported)

- Fork-specific kinds travel as UnknownContextRecord, whose payload is capped at 64,000 JSON characters (packages/contracts/src/composerContext.ts:223-236). The provider projection writes the payload JSON for any kind that has an inline reference (packages/shared/src/composerContextReferences.ts:237-290).
- Builder and reader pair: editorPresence/editorSelectionContext.ts:101-220.
- Send side: collectAmbientContextRecords (editorPresence/ambientContext.ts:53-70) feeds buildMessageContext({ ambientRecords }) and appendAmbientContextReferences (lib/composerContextRecords.ts:392-448). It is called at ChatView.tsx:7803-7830 and components/chat/sendQueuedMessage.ts:111-117.
- Read side: extractAmbientMessageContext (ambientContext.ts:90-134) at MessagesTimeline.tsx:2055 and :2288. If an unknown kind is NOT extracted there, the timeline renders it as "Unavailable" (MessagesTimeline.tsx:3965).
- The composer chip row mounts at components/chat/ChatComposer.tsx:6492-6505, using ContextChip (components/ContextChip.tsx:131).

SERVER ROUTES (what the web slices call)

- Route definition: HttpRouter.add("POST", PATH, ...). Authenticate with EnvironmentAuth.authenticateHttpRequest, map credential errors to failEnvironmentAuthInvalid, check the scope, resolve the project with ProjectionSnapshotQuery.getProjectShellById(projectId), and return a success-or-TaggedStruct("error") union. Precedent: apps/server/src/generation/GenerationListRoute.ts:44-129.
- Mounting: apps/server/src/server.ts:751-764, e.g. generationListRouteLayer.pipe(HttpRouter.provideRequest(Live)).
- Scopes: reads use AuthPresenceReadScope; commands use AuthPresenceCommandScope (packages/contracts/src/auth.ts:107, 126).
- Contracts: the *Input / *Result / *_PATH trio lives in packages/contracts/src/<feature>.ts (pattern: generation/index.ts:348-391) and is exported from packages/contracts/src/index.ts after :53. The client sends only the opaque projectId; the server resolves the workspace root.

TEST HARNESS

- apps/web has no DOM environment. Tests use Node vitest, project "unit" (apps/web/vite.config.ts:91-100), files named src/**/*.test.{ts,tsx}.
- AGENTS.md forbids asserting props from static markup, so keep decisions in pure *.ts resolvers (pattern: dock/resolveFilesDockPanelView.ts with its test). Atom tests follow generation/generationListAtom.test.ts:68+ (AtomRegistry.make, fake preparedConnection atom, vi.fn fetchList). Fetcher tests follow generation/fetchGenerationList.test.ts:53-80 (vi.stubGlobal fetch, primaryPreparedConnection from lib/preparedConnectionFixture.ts, a malformed body must reject).
- Dock registration tests follow dock/ChatDock.test.ts:24-48 (vi.mock each heavy panel module, assert registry.get(id) and that preset.build().panels contains the id).
- Use receipts, not sleeps.
- Commands: cd apps/web && pnpm exec vp test run <files>; cd apps/web && pnpm exec tsc --noEmit (contracts: cd packages/contracts && pnpm exec tsc --noEmit). The toolchain is in ~/.local/share/devgame-toolchain. No repo-wide checks.

## Slices

### PR1 — `codex/workspace-reader`

Depends on: green tip. Estimate: ~240 lines.

**Reuse**

- apps/server/src/project/T3ProjectFileLoader.ts:24-109 — template for a service that loads a JSON file from the workspace root: missing is a normal outcome, decode errors are tagged
- packages/shared/src/schemaJson.ts:216 — fromLenientJson(schema) for tolerant JSON decoding (the pattern behind T3ProjectFileFromJson in packages/shared/src/t3ProjectFile.ts:12)
- apps/server/src/workspace/WorkspaceFileSystem.ts:145-296 — readFile({cwd: workspaceRoot, relativePath: 'workspace/workspace.json'}) already handles traversal, symlink realpath containment, non-file and binary checks, and the 1 MiB cap with truncated flag; never pass an absolute path (:149-163)
- apps/server/src/workspace/WorkspacePaths.ts:107-117,191-224 — resolveRelativePathWithinRoot for each `${folder}/${step.path}` under `<root>/workspace`
- apps/server/src/workspace/WorkspaceFileSystem.ts:184-208 — realpath containment logic to mirror for checking that each step file exists (that code is private, so either export a small helper or reproduce the 10 lines)
- packages/shared/src/testing/symlinks.ts — symlinksSupported guard for the symlink-escape test

**Create**

- packages/contracts/src/projectWorkspace.ts — WorkspaceStep{name,path}; WorkspaceEntity{id,title,folder,steps, plus optional type,category,defaultStep,description,status,pinned,sample,created,updated}; WorkspaceManifest{entities}. Unknown keys are ignored on decode. This takes the place of the plan's manifest.ts so PR2 can reuse it on the wire.
- apps/server/src/projectWorkspace/ProjectWorkspace.ts — Context.Service 't3/projectWorkspace/ProjectWorkspace' with readManifest(workspaceRoot): returns 'missing' | 'ok'{entities with each step annotated {relativePath, exists, issue?}, issues[]}, or fails with ProjectWorkspaceManifestError{reason: 'malformed'|'truncated'|'escape'|'read'}. Never writes. Replaces the plan's readManifest.ts.
- apps/server/src/projectWorkspace/ProjectWorkspace.test.ts

**Modify**

- packages/contracts/src/index.ts — add `export * from "./projectWorkspace.ts";` near :53
- apps/server/src/server.ts — add `ProjectWorkspace.layer.pipe(Layer.provide(WorkspaceFileSystemLayerLive), Layer.provide(WorkspacePaths.layer))` to WorkspaceLayerLive (:564-568). Otherwise knip flags the unused `layer` export until PR2.

**Tests**

- apps/server/src/projectWorkspace/ProjectWorkspace.test.ts — copy the it.layer, NodeServices and temp-dir pattern from apps/server/src/workspace/WorkspaceFileSystem.test.ts:20-60. Cases: (1) a fixture shaped like Mr. Mak's 4 real entities decodes, keeping step order and defaultStep; (2) missing workspace/workspace.json returns 'missing', not an error; (3) invalid JSON or a wrong shape returns malformed; (4) an over-1 MiB file returns truncated; (5) a folder or step path with '..' or an absolute path is flagged as an escape and never read; (6) workspace/workspace.json as a symlink to a file outside the root fails, and a step symlinked outside is flagged (both behind symlinksSupported); (7) a missing step file gives exists:false and the read still succeeds; (8) duplicate entity ids are reported as an issue; (9) project isolation: two temp roots, reading A never returns B's entities; (10) a byte-for-byte no-write assertion: the file's mtime and content are unchanged after reading

**Focused checks**

- pnpm exec vp test run apps/server/src/projectWorkspace/ProjectWorkspace.test.ts
- pnpm exec vp run --filter t3 typecheck
- pnpm exec vp run --filter @t3tools/contracts typecheck
- pnpm exec vp lint apps/server/src/projectWorkspace packages/contracts/src/projectWorkspace.ts

**Risks**

- knip: an exported `layer` with no importer fails CI, so either wire it in server.ts in this PR (recommended) or land PR1 and PR2 together.
- WorkspaceFileSystem.readFile skips the root check for absolute paths (WorkspaceFileSystem.ts:149-163). Always pass the literal relative 'workspace/workspace.json'.
- Step paths are relative to workspace/<folder>/, and HTML steps link '../_shared/*.css'. Validate the step file only; do not try to resolve the HTML's own links here (that is M1's link-dependency work).
- Later writers (PR8, M2) must not rewrite the registry by re-encoding the decoded schema, because unknown fields would be dropped. Document on the service that it is read-only.

**Contracts:** New packages/contracts/src/projectWorkspace.ts holds the manifest schemas only (no route yet). It must be Mr. Mak compatible: top-level 'entities'; id, title, type, category, folder, steps[{name,path}], defaultStep, description, status, pinned, sample, created, updated. Only id/title/folder/steps are required; everything else is optional so hand-edited registries still decode.

### PR2 — `codex/workspace-route`

Depends on: PR1. Estimate: ~230 lines.

**Reuse**

- apps/server/src/generation/GenerationListRoute.ts:60-168 — copy line for line: scope check, getProjectShellById, error mapping, HttpRouter.add
- apps/server/src/unity/UnitySetupProbeRoute.ts:53-98 — same split between routing and dispatch, with the canonical-root comment
- packages/contracts/src/generation/index.ts:339-391 — Input/Result/PATH trio shape
- apps/web/src/generation/fetchGenerationList.ts:27-71 — web fetcher through postForkEnvironmentRoute (remote, DPoP and relay aware); decode the response, never cast it
- apps/web/src/generation/generationListAtom.ts:92-170 — atom keyed by ScopedProjectRef{environmentId, projectId} with a reactive wait for the prepared connection
- apps/server/src/generation/GenerationListRoute.test.ts:36-80 — fake ProjectionSnapshotQuery and makeSession helpers

**Create**

- apps/server/src/projectWorkspace/ProjectWorkspaceRoute.ts — dispatchProjectWorkspaceRead(session, projectId) and projectWorkspaceRouteLayer (POST)
- apps/server/src/projectWorkspace/ProjectWorkspaceRoute.test.ts
- apps/web/src/projectWorkspace/fetchProjectWorkspace.ts
- apps/web/src/projectWorkspace/fetchProjectWorkspace.test.ts (copy apps/web/src/generation/fetchGenerationList.test.ts)

**Modify**

- packages/contracts/src/projectWorkspace.ts — add ProjectWorkspaceReadInput{projectId: ProjectId}; ProjectWorkspaceReadSuccess{manifest: null | {entities, issues}} where null means no registry; ProjectWorkspaceReadResult = Union([Success, TaggedStruct('error',{message})]); PROJECT_WORKSPACE_READ_PATH = '/api/project-workspace/read'
- apps/server/src/server.ts — add `projectWorkspaceRouteLayer,` to makeRoutesLayer's inner mergeAll (after :765). No provideRequest is needed: ProjectWorkspace is ambient through WorkspaceLayerLive (:564, merged at :681).
- apps/server/src/server.test.ts — provide ProjectWorkspace.layer next to WorkspaceFileSystem.layer (~:728) so the makeRoutesLayer composition at :775 still typechecks
- packages/shared/src/devProxy.ts:11-35 plus devProxy.test.ts — ONLY if a non-/api path is chosen; under /api no change is needed

**Tests**

- apps/server/src/projectWorkspace/ProjectWorkspaceRoute.test.ts — copy GenerationListRoute.test.ts:36-80. Cases: a session without AuthOrchestrationReadScope gets insufficientScope; an unknown projectId gets 'Project not found.'; a lookup failure gets 'Could not resolve project.' (and is logged); project A's id returns only A's entities while B's workspaceRoot is never read (spy on the roots ProjectWorkspace receives); malformed and truncated registries give {_tag:'error'} with a readable message; a missing registry gives manifest:null
- apps/web/src/projectWorkspace/fetchProjectWorkspace.test.ts — copy apps/web/src/generation/fetchGenerationList.test.ts: decodes success, turns {_tag:'error'} into a typed error, rejects an undecodable body

**Focused checks**

- pnpm exec vp test run apps/server/src/projectWorkspace/ProjectWorkspaceRoute.test.ts apps/web/src/projectWorkspace/fetchProjectWorkspace.test.ts
- pnpm exec vp run --filter t3 typecheck
- pnpm exec vp run --filter @t3tools/web typecheck
- pnpm exec vp run --filter @t3tools/contracts typecheck

**Risks**

- Path prefix: the precedent '/generation/list' needed a devProxy entry (devProxy.ts:27-34). Using '/api/...' avoids that drift trap (GenerationAssetRoute.ts:327-329 shows HttpRouter.add under /api works). Pick one and test it in single-origin dev.
- Scope choice: orchestration:read matches projects.readFile (RpcAuthorization.ts:114); presence:read matches GenerationList. Both are standard scopes.
- Mobile: fork routes are web-only. Record 'not supported on mobile yet' as the deliberate per-surface decision (AGENTS.md 'Hit every surface').
- Agents: no MCP tool in this slice. Note it as a deliberate deferral; the capability already sits in the service, ready for one.

**Contracts:** packages/contracts/src/projectWorkspace.ts gains ProjectWorkspaceReadInput, ProjectWorkspaceReadSuccess, ProjectWorkspaceReadResult and PROJECT_WORKSPACE_READ_PATH. A malformed registry is a visible `{_tag:'error', message}`; a missing registry is success with manifest:null. The environment is chosen by the client's PreparedConnection; the server resolves only the projectId.

### PR3 — `codex/workspace-panel`

Depends on: PR2. Estimate: ~650 lines.

**Reuse**

- apps/web/src/dock/ChatDock.tsx:387-394 — Generation registration shape to copy (singleton, defaultLocation right, closeable by default)
- apps/web/src/dock/ChatDock.tsx:442-540 — presetPanelEntry plus a flat single-view leaf per panel in buildChatDockPreset
- apps/web/src/dock/ChatDock.tsx:714 — activateOnChangeId={CHAT_PANEL_ID}: where the landing-panel fallback goes in (DockviewLayout.tsx:506-553, lib/restoreActivePanel.ts:72-94 restore the remembered panel first, so Workspace only lands threads with no remembered tab)
- apps/web/src/dock/chatDockHandle.ts:43-67,98-107 — shared panel-id constants and openChatDockPanel
- apps/web/src/dock/ChatPanel.tsx:18,69 — ThreadRouteContext (server and draft) for identity; FilesDockPanel.tsx:37-48 explains why
- apps/web/src/state/entities.ts:95,128 — useProject/useThread; apps/web/src/composerDraftStore.ts:439-443 — DraftSessionState.projectId for drafts
- apps/web/src/components/ChatView.logic.ts:76-110 — resolveEngineChipState(project) for game gating
- apps/web/src/lib/forkEnvironmentRoute.ts:99-151 — postForkEnvironmentRoute (auth, DPoP, remote URL)
- apps/web/src/generation/fetchGenerationList.ts:27-71 — decoding fetcher to clone
- apps/web/src/generation/generationListAtom.ts:81-167 — factory atom: reactive connection wait, poll signal, focus refresh
- apps/web/src/state/query.ts:26-40 — useEnvironmentQuery (data keeps previousSuccess on failure)
- apps/web/src/dock/GenerationDockPanel.tsx:145-206 — empty, error-with-retry, loading and list states to mirror
- apps/web/src/components/ChatMarkdown.tsx:207-210 — openFileInDock(threadRef, path, line) opens md/media/html/pdf in the Files panel (FilePreviewPanel.tsx:937-944, BrowserDocumentFrame.tsx:13-40 sandboxed HTML)
- apps/web/src/dock/resolveFilesDockPanelView.ts:1-102 — pure view-resolver pattern (draft-empty, loading, ready; cwd = worktreePath ?? workspaceRoot)
- apps/web/src/dock/ChatDock.test.ts:24-48 — registry/preset test with mocked panels

**Create**

- apps/web/src/projectWorkspace/fetchProjectWorkspace.ts
- apps/web/src/projectWorkspace/fetchProjectWorkspace.test.ts
- apps/web/src/projectWorkspace/projectWorkspaceAtom.ts
- apps/web/src/projectWorkspace/projectWorkspaceAtom.test.ts
- apps/web/src/projectWorkspace/resolveWorkspacePanelView.ts
- apps/web/src/projectWorkspace/resolveWorkspacePanelView.test.ts
- apps/web/src/projectWorkspace/WorkspacePanel.tsx
- apps/web/src/dock/lib/landingPanel.ts
- apps/web/src/dock/lib/landingPanel.test.ts

**Modify**

- apps/web/src/dock/chatDockHandle.ts — add `export const WORKSPACE_PANEL_ID = "workspace"` and move `CHAT_PANEL_ID = "chat"` here from ChatDock.tsx:78, following the comment convention at :43-67
- apps/web/src/dock/ChatDock.tsx — import both ids; register { id: WORKSPACE_PANEL_ID, title: "Workspace", icon: LayoutGrid (or similar lucide), component: WorkspacePanel, defaultLocation: "right", singleton: true } after the Generation registration (:394); add a group-workspace leaf right after the chat leaf in buildChatDockPreset plus a presetPanelEntry(WORKSPACE_PANEL_ID, "Workspace") in panels; in ChatDock(), derive the project (server: useThread then useProject; draft: getDraftSession(draftId).projectId then useProject) and pass activateOnChangeId={resolveDockLandingPanelId(resolveEngineChipState(project))} in place of the constant at :714, plus a small effect that applies the late landing from landingPanel.ts through dockviewLayoutRef.current.openPanel
- apps/web/src/dock/ChatDock.test.ts — add vi.mock("../projectWorkspace/WorkspacePanel") and assert WORKSPACE_PANEL_ID is registered and present in preset.build().panels

**Tests**

- apps/web/src/projectWorkspace/fetchProjectWorkspace.test.ts — copy generation/fetchGenerationList.test.ts:53-80: the body carries only projectId; a malformed body rejects; a typed {_tag:"error"} resolves as the error member
- apps/web/src/projectWorkspace/projectWorkspaceAtom.test.ts — copy generation/generationListAtom.test.ts:68+: atom identity and fetch input are scoped per (environmentId, projectId) (project switch A to B never returns A's data); the connection-wait timeout yields the tagged timeout error
- apps/web/src/projectWorkspace/resolveWorkspacePanelView.test.ts — pattern from dock/resolveFilesDockPanelView.test.ts: no project gives the select-a-thread state; a draft gives cards but opening is disabled with a reason; loading; error present together with previous data gives a stale/error state, never silent ready; manifest null with issue 'missing' gives the empty state; 'malformed' gives a visible error listing the issues; ready orders pinned cards first and maps a step to an openable project-relative path; a step with exists:false shows as missing and cannot be opened
- apps/web/src/dock/lib/landingPanel.test.ts — a concrete EngineType gives WORKSPACE_PANEL_ID; 'none' and 'unknown' give CHAT_PANEL_ID; the late-landing decision applies only when no remembered selection exists for the activation key and Chat is still the active panel
- apps/web/src/dock/ChatDock.test.ts — the Workspace panel is registered and in the default preset

**Focused checks**

- cd apps/web && pnpm exec vp test run src/projectWorkspace/fetchProjectWorkspace.test.ts src/projectWorkspace/projectWorkspaceAtom.test.ts src/projectWorkspace/resolveWorkspacePanelView.test.ts src/dock/lib/landingPanel.test.ts src/dock/ChatDock.test.ts src/dock/lib/layoutMigration.test.ts src/dock/lib/restoreActivePanel.test.ts
- cd apps/web && pnpm exec tsc --noEmit

**Risks**

- The landing panel can resolve late. activateOnChangeId is read only when activationKey changes (DockviewLayout.tsx:526-553; the mount effect's closure is fixed with deps [workspaceId, presetId] at :1320). While the project is loading engineChipState is 'unknown', so the first open of a game thread lands on Chat unless ChatDock re-applies the landing once the state resolves. Do not fold engine state into activationKey: that key also indexes dockActiveSelectionStore.
- Existing saved layouts get Workspace grafted as the right-most column (layoutMigration.ts:197, edge 'end'), not next to Chat. Only new or reset layouts see the preset position. Do not tab it into the chat group either: a multi-view leaf cannot be migrated (layoutMigration.ts:183-186).
- On draft threads files cannot be opened, because the asset/Files surfaces need a server threadId (FilePreviewPanel.tsx:184-200). Show the reason instead of a dead button.
- Worktree threads: the Files panel resolves relative paths against thread.worktreePath ?? workspaceRoot (resolveFilesDockPanelView.ts), but the manifest is read from the project root. A step file that exists only at the root, or is uncommitted, may show as missing in a worktree thread.
- useEnvironmentQuery keeps previous data on failure. A reload or reconnect must show an error banner over stale cards, not present them as live.
- Polling: use focus refresh, a manual refresh, and at most a slow poll (around 10s) on the module signal that only ticks while mounted. AGENTS.md calls out websocket and repaint cost, and it forbids pulsing or animate-ping status dots.
- No DOM test infrastructure exists, and static-markup prop assertions are banned, so WorkspacePanel.tsx must stay thin over resolveWorkspacePanelView.
- Mobile has no dock. Record 'not supported on mobile' as the decision under 'hit every surface'.

**Contracts:** Web adds none. It consumes PR2's packages/contracts/src/projectWorkspace.ts: PROJECT_WORKSPACE_READ_PATH (suggested "/project-workspace/read"); ProjectWorkspaceReadInput = { projectId: ProjectId }; ProjectWorkspaceReadResult = Union[Success{ manifest: { entities: Entity[] } | null, issues: { kind: "missing"|"malformed"|"escape", message }[] }, TaggedStruct("error", { message })]. Entity = { id, title, type, category, folder, steps: { name, path /* project-relative, server-validated */, exists: boolean }[], defaultStep, description, status, pinned, sample, created, updated }. It must be exported from packages/contracts/src/index.ts after :53. A missing or malformed manifest must be a success-with-issues result, not an error, so the panel can tell 'no workspace here' apart from 'server failed'.

### PR4 — `codex/workspace-context`

Depends on: PR3. Estimate: ~450 lines.

**Reuse**

- apps/web/src/editorPresence/editorSelectionContext.ts:101-220 — fork-kind UnknownContextRecord build/read pair, fixed contextId, field clamp, payload budget below the 64k bound, truncatedCount
- apps/web/src/editorPresence/ambientContext.ts:53-70 — collectAmbientContextRecords (send side) and :90-134 extractAmbientMessageContext (read side)
- apps/web/src/lib/composerContextRecords.ts:392-448 — appendAmbientContextReferences plus buildMessageContext({ ambientRecords }) with de-duplicated ids
- apps/web/src/components/ChatView.tsx:7803-7830 and apps/web/src/components/chat/sendQueuedMessage.ts:111-117 — the two send paths that already carry ambient records
- apps/web/src/components/chat/ChatComposer.tsx:6492-6505 — fork chip-row mount slot (EditorPresenceChips)
- apps/web/src/editorPresence/EditorPresenceChipRow.tsx and apps/web/src/components/ContextChip.tsx:131 — ContextChip/ContextChipLabel pill
- apps/web/src/components/chat/MessagesTimeline.tsx:2055,2288 — where ambient records are pulled out and rendered as their own chips (otherwise they render as 'Unavailable', :3965)
- packages/contracts/src/composerContext.ts:223-236 — UnknownContextRecord, payload of 64,000 JSON chars or less
- packages/shared/src/composerContextReferences.ts:237-290 — provider projection writes the unknown-kind payload as JSON for every provider
- apps/web/src/dock/chatDockHandle.ts:186-239 — thread-keyed cross-dock pattern (scopedThreadKey); a loud no-op on mismatch
- @t3tools/shared/composerContextReferences sanitizeComposerContextLabel (used at editorSelectionContext.ts:173)

**Create**

- apps/web/src/projectWorkspace/contextPacket.ts
- apps/web/src/projectWorkspace/contextPacket.test.ts
- apps/web/src/projectWorkspace/workspacePacketStore.ts
- apps/web/src/projectWorkspace/workspacePacketStore.test.ts
- apps/web/src/projectWorkspace/WorkspacePacketChip.tsx
- apps/web/src/projectWorkspace/WorkspacePacketMessageChip.tsx

**Modify**

- apps/web/src/editorPresence/ambientContext.ts — collectAmbientContextRecords gets an optional `workspacePacket` record. Push it BEFORE the engine record, and outside the `engineChipState === "none"` early return at :59. isAmbientRecord (:90) also recognizes readWorkspacePacketRecord. AmbientMessageContext returns `workspacePacket`.
- apps/web/src/components/ChatView.tsx:7803 — read the staged packet for this threadRef, but only if packet.projectId === activeProject.id. Pass it to collectAmbientContextRecords, and clear it from workspacePacketStore after dispatch succeeds.
- apps/web/src/components/chat/sendQueuedMessage.ts:111 — same input. The packet is snapshotted when the message is queued, not when it is sent.
- apps/web/src/components/chat/ChatComposer.tsx:~6505 — mount <WorkspacePacketChip threadRef=...> beside EditorPresenceChips (shows label, missing-ref warning, remove ×)
- apps/web/src/components/chat/MessagesTimeline.tsx:2288 — render <WorkspacePacketMessageChip packet={ambientContext.workspacePacket}/>
- apps/web/src/projectWorkspace/WorkspacePanel.tsx — a 'Use in chat' action on a card or step: build the packet, stage it in workspacePacketStore under the ThreadRouteContext thread, then openChatDockPanel(CHAT_PANEL_ID)

**Tests**

- apps/web/src/projectWorkspace/contextPacket.test.ts — pattern from editorPresence/editorSelectionContext.test.ts: build from a manifest entity gives a record with kind 'workspace-packet' whose JSON is at most the budget; an oversized brief or path list is clamped and truncatedCount is set; refs whose step exists:false go to missingRefs and are not dropped silently; the payload carries paths only, never file contents or skill bodies; read(build(x)) round-trips; read returns null for other kinds or a malformed payload
- apps/web/src/projectWorkspace/workspacePacketStore.test.ts — staging is keyed by scopedThreadKey (thread A's packet never shows for thread B); clear removes only that thread's packet; replacing with a new packet overwrites
- apps/web/src/editorPresence/ambientContext.test.ts (extend) — the packet is included even when engineChipState is 'none'; it is excluded when packet.projectId differs from the thread's project; extractAmbientMessageContext strips its inline reference from the text and returns it as workspacePacket
- packages/shared/src/composerContextReferences.test.ts:159 pattern (optional extend) — the provider projection of a 'workspace-packet' reference emits the JSON payload once

**Focused checks**

- cd apps/web && pnpm exec vp test run src/projectWorkspace/contextPacket.test.ts src/projectWorkspace/workspacePacketStore.test.ts src/editorPresence/ambientContext.test.ts src/editorPresence/editorSelectionContext.test.ts src/lib/composerContextRecords.test.ts
- cd apps/web && pnpm exec tsc --noEmit

**Risks**

- Only the ambient path makes a fork kind visible in the transcript. Outside it, MessagesTimeline renders unknown kinds as 'Unavailable' (:3965), so the extraction change is required, not cosmetic.
- collectAmbientContextRecords returns [] for non-game projects (:59). The packet must bypass that gate, or 'Use in chat' silently does nothing on a non-game project that has a workspace.
- Queued messages: sendQueuedMessage collects ambient records at dequeue time. Snapshot the packet at enqueue time, or a later packet staged for the same thread rides on the wrong message.
- Project isolation: check packet.projectId against the thread's project at send time, the same rule as task #71 for editor selection.
- 'No hidden skill import': the packet lists reference paths for the agent to read. Never inline file bodies, and never touch .agents/skills.
- The 'current run summary' needs PR6/PR7 data. Leave runSummary null until PR7 lands, so PR4 does not depend on PR6.

**Contracts:** None. The packet is UnknownContextRecord kind "workspace-packet" with a fixed contextId "workspace-packet_current" (one per message, like editorSelectionContext.ts:101-103). Payload: { version: 1, projectId, entityId, title, brief (clamped), referencePaths: string[] (project-relative only, never file contents), acceptedVersion?: string | null, runSummary?: { runId, profileId, state, exitCode? } | null, missingRefs: string[], truncatedCount }, bounded to about 16k chars.

### PR5 — `codex/kaigen-profiles`

Depends on: PR1. Estimate: ~220 lines.

**Reuse**

- apps/server/src/project/T3ProjectFileLoader.ts:24-109 — loader shape for a root-level JSON file
- packages/contracts/src/t3ProjectFile.ts:9,18-35 — fork-owned project-file conventions (devgame.json, trimmed non-empty strings with annotations). Do NOT add runProfiles to devgame.json: that schema is upstream-shared and published.
- apps/server/src/workspace/WorkspacePaths.ts:191-224 — containment for executable and cwd; plus a realpath check like WorkspaceFileSystem.ts:172-208 so a symlinked executable cannot escape
- apps/server/src/editorPresence/UnityColdStart.ts:95-130 — precedent for a pure launch-plan/argv builder kept apart from spawning
- /Users/pieroherrera/Documents/Projects/Wellness Orbit/KaigenHordeSpike/tools/capture_kaigen_vfx.sh:54-72 — capture contract: build only when --no-build is absent (:54-56); cd Runtime; exec ./out/macos/debug/kaigen-horde-spike --vfx --commands '<timeline>' (:69-72); timeline (:58-67)

**Create**

- packages/contracts/src/projectRuntime.ts — RunProfile{id, name, executable (root-relative), args: Array(String) (literal, never interpolated), cwd (root-relative, default '.'), outputs: Array({kind: 'image'|'log'|'file', path: root-relative}), evidence?: {logPatterns: Array(String)}}; RunProfilesFile{version: Literal(1), profiles}; RUN_PROFILES_FILE_NAME = 'devgame.runtime.json'
- apps/server/src/projectRuntime/RunProfiles.ts — Context.Service 't3/projectRuntime/RunProfiles': load(workspaceRoot) gives profiles plus per-profile validation; resolve(workspaceRoot, profileId) gives a LaunchPlan{absExecutable, args, absCwd, outputs}. Typed errors: RunProfileNotFound, RunProfileExecutableMissing, RunProfileExecutableNotExecutable, RunProfilePathEscape, RunProfilesMalformed. Replaces the plan's runProfile.ts.
- apps/server/src/projectRuntime/RunProfiles.test.ts
- apps/server/src/projectRuntime/**fixtures**/kaigen-horde-spike.devgame.runtime.json — example with two profiles: (a) 'vfx-arena': executable 'Runtime/out/macos/debug/kaigen-horde-spike', cwd 'Runtime', args ['--vfx'], outputs []; (b) 'vfx-capture-fire-front-0.65': same executable and cwd, args ['--vfx','--commands','0.30:key_down:1;0.36:key_up:1;0.40:key_down:Space;0.46:key_up:Space;0.47:key_down:Z;0.49:key_up:Z;0.50:vfx_capture_hold:0.65;0.55:key_down:R;0.61:key_up:R;1.5500:vfx_capture_probe;1.6500:screenshot:../work/devgame-captures/fire-front-t00_65.png:full;2.4500:quit'], outputs [{kind:'image', path:'work/devgame-captures/fire-front-t00_65.png'}], evidence.logPatterns ['VFX capture probe:.*effect age 0\.65(,|$)', 'screenshot saved:']. Neither profile calls Runtime/hz/hzbuild.

**Modify**

- packages/contracts/src/index.ts — export ./projectRuntime.ts
- apps/server/src/server.ts — add RunProfiles.layer to WorkspaceLayerLive (:564) or alongside PR6's RunService, so knip sees an importer

**Tests**

- apps/server/src/projectRuntime/RunProfiles.test.ts — temp-dir harness from WorkspaceFileSystem.test.ts:20-60. Cases: the fixture decodes and keeps args byte-for-byte (including ';', ':', spaces and '$HOME'); an executable or cwd that is absolute or contains '..' gives PathEscape; an executable symlinked outside the root gives PathEscape (symlinksSupported); a missing executable gives ExecutableMissing (the profile still lists, flagged invalid); a non-executable file (mode 0644) gives NotExecutable; an unknown profileId gives NotFound; a missing devgame.runtime.json gives an empty list, not an error; a malformed file gives a typed error; the resolved plan contains no shell, no 'sh -c', and no hzbuild/install step (assert absExecutable equals the profile executable exactly)

**Focused checks**

- pnpm exec vp test run apps/server/src/projectRuntime/RunProfiles.test.ts
- pnpm exec vp run --filter t3 typecheck
- pnpm exec vp run --filter @t3tools/contracts typecheck

**Risks**

- Literal args mean the capture output path is fixed in the profile, so each run overwrites the same PNG. PR8 must hash and copy artifacts per run.
- Whether Kaigen's `screenshot:<path>` accepts a path relative to cwd (Runtime) is unverified. The helper always passes an absolute path (capture_kaigen_vfx.sh:47-50). Verify in the one real native run, or allow one documented `${projectRoot}` token (which contradicts 'literal args'; needs a decision).
- Writing devgame.runtime.json into the Kaigen repo is a change to a different repository. Keep the example as a DevGame fixture; the orchestrator decides whether to copy it there.
- Do not reuse upstream project scripts (orchestration.ts:424-448). They are shell strings in a PTY terminal and cannot meet the argv-array, owned-PID and outputs acceptance.

**Contracts:** New packages/contracts/src/projectRuntime.ts with the RunProfile and RunProfilesFile schemas (decoded through fromLenientJson), plus the fork-owned file name 'devgame.runtime.json' at the project root, a sibling of devgame.json. No route in this slice.

### PR6 — `codex/kaigen-runner`

Depends on: PR5. Estimate: ~420 lines.

**Reuse**

- apps/server/src/provider/opencodeRuntime.ts:663-741 — owned long-lived child: spawn with detached (process group) inside a scope the service owns; process.kill(-pid) group kill with a win32 fallback (:724-734); SIGTERM then grace then SIGKILL as a Scope finalizer (:735-741)
- apps/server/src/provider/opencodeRuntime.ts:590-640 — stdout/stderr stream consumption alongside child.exitCode
- apps/server/src/terminal/Manager.ts:1639-1680 — kill escalation with logged signal errors
- apps/server/src/config.ts:35 plus apps/server/src/generation/GenerationService.ts:242 — per-project state dir precedent; use stateDir/runs/<projectId>/<runId>/run.log
- apps/server/src/editorPresence/UnityColdStartRoute.ts:85-215 and apps/server/src/unity/UnityCommandRoute.ts:55-80 — route shape for a mutating engine action
- apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts:52-58,257-259 — getThreadCheckpointContext to check that an optional threadId belongs to projectId
- apps/server/src/processRunner.test.ts:31-80 and apps/server/src/provider/providerMaintenanceRunner.test.ts:694,773 — fake ChildProcessSpawner and handle; exitCode waits on a promise the test releases (early exit, still running)

**Create**

- apps/server/src/projectRuntime/RunService.ts — Context.Service 't3/projectRuntime/RunService'. Methods: start({projectId, profileId, threadId?}), stop({projectId, runId}), list(projectId) returning runs with a bounded log tail, and events (a Stream of RunReceipt: started | launchFailed | exited{code} | stopped | logAppended{bytes}). The registry is a Ref<Map<runId, OwnedRun{handle, pid, scope, projectId, profileId}>>. Each run gets Scope.fork(serviceScope), never the request's scope.
- apps/server/src/projectRuntime/RunService.test.ts
- apps/server/src/projectRuntime/RunRoute.ts — three thin POST routes: /api/project-runtime/start, /stop, /status. Each authenticates, resolves the project, checks scope, then calls one RunService method.
- apps/server/src/projectRuntime/RunRoute.test.ts

**Modify**

- packages/contracts/src/projectRuntime.ts — RunStartInput{projectId, profileId, threadId?}; RunStopInput{projectId, runId}; RunStatusInput{projectId}; RunState{runId, profileId, threadId|null, status: 'starting'|'running'|'exited'|'stopped'|'launchFailed', pid|null, exitCode|null, startedAt, endedAt|null, logTail}; RunStatusSuccess{profiles: [{id, name, valid, issue?}], runs}; the three Result unions and the PATH constants
- apps/server/src/server.ts — RunService.layer added to the RuntimeCoreDependenciesLive chain beside TerminalLayerLive (:648), so there is one instance whose finalizer kills owned groups at server shutdown. Add `runStartRouteLayer, runStopRouteLayer, runStatusRouteLayer` to makeRoutesLayer (:727-766) WITHOUT provideRequest.
- apps/server/src/server.test.ts — Layer.mock(RunService.RunService) or the real layer with a fake spawner (~:963)

**Tests**

- apps/server/src/projectRuntime/RunService.test.ts — fake spawner from processRunner.test.ts:31-80. Await receipts from `events`, never sleep. Cases:
  (1) start records the pid at spawn and emits started; status shows running.
  (2) A duplicate start of the same project and profile while running returns alreadyRunning with the existing runId; spawn is called once.
  (3) Spawn PlatformError (ENOENT) gives launchFailed and nothing left in the registry.
  (4) An early exit (exitCode resolves immediately with 3) gives exited{3}, never shows running afterwards, and keeps the log.
  (5) stop sends kill to that handle only (record kill calls on the fake), then emits stopped.
  (6) stop with an unknown runId, or a runId from another project, gives NotOwned and calls no kill.
  (7) Interrupting the fiber that called start, i.e. a client disconnect, does NOT kill the child.
  (8) Closing the service layer scope kills every owned run (shutdown cleanup).
  (9) Log chunks are appended to stateDir/runs/<projectId>/<runId>/run.log, and the tail is bounded.
  (10) A threadId from another project is rejected.
- apps/server/src/projectRuntime/RunRoute.test.ts — copy GenerationListRoute.test.ts:36-80: missing AuthTerminalOperateScope gives insufficientScope; unknown project gives 'Project not found.'; an invalid profile shows up in status with valid:false

**Focused checks**

- pnpm exec vp test run apps/server/src/projectRuntime/RunService.test.ts apps/server/src/projectRuntime/RunRoute.test.ts
- pnpm exec vp run --filter t3 typecheck
- pnpm exec vp run --filter @t3tools/contracts typecheck

**Risks**

- Scope ownership is the main trap. Spawning inside the HTTP request's scope kills the game when the request ends, and a provideRequest-built RunService gives each route its own registry (server.ts:776-815). Make it ambient through the runtime layer and fork a scope from the service per run.
- AGENTS.md rule 1: never find a process by name or pattern. Stop and cleanup act only on handles in the registry, using the pgid captured at spawn. After a server restart the registry is empty: report previous runs as unknown or absent, never as running, and never adopt a PID.
- Use detached:true so a group kill reaches children. Do not use resolveSpawnCommand's shell wrapping; spawn the absolute executable with shell:false.
- Scope: terminal:operate keeps remote and relay launch working; presence:command is desktop-only (auth.ts:107,216-219). This is a product decision, so flag it.
- Effect ChildProcess stdout must be drained continuously, or a chatty game blocks on a full pipe.

**Contracts:** packages/contracts/src/projectRuntime.ts gets the start, stop and status Input/Result/PATH trios under /api/project-runtime/*. Receipts stay inside the server (service PubSub); the client polls /status, like generationListAtom's 5 s poll. A live WebSocket, as in SpaceEventsRoute.ts, is out of scope.

### PR7 — `codex/kaigen-panel`

Depends on: PR3, PR6. Estimate: ~550 lines.

**Reuse**

- apps/web/src/generation/fetchGenerationList.ts:27-71 — status read fetcher to clone
- apps/web/src/unity/postUnityRaise.ts:15-43 — command POST fetcher to clone for start/stop (decoded result, generous timeout)
- apps/web/src/generation/generationListAtom.ts:81-167 — polled status atom (poll signal only while mounted, connection wait)
- apps/web/src/lib/forkEnvironmentRoute.ts:99-151 — authenticated POST
- apps/web/src/state/query.ts:26-40 — useEnvironmentQuery: check `error` before `data` (previousSuccess trap)
- apps/web/src/state/session.ts:16 — usePreparedConnection (Option.none means offline or not ready)
- apps/web/src/components/ChatView.logic.ts:76-110 — resolveEngineChipState for the 'not a game / no engine' state
- apps/web/src/dock/ChatDock.tsx:387-394,442-540 — registration and preset leaf
- apps/web/src/dock/chatDockHandle.ts:43-67 — panel id constants
- apps/web/src/dock/GenerationDockPanel.tsx:38-80 — status pill and token palette (drop the animate-ping pulse; AGENTS.md bans continuous repaint)
- apps/web/src/components/ChatMarkdown.tsx:207 — openFileInDock for opening a run's output or log file in Files

**Create**

- apps/web/src/projectRuntime/fetchRuntimeStatus.ts
- apps/web/src/projectRuntime/fetchRuntimeStatus.test.ts
- apps/web/src/projectRuntime/postRuntimeCommand.ts
- apps/web/src/projectRuntime/postRuntimeCommand.test.ts
- apps/web/src/projectRuntime/runtimeStatusAtom.ts
- apps/web/src/projectRuntime/runtimeStatusAtom.test.ts
- apps/web/src/projectRuntime/resolveRuntimePanelView.ts
- apps/web/src/projectRuntime/resolveRuntimePanelView.test.ts
- apps/web/src/projectRuntime/RuntimePanel.tsx

**Modify**

- apps/web/src/dock/chatDockHandle.ts — add `export const RUNTIME_PANEL_ID = "runtime"`
- apps/web/src/dock/ChatDock.tsx — register { id: RUNTIME_PANEL_ID, title: "Run", icon: Play, component: RuntimePanel, defaultLocation: "right", singleton: true } after the Workspace registration, plus its own single-view leaf and presetPanelEntry in buildChatDockPreset
- apps/web/src/dock/ChatDock.test.ts — mock RuntimePanel; assert it is registered and in the preset

**Tests**

- apps/web/src/projectRuntime/fetchRuntimeStatus.test.ts and postRuntimeCommand.test.ts — copy fetchGenerationList.test.ts:53-80: the body carries only the opaque ids; a malformed body rejects; a typed error resolves
- apps/web/src/projectRuntime/runtimeStatusAtom.test.ts — copy generationListAtom.test.ts: scoped per (environmentId, projectId); waits on the connection reactively; the timeout error is tagged
- apps/web/src/projectRuntime/resolveRuntimePanelView.test.ts — the core truthfulness cases. A query error together with previous data whose state is 'running' gives 'disconnected, last known running at T', and Stop is disabled. Launch is enabled only when a profile is available and run is null or terminal. A pending launch shows 'starting' only after the server receipt, never optimistically. A profile with available:false shows unavailableReason (missing executable). No profiles gives 'no run profile' guidance. engineChipState 'none' gives the not-a-game state. A failed or exited run shows the exit code or failure message. The log tail is capped (client-side line cap).

**Focused checks**

- cd apps/web && pnpm exec vp test run src/projectRuntime/fetchRuntimeStatus.test.ts src/projectRuntime/postRuntimeCommand.test.ts src/projectRuntime/runtimeStatusAtom.test.ts src/projectRuntime/resolveRuntimePanelView.test.ts src/dock/ChatDock.test.ts
- cd apps/web && pnpm exec tsc --noEmit

**Risks**

- useEnvironmentQuery data is previousSuccess on failure (AsyncResult.ts:416-423). A view that reads data.run.state without checking error fakes 'running' while offline, which is exactly the regression the slice forbids.
- Log volume: poll with a cursor and server-side caps. Never re-send the full log on each tick (AGENTS.md performance rule on websocket and HTTP payload size). Poll fast (about 1-2s) only while a run is starting or running, and slow when idle.
- Start and stop need the presence:command scope. A paired client that has read scope only gets a 403 that postForkEnvironmentRoute fails as an undeclared status; show it as 'not permitted', not as a generic error.
- With 9 or more flat columns the default dock is crowded. Runtime must still be its own leaf for migration (layoutMigration.ts:183-186) and lands right-most for existing layouts.
- The Unity Play/Stop toolbar in ChatView (ChatView.tsx:2179-2240) is a different feature: it controls the editor's play mode. Keep the copy and labels distinct so users do not confuse launching the built executable with editor Play.
- Desktop: the same web panel ships. Mobile: no dock, so record 'not supported'.

**Contracts:** Web adds none. It consumes PR6's packages/contracts/src/projectRuntime.ts (export from index.ts). Suggested shape: RUNTIME_STATUS_PATH (read scope), RUNTIME_START_PATH and RUNTIME_STOP_PATH (presence:command scope). Inputs are { projectId, profileId?, runId?, logCursor? }. RuntimeStatusSuccess = { profiles: { id, label, available: boolean, unavailableReason: string | null }[], run: null | { runId, profileId, state: "starting"|"running"|"stopping"|"exited"|"failed", startedAt, endedAt, exitCode, signal, failureMessage, logLines: string[], nextLogCursor } }. Start and stop return the server's receipt (the new run, or the reason for refusal: duplicate, missing executable, not-spawned-by-us). Each Result is a Union with TaggedStruct("error", { message }).

### M1 — `codex/mrmak-import-plan`

Depends on: PR1. Estimate: ~300 lines.

**Reuse**

- apps/server/src/vcs/GitVcsDriver.ts:574-613 — listWorkspaceFiles: git ls-files --cached --others --exclude-standard -z (honours Mr. Mak's .gitignore, so secrets, node_modules, dist, .cache, .mrmak and inbox/* are excluded automatically)
- apps/server/src/vcs/GitVcsDriver.ts:43-60,289 — execute for `rev-parse HEAD`, `status --porcelain=v1 -z -- <roots>`, and `ls-tree -r -l -z HEAD -- <roots>` (blob oid and size for committed content)
- apps/server/src/vcs/VcsDriver.ts:86 — filterIgnoredPaths for explicit exclusion reporting
- apps/server/src/projectWorkspace/ProjectWorkspace.ts (PR1) — parse workspace/workspace.json to list cards and steps as link dependencies
- apps/server/src/workspace/WorkspaceFileSystem.ts:172-208 — realpath containment for symlink escapes
- /Users/pieroherrera/Documents/Projects/mr-mak-workspace-trial/scripts/sync-skills.mjs:14-27 — the skill-copy exclusion rule (dot-entries, **pycache**, node_modules, _.pyc/_.pyo) that defines the 375-file distribution set

**Create**

- packages/contracts/src/projectImport.ts — MrMakImportPlanInput{sourceProjectId, destinationProjectId?, roots?: subset of ['workspace','projects','context','processes','knowledge','inbox','docs','public','.agents/skills']}; MrMakImportPlan{source:{revision, dirtyPaths}, entries:[{root, relativePath, destinationPath, bytes, sha256, headBlobOid|null, contentFrom:'head'|'worktree', status:'new'|'identical'|'conflict'|'excluded'|'missing'|'escape', reason?}], linkDependencies:[{from, href, resolved|null}], exclusions:[{path, rule}], excludedStores:['provider chat histories (kept in original app)'], totals}
- apps/server/src/projectImport/MrMakImport.ts — Context.Service 't3/projectImport/MrMakImport' with plan(input). It reads only, through git and the filesystem. This is the plan's importPlan.ts; it lives in its own projectImport/ domain folder (or keep apps/server/src/projectWorkspace/importPlan.ts if the orchestrator wants the plan's path).
- apps/server/src/projectImport/MrMakImport.test.ts

**Modify**

- packages/contracts/src/index.ts — export ./projectImport.ts
- apps/server/src/server.ts — add MrMakImport.layer to the runtime chain (WorkspaceLayerLive :564 or next to :681) so knip sees it

**Tests**

- apps/server/src/projectImport/MrMakImport.test.ts — temp git repo built in the test (git init, commit, then dirty some files), using the temp-dir and NodeServices harness from WorkspaceFileSystem.test.ts:20-60. Cases:
  (1) The listed roots are inventoried with sha256 and sizes; .git, node_modules, .cache, .mrmak, dist, src, src-tauri, desktop and package.json are never listed, with exclusion reasons.
  (2) .env, auth.json, token.json and .claude/settings.local.json show up as excluded:secret.
  (3) A tracked file modified in the working tree gets contentFrom 'head', with headBlobOid set and the dirty path listed.
  (4) An untracked file inside a root is reported (included or excluded by policy, never silently).
  (5) A symlink escaping the root gets status 'escape'.
  (6) A workspace.json step whose file is missing gets 'missing' and is visible.
  (7) HTML href '../_shared/report.css' resolves to a link dependency; an absolute or external URL is listed as external.
  (8) Planning against a destination that already holds a file with different content gives 'conflict'.
  (9) ZERO writes: snapshot mtimes, sizes and hashes of source and destination trees, and of `git status`, before and after are identical.
  (10) .agents/skills is counted twice: the full tree, and the sync-skills subset.

**Focused checks**

- pnpm exec vp test run apps/server/src/projectImport/MrMakImport.test.ts
- pnpm exec vp run --filter t3 typecheck
- pnpm exec vp run --filter @t3tools/contracts typecheck

**Risks**

- GitVcsDriver.execute returns decoded string stdout. Use it only for ls-tree, status and rev-parse metadata, never to read blob bytes (binary corruption). M1 needs no content bytes for committed files: blob oid and size from ls-tree, sha256 only for working-tree files.
- The Mr. Mak working tree has modified app code (desktop/, src/). Whitelisting roots excludes it by construction. Report the excluded app-code roots explicitly so the receipt shows the omission is intentional.
- listWorkspaceFiles caps its output (WORKSPACE_FILES_MAX_OUTPUT_BYTES) and returns `truncated`. Treat truncation as a visible plan error.
- Include .mcp.json and .codex/config.toml only as 'sanitized template candidates' in the plan output, never as content (plan: no secrets or Windows paths).

**Contracts:** New packages/contracts/src/projectImport.ts holds the plan input and output. The source is a registered DevGame project (opaque projectId; the Mr. Mak repo is opened as a project, per plan PR1–3), so no host path crosses the wire.

### M2 — `codex/mrmak-content-import`

Depends on: M1. Estimate: ~320 lines.

**As built (2026-10-03), superseding the plan below where they differ**

- `MrMakImport.importContent({plan, destinationRoot, choices})` and `rollbackImport({destinationRoot,
importId})` in apps/server/src/projectImport/importContent.ts. No routes yet (M4-server).
- Everything DevGame writes lives under `<dest>/.devgame/import/`: `staging/<importId>/manifest.json`
  (written before any copy), `staging/<importId>/files/` (staged blobs, moved in by rename),
  `receipt.json` (written last) and `replaced/<importId>/` (any destination copy an import
  replaced). `.devgame/import/.gitignore` ignores `staging/` and `replaced/`; the receipt is committed.
- `importId` hashes the source revision, every planned path and sha256, and the choices. A rerun
  with the same id returns `unchanged` and writes nothing; so does a rerun of the same revision
  that has nothing to write and no changes, whatever its choices. A changed source records `changes`
  (added, modified, removed) against the previous receipt; a file still holding our previous
  copy is `updated`, one the user edited is a `conflict` until `take-source`, and an unchanged
  source file the user edited or deleted stays `kept-local`. Removed source files are never deleted.
- Baseline commit: every run (including an `unchanged` one) runs `git init` if `.git` is missing,
  and until HEAD holds `.devgame/import/receipt.json` makes one commit, "Import Mr. Mak original
  content (DevGame import)", of the receipt and the planned files that still hold the source's
  bytes, with literal pathspecs. So an interrupted or failed baseline is retried. Once it exists,
  later imports are left uncommitted for review.
- Destination safety: the nearest existing folder is resolved through symlinks and checked
  (source, home, its parents, hidden home folders) before any folder is created. Rollback creates
  nothing, and refuses an import whose receipt was already published.
- Bytes are the committed blobs (`git cat-file blob`), verified against the plan's sha256;
  `transforms` is empty. The plan's `executable` (mode 100755) is carried over to the copy.

**Reuse**

- apps/server/src/projectImport/MrMakImport.ts (M1) — the plan is the single input; apply never re-decides what to copy
- apps/server/src/atomicWrite.ts:5-25 — the same temp-then-rename approach for each file write and for the staging manifest
- apps/server/src/processRunner.ts:20-31 — ProcessRunner.run with onStdoutChunk collects raw blob bytes from `git cat-file blob <oid>` when contentFrom is 'head'
- apps/server/src/project/NewProject.ts:102-140 and apps/server/src/ws.ts:2027-2060,3301 — the client creates the NEW comparison project with the existing projects.createNew RPC (folder, git, first commit, project.create), then passes its projectId as the destination
- apps/server/src/vcs/GitVcsDriver.ts:289-306 — commit, if the orchestrator approves making the import a baseline commit

**Create**

- apps/server/src/projectImport/importContent.ts — staged apply. Write `<dest>/.devgame/imports/<importId>/staging.json` (planned entries with expected sha256) BEFORE any copy. Copy each entry only when the destination is absent; identical counts as already done. A destination with different bytes is a conflict and is never overwritten. Record each written path and hash. Finish with `<dest>/.devgame/imports/<importId>/receipt.json`. resume(importId) skips entries already written and verified; rollback(importId) deletes only files whose current hash equals the hash we recorded as written by us.
- apps/server/src/projectImport/importContent.test.ts

**Modify**

- apps/server/src/projectImport/MrMakImport.ts — add applyContent({planId|plan, destinationProjectId}), resume and rollback methods that delegate to importContent.ts
- packages/contracts/src/projectImport.ts — MrMakImportApplyInput, MrMakImportReceipt{importId, sourceRevision, written[], skippedIdentical[], conflicts[], excluded[], completedAt}

**Tests**

- apps/server/src/projectImport/importContent.test.ts — temp source repo plus a temp destination. Cases:
  (1) A fresh apply copies every planned entry with matching sha256; workspace/workspace.json is byte-identical, so card ids, step order and defaultStep are preserved and PR1's reader returns the same entities from the destination.
  (2) A rerun is idempotent: zero writes, everything skippedIdentical.
  (3) A destination file the user added is never deleted; a destination file the user changed becomes a conflict and is left untouched.
  (4) Simulated interruption: fail after N files (inject a failing FileSystem write), then resume completes the rest, and the receipt is written only at the end.
  (5) rollback removes only our recorded writes; a user file in the same directory survives, and so does a file of ours the user has since modified.
  (6) Source and global files are unchanged (hash snapshot).
  (7) A 'head' entry with binary content (PNG bytes) round-trips byte-exact.

**Focused checks**

- pnpm exec vp test run apps/server/src/projectImport/importContent.test.ts apps/server/src/projectImport/MrMakImport.test.ts
- pnpm exec vp run --filter t3 typecheck

**Risks**

- Uncommitted imported files do not appear in worktree-mode threads, because a git worktree checks out HEAD. Decide whether the import ends with a baseline commit. That commit doubles as the 'unchanged original' baseline for comparison; adaptations are later commits.
- ProcessRunner maxOutputBytes and outputMode limit what onStdoutChunk delivers. Set a cap above the largest blob, or stream to a file. Check the 55 MB workspace/ media.
- Keep licenses and notices (LICENSE, THIRD_PARTY_NOTICES.md) when a root references them, and keep licensed game assets referenced rather than copied (plan M2).
- The staging directory lives inside the destination project. Add it to the destination's .gitignore, or commit receipts deliberately; decide which.

**Contracts:** packages/contracts/src/projectImport.ts adds the apply input and receipt schemas. Receipts are files in the destination project (reviewable in git), not database rows.

### M3 — `codex/mrmak-skill-import`

Depends on: M1, M2. Estimate: ~300 lines.

**As built (2026-10-03), superseding the plan below where they differ**

- `MrMakImport.importSkills({plan, destinationRoot, skillChoices?, choices?})` in
  apps/server/src/projectImport/importSkills.ts. It applies the whole M1 plan through M2's engine
  (one import, one receipt, one baseline commit): content entries pass through, `.agents/skills`
  entries go to `<dest>/.agents/skills` complete (dot-entries included), and each sync-skills
  file is added again as a `.claude/skills` entry. Pass it the full plan, not a skills-only one: a
  later import's plan becomes the receipt's file list.
- A source skill whose name a different destination skill already uses (present, not recorded in
  the receipt, not byte-identical) fails with `MrMakSkillImportError` `skill-conflict` before any
  write. `keep-existing` skips it (and is `invalid-choice` for a skill with no such conflict);
  `import-renamed` (default `<name>-mrmak`) moves it and rewrites its own references (frontmatter
  `name:`, `skills/<name>` paths, `/<name>` and `$<name>`); the engine applies the rewrite to the
  blob and lists it in `transforms`. A new name must differ, ignoring case, from every source
  skill, every other active name and every destination skill folder, since APFS folds case.
- After the files land, both trees are checked on disk (`.agents` against the expected hashes,
  `.claude` against `.agents`, SKILL.md links resolved in each copy). The result is
  `receipt.skills`: per skill original and active name, file counts and requirements (paid
  providers, tools, env var names, MCP servers named in any text or code file of the skill up to
  1 MiB, never run), the name map, and `baseline` (every source skill file's unmodified sha256).
- `MrMakImport.verifySkillDiscovery({destinationRoot, expected?})` asks the first enabled,
  installed Claude and Codex instances for a fresh workspace scan of the destination through
  `ProviderRegistry.refreshWorkspaceSnapshot`, and reports discovered, missing and shadowed (found
  outside the project) skills. A snapshot older than the scan (the cache a failed scan leaves) is
  `unavailable`, and with no names to look for it fails with `nothing-to-verify`. `cliSkillProbe` runs the same probes without the registry for the
  live check: Codex through `codex app-server` `skills/list` (argv, no shell), Claude through the
  server's filesystem scan in ClaudeSkills.ts, which was verified against the CLI. The Claude CLI
  itself is not run, so no Claude session or model turn is started.
- Live checks (skipped by default): `DEVGAME_MRMAK_IMPORT_LIVE=1 MRMAK_SOURCE MRMAK_DEST` and
  `DEVGAME_MRMAK_DISCOVERY_LIVE=1 MRMAK_DEST [CODEX_BINARY]` in importSkills.test.ts. On
  2026-10-03 against source 6248c9ec: 20 skills, 391 `.agents/skills` files, 375 `.claude/skills`
  files, 16 agents-only, verified, and identical to the source's own trees (`diff -r`). A rerun
  was `unchanged`, and the Claude scan and Codex each discovered all 20 as project skills.
- Per-provider: Antigravity reads `.agents/skills` (covered by the shared copy). Cursor, Grok and
  OpenCode are not targeted.

**Reuse**

- apps/server/src/projectImport/importContent.ts (M2) — the staged, conflict-safe copy engine; reuse it, do not write a second one
- /Users/pieroherrera/Documents/Projects/mr-mak-workspace-trial/scripts/sync-skills.mjs:1-33 — the materialization rule for .agents/skills to .claude/skills: skip dot-entries, **pycache**, node_modules, _.pyc/_.pyo; never delete recipient-added skills; --check verifies byte equality
- apps/server/src/provider/Drivers/ClaudeSkills.ts:1-13,308 — Claude discovers only <cwd>/.claude/skills for project scope (.agents/skills gives 'Unknown command')
- apps/server/src/provider/Layers/CodexProvider.ts:489-499 — probeCodexSkillsForCwd uses skills/list with cwds:[cwd] (Codex reads repo .agents/skills)
- apps/server/src/provider/Drivers/AntigravitySkills.ts:34-38 — Antigravity also treats .agents/skills as project scope
- apps/server/src/provider/Services/ProviderRegistry.ts:57 and apps/server/src/provider/Layers/ProviderRegistry.ts:862 — refreshWorkspaceSnapshot({instanceId, cwd, fresh:true}) returns per-provider skills (name, path, scope), which is the server-side discovery check
- apps/server/src/checkpointing/Utils.ts:12-29 — the session cwd is the worktree or the workspace root, which decides where skills must exist

**Create**

- apps/server/src/projectImport/importSkills.ts — plan and apply for skills. It copies the COMPLETE .agents/skills tree (386 files today, including img2threejs/.github) into <dest>/.agents/skills, then materializes <dest>/.claude/skills using exactly the sync-skills.mjs rule (375 files today; recount at import) and verifies byte equality. Each skill name already present in the destination needs an explicit per-skill choice, keep-existing or import-as '<name>-mrmak'. A rename rewrites internal references in that skill's own files and records an original-to-active name map in the receipt. It refuses any destination outside the destination project root (no writes to ~/.claude/skills, ~/.codex/skills or ~/.agents/skills).
- apps/server/src/projectImport/importSkills.test.ts

**Modify**

- apps/server/src/projectImport/MrMakImport.ts — add applySkills({importId, conflictChoices}) and verifyDiscovery(destinationProjectId). The latter calls ProviderRegistry.refreshWorkspaceSnapshot for the Codex and Claude instances with cwd set to the destination workspaceRoot.
- packages/contracts/src/projectImport.ts — SkillConflictChoice{skill, action:'keep-existing'|'import-renamed', newName?}; SkillImportReceipt{skills:[{original, active, files, claudeMaterialized, dependencies[]}], equivalence:{verified, differences[]}}; SkillDiscoveryReport{provider, discovered[], missing[]}

**Tests**

- apps/server/src/projectImport/importSkills.test.ts — temp source with 3 small skills (one with scripts/ and references/, one with a .github dot-directory, one with **pycache**). Cases:
  (1) The full .agents tree is copied, dot-directories included; .claude/skills excludes dot-entries, **pycache** and pyc, and equals the source subset byte-for-byte.
  (2) An existing destination skill with the same name and no choice is a conflict error with no writes; keep-existing skips it; import-renamed writes '<name>-mrmak', rewrites the name in its SKILL.md, and records the map.
  (3) A rerun after the user adds a skill does not delete it.
  (4) A forced HOME override pointing at a temp directory shows zero writes there.
  (5) verifyDiscovery against a fake ProviderRegistry gives a report listing missing skills.
  (6) Script and reference relative paths inside each SKILL.md resolve in both copies.

**Focused checks**

- pnpm exec vp test run apps/server/src/projectImport/importSkills.test.ts
- pnpm exec vp run --filter t3 typecheck

**Risks**

- The acceptance criterion 'both providers discover skills in real sessions' cannot be proven by unit tests. refreshWorkspaceSnapshot proves what the providers' discovery probes report. A real Codex and Claude session in the comparison project is a live gate for the orchestrator (AGENTS.md: subagents do not launch servers).
- Worktree-mode threads see only committed skills, so this depends on M2's baseline-commit decision.
- Per-provider decision needed for Cursor, Grok and OpenCode: record 'not targeted' or supported (AGENTS.md 'Providers'). Antigravity picks up .agents/skills for free.
- Paid-provider skills (fal, higgsfield) must show up as listed dependencies only. Importing them must never trigger calls or subscriptions.

**Contracts:** packages/contracts/src/projectImport.ts adds the skill conflict choices, the skill import receipt, and the discovery report.

### M4 — `codex/mrmak-import-ui`

Depends on: PR3, M2, M3. Estimate: ~600 lines.

**Reuse**

- apps/web/src/projectWorkspace/WorkspacePanel.tsx (PR3) — host the Import action and the collection switch, instead of adding another dock column
- apps/web/src/lib/forkEnvironmentRoute.ts:99-151 plus apps/web/src/unity/postUnityRaise.ts:15-43 — dry-run (read) and apply (command) fetchers
- apps/web/src/generation/fetchGenerationList.ts:27-71 — decoding pattern and test shape
- apps/web/src/components/ui/dialog.tsx, alert-dialog.tsx, toggle-group.tsx, table.tsx, badge.tsx — use variants, never restyle with className (AGENTS.md Taste, shadcn/no-restyle lint)
- apps/web/src/components/ChatMarkdown.tsx:207-210 — openFileInDock: imported HTML and markdown render only through Files (sandboxed iframe at FilePreviewPanel.tsx:184-228 / BrowserDocumentFrame.tsx:13-40)
- apps/server/src/generation/GenerationListRoute.ts:44-129 and apps/server/src/server.ts:751-764 — route and mount pattern for the import plan/apply routes that M1 to M3 do not create
- packages/contracts/src/auth.ts:107,126 — presence:command for apply, presence:read for plan

**Create**

- apps/web/src/projectWorkspace/import/fetchImportPlan.ts
- apps/web/src/projectWorkspace/import/fetchImportPlan.test.ts
- apps/web/src/projectWorkspace/import/postImportApply.ts
- apps/web/src/projectWorkspace/import/postImportApply.test.ts
- apps/web/src/projectWorkspace/import/importPlanView.ts
- apps/web/src/projectWorkspace/import/importPlanView.test.ts
- apps/web/src/projectWorkspace/import/ImportDialog.tsx
- apps/web/src/projectWorkspace/workspaceCollections.ts
- apps/web/src/projectWorkspace/workspaceCollections.test.ts
- packages/contracts/src/projectWorkspaceImport.ts
- apps/server/src/projectWorkspace/ImportRoute.ts (only if M1/M2 did not add routes; see risks)

**Modify**

- apps/web/src/projectWorkspace/WorkspacePanel.tsx — an 'Import from Mr. Mak…' action opens ImportDialog; a toggle-group switches between 'Original Mr. Mak' and 'DevGame Adaptation', using workspaceCollections; each card shows a provenance badge (source revision, imported-at)
- packages/contracts/src/index.ts — `export * from "./projectWorkspaceImport.ts"` after :53
- apps/server/src/server.ts:~764 — mount importPlanRouteLayer and importApplyRouteLayer (only if this slice owns the routes)

**Tests**

- apps/web/src/projectWorkspace/import/fetchImportPlan.test.ts and postImportApply.test.ts — fetchGenerationList.test.ts pattern: only opaque ids and the root allow-list are sent; a malformed body rejects; a typed error resolves
- apps/web/src/projectWorkspace/import/importPlanView.test.ts — totals by action; Apply is disabled while any conflict lacks a choice; Apply is disabled when the plan is stale (sourceRevision changed, or the plan is older than the dialog's re-plan); exclusions (.git, node_modules, .cache, .mrmak, dist, secrets) are listed and never become copy rows; skill conflicts are listed separately with an explicit choice; zero entries gives 'nothing to import'
- apps/web/src/projectWorkspace/workspaceCollections.test.ts — entities with provenance.origin 'mrmak-import' go to Original, everything else to Adaptation; ids are preserved; step order is preserved within each collection; an entity without provenance (pre-M2 server) goes to Adaptation

**Focused checks**

- cd apps/web && pnpm exec vp test run src/projectWorkspace/import/fetchImportPlan.test.ts src/projectWorkspace/import/postImportApply.test.ts src/projectWorkspace/import/importPlanView.test.ts src/projectWorkspace/workspaceCollections.test.ts
- cd apps/web && pnpm exec tsc --noEmit
- cd packages/contracts && pnpm exec tsc --noEmit

**Risks**

- Gap in the plan: M1 to M3 define importPlan, importContent and importSkills as services, but no slice adds the authenticated routes the UI needs. Either M2 adds them, or M4 carries a server route file at apps/server/src/projectWorkspace/ImportRoute.ts mounted in server.ts, with presence:read for plan and presence:command for apply.
- Apply writes files, so require an explicit AlertDialog confirmation and the presence:command scope. Never auto-apply after a dry run.
- M2 copies into a NEW comparison project, so the Original collection lives in a different project from the user's current thread. Opening those files from the current thread goes through the 'media-file' absolute-path resource (served on its own, no sibling assets) unless the user switches to a thread in the comparison project.
- HTML from Mr. Mak (public/, docs/) must render only through the existing sandboxed Files preview (opaque origin). Never inline it into the app DOM, and do not route it to the desktop-only Browser panel by default.
- The dialog must show the plan's sourceRevision and re-plan before apply when the source repo moved (M1 reads HEAD blobs when the working tree is polluted). Otherwise the apply-time conflict state differs from what the user reviewed.
- Skill-tree import (M3) affects agent discovery in real sessions. The UI should report project-local .agents/skills and .claude/skills results only, with no action that writes home skill folders.

**Contracts:** packages/contracts/src/projectWorkspaceImport.ts. MRMAK_IMPORT_PLAN_PATH has input { projectId /* destination or source project, opaque _/, roots: string[] /_ allow-listed root names only */ } and result Union[{ plan: { planId, sourceRevision, entries: { root, relativePath, sha256, sizeBytes, action: "copy"|"skip-identical"|"conflict", linkDeps: string[] }[], exclusions: { relativePath, reason }[], skills: { name, files: number, conflict: boolean }[] } }, TaggedStruct("error", { message })]. MRMAK_IMPORT_APPLY_PATH has input { projectId, planId, conflictChoices: Record<relativePath, "keep-destination"|"take-source"> } and returns a completion receipt { receiptId, destinationProjectId, written, skipped, stagingManifestPath } or error. It also needs an additive optional `provenance: { origin: "mrmak-import"|"devgame", sourceRevision, sourcePath, importedAt } | undefined` on the projectWorkspace.ts Entity (written by M2's staging manifest).

### PR8-server — `codex/kaigen-evidence`

Depends on: PR1, PR6. Estimate: ~330 lines.

**As built (2026-10-03), superseding the plan below where they differ**

- The registry is a DevGame-owned sidecar, `<stateDir>/runs/<projectId>/evidence.json`
  (`{version: 1, runs}`), updated by read, append and atomic rename under one lock. Nothing is
  written to the project: `workspace/workspace.json` is never rewritten and no card step is
  appended. A profile links its runs to a card by id with `evidence.workspaceCard`.
- Artifacts are not copied. A profile writes per-run outputs into its own run directory through
  the single `{{runDir}}` substitution (args and output paths); project-relative outputs are
  hashed in place, and one older than the run's start does not count.
- `evidence.build` names the build to fingerprint when the executable is a wrapper (the Kaigen
  CAPTURE profile runs `tools/capture_kaigen_vfx.sh`, so it fingerprints the game binary).
- Freshness (`fresh` / `stale` / `unknown`) is computed on every status read from the current
  HEAD, tracked-file dirty state and build sha256; nothing stores it. A run on uncommitted
  changes is `unknown`, never `fresh`; a clean run goes `stale` once tracked files change.
- A log pattern passes when any log line matches the regex; the literal-prefix line is only used
  to show the wrong value when none does. Only a missing registry reads as empty; any other read
  error refuses to write, and status reports it as `evidenceError`.
- Outputs, the run log and the build are resolved through symlinks at record and read time and
  must stay inside the project or the run's directory.

**Reuse**

- apps/server/src/atomicWrite.ts:5-25 — writeFileStringAtomically (temp file in the same directory, then rename)
- apps/server/src/vcs/GitVcsDriver.ts:43-60,289 — execute(['rev-parse','HEAD']) and statusDetails for the source revision and dirty flag
- apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts:52-58,257-259 — getThreadCheckpointContext for the thread's latest checkpoint ref (checkpoint provenance)
- apps/server/src/checkpointing/Utils.ts:5-10 — checkpointRefForThreadTurn naming
- /Users/pieroherrera/Documents/Projects/Wellness Orbit/KaigenHordeSpike/tools/capture_kaigen_vfx.sh:74-89 — validation to port: PNG present and non-empty, last 'VFX capture probe:' line matches 'effect age <age>(,|$)', 'screenshot saved:' present
- /Users/pieroherrera/Documents/Projects/Wellness Orbit/KaigenHordeSpike/tools/capture_kaigen_transfer_pair.py:26-30,291-327 — provenance precedent (runtime_binary sha256, source hashes)
- apps/server/src/projectWorkspace/ProjectWorkspace.ts (PR1) — registry read, and the step-containment rules any written step must pass

**Create**

- apps/server/src/projectRuntime/RunEvidence.ts — Context.Service 't3/projectRuntime/RunEvidence'. register(runId) runs after the exited receipt: validate outputs and log patterns, sha256 each artifact, then copy artifacts and run.log into a run-specific, gitignored root-relative directory (e.g. work/devgame-runs/<runId>/). Write a small evidence JSON at workspace/<card-folder>/runs/<runId>.json with {schema:'devgame.run-evidence/1', runId, profileId, threadId|null, checkpointRef|null, source:{revision, dirty}, build:{executable, sha256, mtime}, startedAt, endedAt, exitCode, checks:[...], artifacts:[{kind, path, sha256, bytes}]}. Append a step {name, path:'runs/<runId>.json'} to a per-profile card in workspace/workspace.json. readStaleness(evidence) recomputes HEAD, dirty state and executable hash.
- apps/server/src/projectRuntime/RunEvidence.test.ts

**Modify**

- packages/contracts/src/projectRuntime.ts — a RunEvidence schema (versioned 'devgame.run-evidence/1') and an optional `stale` field on the status result
- apps/server/src/projectRuntime/RunService.ts — call RunEvidence.register on exit for profiles that declare outputs or evidence (or expose it as an explicit route action; decide which)
- apps/server/src/server.ts — RunEvidence.layer next to RunService in RuntimeCoreDependenciesLive (:648)

**Tests**

- apps/server/src/projectRuntime/RunEvidence.test.ts — temp git repo plus a fake run record, no real Kaigen. Cases:
  (1) A happy path writes the evidence JSON and a card step; PR1's ProjectWorkspace.readManifest then lists it.
  (2) Missing PNG, or a 0-byte PNG, records a failed check, never a pass.
  (3) A log without the probe line, or a probe 'effect age 0.50' when 0.65 was expected, fails with 'wrong capture age'.
  (4) A truncated or missing run.log is recorded explicitly.
  (5) Registering the same runId twice is idempotent: one step, no duplicate.
  (6) A source commit after the run makes readStaleness report stale:true; changing the executable bytes also gives stale:true.
  (7) No git repo or no HEAD gives provenance 'unknown', never a fabricated revision.
  (8) Unknown fields already in workspace.json, such as a hand-added key, survive byte-for-byte apart from the appended step.
  (9) Two concurrent registers for different runs both land (per-project Semaphore plus atomic write), and no temp files are left behind.

**Focused checks**

- pnpm exec vp test run apps/server/src/projectRuntime/RunEvidence.test.ts apps/server/src/projectWorkspace/ProjectWorkspace.test.ts
- pnpm exec vp run --filter t3 typecheck

**Risks**

- PR1 confines step paths to workspace/<folder>/, so steps cannot point at work/... directly. The evidence JSON inside the card folder carrying root-relative artifact paths resolves this without weakening PR1.
- workspace/workspace.json must be edited as raw JSON (parse, append, stringify). Re-encoding the decoded schema drops fields Mr. Mak or users added.
- KaigenHordeSpike has no workspace/ directory today. The first registration creates tracked files in the game repo; it needs owner sign-off.
- Runtime/out/ is gitignored, so build provenance is the executable's sha256 and mtime, not git. Report a dirty working tree honestly instead of collapsing it to HEAD.
- Fixtures first. The single real native run waits on disk clearance (plan PR8), and per AGENTS.md subagents never launch it.

**Contracts:** The packages/contracts/src/projectRuntime.ts evidence schema is an additive, versioned extension. The registry entry is a normal Mr. Mak card and step whose path points to the evidence JSON inside workspace/<folder>/, so PR1's reader accepts it unchanged. Large PNGs and logs stay in gitignored root-relative paths listed inside the JSON. There is no second index.

### M4-server — `codex/mrmak-import-ui`

Depends on: PR2, M2, M3. Estimate: ~200 lines.

**Reuse**

- apps/server/src/generation/GenerationListRoute.ts:60-168 — route template
- apps/server/src/auth/RpcAuthorization.ts:114,117 — scope precedent: orchestration:read for plan, orchestration:operate for apply (same as projects.writeFile)
- apps/web/src/generation/fetchGenerationList.ts:27-71 — web fetcher template for the panel

**Create**

- apps/server/src/projectImport/MrMakImportRoute.ts — POST /api/project-import/plan, /apply, /status (receipt by importId). Each resolves the source and destination projectIds server-side and calls one MrMakImport method.
- apps/server/src/projectImport/MrMakImportRoute.test.ts
- apps/web/src/projectImport/fetchMrMakImport.ts (the panel itself belongs to the UI scope)

**Modify**

- apps/server/src/server.ts — add the three route layers to makeRoutesLayer (:727-766); no provideRequest, because MrMakImport is ambient
- apps/server/src/server.test.ts — provide or mock MrMakImport (~:728/:963)
- packages/contracts/src/projectImport.ts — the path constants and the Result unions

**Tests**

- apps/server/src/projectImport/MrMakImportRoute.test.ts — missing scope gives 403; a source or destination projectId unknown in this environment gives 'Project not found.'; source equal to destination is rejected (never import into the original); apply requires a destination different from any non-comparison project chosen by the user (no bulk import into HordeSpike)

**Focused checks**

- pnpm exec vp test run apps/server/src/projectImport/MrMakImportRoute.test.ts
- pnpm exec vp run --filter t3 typecheck

**Risks**

- The plan says never pour imported identity or instructions into the active HordeSpike repo. The route must refuse destinations that are not empty new projects unless the user explicitly confirms.
- HTML rendering safety is enforced on the client (isolated report/browser). The server must not add any route that serves imported HTML with app privileges.

**Contracts:** packages/contracts/src/projectImport.ts gets the plan, apply and status Input/Result/PATH trios. Imported HTML is never served through these routes; it opens through the existing isolated browser and preview surface, which is a UI-side decision.

### PR8-web — `codex/kaigen-evidence`

Depends on: PR3, PR7. Estimate: ~250 lines.

**Reuse**

- apps/web/src/projectWorkspace/WorkspacePanel.tsx (PR3) — card rendering where evidence attaches
- apps/web/src/projectWorkspace/resolveWorkspacePanelView.ts (PR3) — extend the pure view with evidence rows
- apps/web/src/components/ChatMarkdown.tsx:207-210 — openFileInDock for artifact paths (images, video and HTML reports render in Files: FilePreviewPanel.tsx:937-944; HTML goes through the sandboxed BrowserDocumentFrame.tsx:13-40)
- apps/web/src/projectWorkspace/contextPacket.ts (PR4) — fill acceptedVersion and runSummary from evidence
- apps/web/src/projectRuntime/RuntimePanel.tsx (PR7) — link from a run to its evidence card, and back

**Create**

- apps/web/src/projectWorkspace/workspaceEvidenceView.ts
- apps/web/src/projectWorkspace/workspaceEvidenceView.test.ts
- apps/web/src/projectWorkspace/WorkspaceEvidence.tsx

**Modify**

- apps/web/src/projectWorkspace/WorkspacePanel.tsx — render <WorkspaceEvidence> under each card when entity.evidence is present
- apps/web/src/projectWorkspace/contextPacket.ts — runSummary and acceptedVersion come from the newest non-stale evidence; stale evidence is labelled stale in the payload
- apps/web/src/projectWorkspace/contextPacket.test.ts — add a case: stale evidence is carried, flagged stale, and never presented as current

**Tests**

- apps/web/src/projectWorkspace/workspaceEvidenceView.test.ts — evidence sorted newest first; stale items carry their staleReason label and are never shown as the accepted version; artifact rows map to openable project-relative paths with the right preview kind; artifacts outside the project are dropped and counted, not opened; missing evidence gives no section (not an empty box)

**Focused checks**

- cd apps/web && pnpm exec vp test run src/projectWorkspace/workspaceEvidenceView.test.ts src/projectWorkspace/contextPacket.test.ts src/projectWorkspace/resolveWorkspacePanelView.test.ts
- cd apps/web && pnpm exec tsc --noEmit

**Risks**

- Artifacts written to a run output directory in a worktree, or outside the project, may not resolve through the Files panel's thread cwd. The server should return project-relative paths only.
- Opening an HTML report must go through openFileInDock (sandboxed, opaque origin). Never use dangerouslySetInnerHTML, and do not default to the Browser panel, which is desktop-only (openFileInPreview.ts:104-112).
- Keep the Mr. Mak card and step format; evidence is an additive versioned field. Do not reshape steps, or M2's preserved ids and step order break.

**Contracts:** Additive and owned by PR8 server: an optional `evidence` array on the projectWorkspace.ts Entity, each item { version: 1, runId, profileId, threadId: ThreadId | null, source: { gitRevision, checkpointRef: string | null, buildId: string | null }, artifacts: { path /* project-relative */, kind: "image"|"video"|"log"|"report"|"other" }[], capturedAt, stale: boolean, staleReason: string | null }. The server computes `stale` (source changed), so the client never infers it. Decode with Schema.optional so a PR3-era server still decodes.
