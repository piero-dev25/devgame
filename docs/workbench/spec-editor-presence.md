# Editor Presence Protocol — Unity selection in the composer

Design from a mapped + adversarially-reviewed pass. Neither critic refuted it.
Line citations in the source design drifted by 1-6 lines throughout; the
substance was verified correct but re-check any exact line before relying on it.

## Recommendation

Build a small, editor-agnostic **Editor Presence Protocol (EPP)** and ship the first slice as a thin vertical: a Unity Editor package (our own UPM package) pushes selection state over a plain-JSON WebSocket to a **new raw WS route on the local T3 server** (our own file, one line of registration), and a **new web-client module** (our own file) renders it as an ambient chip above the composer.

Three verifications changed the design versus the input maps:

1. **`HttpServerRequest.upgrade: Effect<Socket.Socket, HttpServerError>` and `upgradeChannel()` exist** (`/Users/pieroherrera/Projects/t3code-fork/apps/server/node_modules/effect/dist/unstable/http/HttpServerRequest.d.ts:74` and `:134`). A raw, non-RPC WebSocket route is a first-class primitive here. This is the single biggest finding: we do **not** need a new RPC method, a new `WS_METHODS` entry, a new `AuthEnvironmentScope` literal, or any change to `packages/contracts`. The transport lane's "new RPC + new scope" cost estimate was overstated. Route registration is one line at `apps/server/src/server.ts:422`, mirroring `websocketRpcRouteLayer` (`apps/server/src/ws.ts:2108-2170`).

2. **Unity is 6000.3.14f1 with `apiCompatibilityLevel: 6` (.NET Standard 2.1)** (`/Users/pieroherrera/Projects/Deepmind/ProjectSettings/ProjectVersion.txt:1`; `/Users/pieroherrera/Projects/Deepmind/ProjectSettings/ProjectSettings.asset:988`). `System.Net.WebSockets.ClientWebSocket` is available, so **we ship no WebSocket DLL**. Bezi bundles `bezi-websocket-sharp.dll` because their `package.json` declares `"unity": "2018.3"` (`/Users/pieroherrera/Projects/Deepmind/Packages/com.bezi.sidekick/package.json:19`) — a .NET 3.5-era floor we do not have to match. Unity is the WS _client_; it never hosts a socket. That sidesteps the Mono `HttpListener.AcceptWebSocketAsync` problem entirely.

3. **Domain reload fires on every play-mode enter in this project.** `m_EnterPlayModeOptionsEnabled: 1` with `m_EnterPlayModeOptions: 0` (`/Users/pieroherrera/Projects/Deepmind/ProjectSettings/EditorSettings.asset:27-28`) — the toggle is on but neither `DisableDomainReload` (1) nor `DisableSceneReload` (2) is set, so both reloads still happen. The Unity-side socket dies on every script compile **and** every press of Play. Reconnect is the dominant runtime path, not an edge case, which is why Bezi ships four status icons (`connected/connecting/disconnected/paused` under `/Users/pieroherrera/Projects/Deepmind/Packages/com.bezi.sidekick/Editor/Resources/Icons/Light/`). Our status indicator is required in step 1, not deferred.

I also confirmed the receiving lane's caveat: `addElementContext` is defined at `apps/web/src/composerDraftStore.ts:3063` and exercised only by `composerDraftStore.test.ts` — **no live producer anywhere in `apps/web/src`**. The element-context rail is real, tested, persisted, and dead-ended. It is a good _pattern_ to copy and a bad thing to squat: `normalizeElementContextSelection` hard-requires a non-empty `pageUrl` (`apps/web/src/lib/elementContext.ts:73-76`), and `formatElementContextLabel` renders `<tagName>` in angle brackets with a `MousePointerClick` icon (`elementContext.ts:117-120`, `ComposerPendingElementContexts.tsx:1,52`). Squatting it would put `<Player>` behind a mouse cursor and emit a `url:` field that is a lie.

**Architectural call: presence is a level, not an edge, and it is separate from attachment.** The live chip lives in our own store, is replaced wholesale by each push, and is deliberately _not_ persisted to localStorage — a persisted presence chip would resurrect a stale selection on reload. Converting presence into a persisted, prompt-serialized attachment is a distinct, later state. This is not expedience; it is what makes staleness impossible by construction rather than by an expiry check like `isTerminalContextExpired`.

## The protocol

## Editor Presence Protocol (EPP) v1

Transport: WebSocket. Payload: one JSON object per text frame. Two roles on one endpoint, selected by query param:

- `ws://<t3-server>/editor-presence?role=publisher` — the editor plugin (Unity, VS Code, Blender…)
- `ws://<t3-server>/editor-presence?role=subscriber` — the chat client

Auth is transport-level, never in the payload. Both roles authenticate through the existing `EnvironmentAuth.authenticateWebSocketUpgrade` (`apps/server/src/auth/EnvironmentAuth.ts:941-958`), which accepts either `?wsTicket=<t>` (query param, 5-min TTL) or `Authorization: Bearer <token>`. The web client already holds a ticket — its `socketUrl` is literally `ws://127.0.0.1:3777/ws?wsTicket=…` (`packages/client-runtime/src/connection/resolver.test.ts:237`). Unity's `ClientWebSocket.Options.SetRequestHeader("Authorization", …)` sets the Bearer header on the handshake, which browser JS cannot do — so the plugin uses the long-lived bearer path.

### Publisher → server

**`hello`** (first frame, required)

```json
{
  "v": 1,
  "type": "hello",
  "editor": { "id": "unity", "name": "Unity Editor", "version": "6000.3.14f1" },
  "session": { "id": "3f9c2a…" },
  "workspace": { "root": "/Users/piero/Projects/Deepmind" }
}
```

- `editor.id` — lowercase slug. **Open string, not an enum.** A closed union means shipping a release every time someone writes a Blender plugin.
- `session.id` — stable per editor-process launch. The server does last-writer-wins replacement on this key, so a reconnect after domain reload replaces the stale connection instead of duplicating a chip.
- `workspace.root` — absolute path of the project the editor has open. This is the join key against a T3 thread's cwd. Without it you get chips from the wrong project.

**`selection`**

```json
{
  "v": 1,
  "type": "selection",
  "seq": 42,
  "at": "2026-08-03T11:04:07.221Z",
  "items": [
    {
      "id": "GlobalObjectId_V1-2-8f3a…-1345678901234-0",
      "kind": "gameobject",
      "label": "PlayerRoot",
      "path": "Assets/Scenes/Arena.unity",
      "detail": "Arena / Systems / PlayerRoot"
    }
  ]
}
```

- **Full state, never a delta.** Every frame replaces the previous one entirely. This is the most important decision in the protocol: presence is a _level_, so reconnect is just "send current state," the subscriber is stateless, and a dropped frame is self-healing.
- `seq` — monotonic per session; a subscriber drops any frame with `seq` ≤ last seen. Makes reordering harmless.
- `items[].id` — the editor's own durable identifier, **opaque**. Nothing outside the emitting editor ever parses it. Unity uses `GlobalObjectId.GetGlobalObjectIdSlow(obj).ToString()`; VS Code would use a document URI plus range; Blender a datablock name. It exists so a future agent tool can say "resolve this id" back to the editor.
- `items[].kind` — lowercase slug, open string. The client renders it; it never switches on it.
- `items[].label` — **the only field required to render a chip.**
- `items[].path` — workspace-relative path when the item has one, else `null`. This is what makes the item useful to an agent that can read files.
- `items[].detail` — one short secondary line (Unity: hierarchy path or scene). Optional.
- Deselect-to-nothing is `"items": []` — a meaningful state, not a missing message.

**`ping`** → server replies `pong`. Liveness only.

### Server → subscriber

**`presence`** (sent immediately on connect, then on every change)

```json
{ "v": 1, "type": "presence",
  "editors": [
    { "editor": {...}, "session": {...}, "workspace": {...},
      "connected": true, "lastSeenAt": "2026-08-03T11:04:07.221Z",
      "selection": { "seq": 42, "at": "…", "items": [ … ] } } ] }
```

Also full state of every connected publisher, one frame type. The subscriber never accumulates. Sending current state on connect is what makes a chat client that opens _after_ Unity show the chip without waiting for the next click.

The server is a **pure in-memory fan-out with last-known-state retention per session**. Nothing on disk, nothing per thread, no knowledge of what a GameObject is. That is what keeps it small enough to be worth reusing.

### Deliberately left out

- **Deltas and any event log.** Level, not edge. A replayable stream is a different product.
- **Transform, component lists, scene graph, asset bytes, thumbnails, previews.** The chip needs a label; the agent needs a pointer. Anything richer is a _pull_ — an agent tool call keyed on the opaque `id`. Keeping it out is precisely what preserves the push/pull split the owner named, and it keeps frames small enough that a chatty `selectionChanged` costs nothing.
- **Cursor/caret position.** It is the one thing LSP does carry, and including it invites a frame per keystroke. If it is ever needed it becomes its own `type`, not a field on `selection`.
- **Any editor→chat command or request/response.** One direction only. The moment the chat can ask the editor to _do_ something, this stops being a presence channel and every plugin author owes us a command surface.
- **Closed enums for `editor.id` and `kind`.** See above.
- **Auth, tokens, or user identity in the payload.** Transport's job.
- **Per-thread routing.** The protocol carries `workspace.root`; deciding which thread shows the chip is the client's business, not the wire's.

MCP has nothing comparable — its closest concept is `notifications/roots/list_changed` (workspace folders, coarse re-fetch signal), not live selection. This is genuinely new surface, so keeping v1 this small is the whole strategy.

## Steps

### 1. Thin vertical: a real Unity selection appears as a chip

All three tiers, each at its thinnest. UNITY (our own package `com.ironmind.editor-presence`, installed into a throwaway scratch project — never into Deepmind): `[InitializeOnLoad]` static class subscribing `UnityEditor.Selection.selectionChanged`; builds `items[]` from `Selection.objects` using `obj.name` for `label`, `GlobalObjectId.GetGlobalObjectIdSlow(obj).ToString()` for `id`, `AssetDatabase.GetAssetPath` for `path`; a single `ClientWebSocket` with the Bearer header set from an EditorPrefs-stored token; 100ms debounce; a status dot in the Editor toolbar showing connecting/connected/disconnected. Package shape copies Bezi's proven layout: top-level `package.json` + `Editor/` holding one asmdef with `"includePlatforms": ["Editor"]` (`/Users/pieroherrera/Projects/Deepmind/Packages/com.bezi.sidekick/Editor/Bezi.Editor.asmdef`) — but with real .cs sources, so no `Bezi.cs`-style placeholder is needed. SERVER (our file `apps/server/src/editorPresence/EditorPresenceRoute.ts`): `HttpRouter.add("GET", "/editor-presence", …)` using `HttpServerRequest.upgrade`; authenticate via the existing `authenticateWebSocketUpgrade`; branch on `?role=`; keep a `Map<sessionId, LastState>` and a subscriber set; fan out. WEB (our files `apps/web/src/editorPresence/{store,useEditorPresence,EditorPresenceChips}.tsx`): subscriber socket derived from the connection target's `wsBaseUrl` (`packages/client-runtime/src/connection/model.ts:13`) reusing the same wsTicket, own store, own chip component with its own icon. NOT in this step: send-time serialization, persistence, pin/unpin, multi-editor UI, pairing UX.

**Proof:** Screen recording plus four stills of the T3 composer taken while clicking in a live Unity 6.3 Editor: (a) select GameObject `A` → chip reads `A`; (b) select `B` → chip reads `B`, no residual `A` chip; (c) ctrl-click to multi-select `A`+`B` → exactly two chips; (d) click empty Hierarchy space → zero chips. Then press Play and screenshot again: the status dot goes disconnected→connecting→connected and the chip returns, proving the domain-reload path (which fires on every Play in this project per EditorSettings.asset:27-28) actually recovers. Each still timestamped against the Unity Editor window in the same frame. Not proof: unit tests, a mock publisher, or 'the socket connected'.

### 2. T3 footprint reduced to two one-line edits, everything else our own files

Make the integration surface auditable and reversible. Server: one import + `editorPresenceRouteLayer` added to the `Layer.mergeAll` at `apps/server/src/server.ts:422`. Web: one render block in `ChatComposer.tsx` inserting `<EditorPresenceChips />` as a sibling row in the existing pending-context stack (alongside `ComposerPreviewAnnotationCards` :2916, `ComposerPendingReviewComments` :2934, `ComposerPendingElementContexts` :2947), reusing the shared `COMPOSER_INLINE_CHIP_*` tokens from `apps/web/src/components/composerInlineChip.ts` so it looks native. Nothing else in T3 is touched: our store, our socket client, our chip, our route, our Unity package.

**Proof:** `git diff --stat` against the fork base shows exactly two modified T3 files with ≤6 changed lines total, plus N added files all under `apps/server/src/editorPresence/` and `apps/web/src/editorPresence/`. Reverting only those two hunks restores the app to identical behavior — demonstrated by running the app with the hunks reverted and confirming no console error and no missing-import failure.

### 3. Scope check and workspace scoping — close the two real holes step 1 opens

SECURITY: `RPC_REQUIRED_SCOPES` is `satisfies Readonly<Record<WsRpcMethod, AuthEnvironmentScope>>` (`apps/server/src/auth/RpcAuthorization.ts:103`) — it covers RPC methods only. A raw upgrade route is outside that table entirely, so the compile-time guarantee that 'a new endpoint without a scope is a type error' does NOT protect us. The route must check `session.scopes` by hand: subscriber requires `AuthOrchestrationReadScope`, publisher requires `AuthOrchestrationOperateScope`. CORRECTNESS: gate chip display on `workspace.root` matching the active thread's cwd, with path normalization (realpath for symlinks, case-fold on macOS/Windows). Without this, having two Unity projects open puts the wrong project's GameObject in your composer.

**Proof:** Two adversarial tests that fail against the step-1 code: (a) connect a subscriber with a ticket whose session carries only `AuthAccessReadScope` and assert the upgrade is rejected — run it against the step-1 build first and watch it succeed (the hole), then against the fixed build and watch it 403; (b) run two publishers with different `workspace.root` values, open a thread whose cwd matches one, and assert only that project's chips render — again demonstrated failing first. Red-first is the proof; a green test written after the fix proves nothing here.

### 4. Presence becomes an attachment the agent actually receives

Serialize the current presence into the outgoing prompt as an `<editor_selection>` block, mirroring the established pattern exactly: `appendElementContextsToPrompt` (`apps/web/src/lib/elementContext.ts:190-198`) and `buildElementContextBlock` (:180-189) produce `prompt.trim() + '\n\n' + <tag>…</tag>`, chained in `ChatView.tsx:4697-4708`, and `extractTrailingElementContexts` (:213-221) strips it back out for transcript display. Our block carries `label`, `kind`, `path`, and `detail` per item — `path` being the field that turns 'here is a GameObject' into 'here is the GameObject and here is the file'. That is the same leverage `source: file:line` gives a DOM pick. This is one added call in the existing chain at ChatView.tsx plus our own serializer file. Confirmed no wire-level change is needed: the turn contract is `{ text, attachments }` where attachments are images only (`ChatView.tsx:4718-4726, 4882-4883`).

**Proof:** Send a real turn with a real Unity GameObject selected, then read the persisted turn text from the server's thread store (not the UI) and confirm the `<editor_selection>` block is present with the correct label and path. Then confirm the agent used it: ask 'what did I have selected?' and get the right answer back, and confirm the transcript bubble renders the prompt body without the raw tag block leaking into it. Round-trip on the live backend, per the E2E doctrine — a unit test on the serializer is necessary but is not this proof.

### 5. Reconnect hardening against the reload storm

Verified fact: this project reloads the domain on every script compile AND every Play press (EditorSettings.asset:27-28). The socket is killed with no Dispose. Persist connection intent via `SessionState` and re-derive on the far side of the reload — the exact pattern already proven in this codebase at `/Users/pieroherrera/Projects/Deepmind/Assets/Scripts/Editor/AssetLibrary/Workbench/PlayModeTestRunner.cs:8-31` (`[InitializeOnLoad]` static ctor reads `SessionState.GetString(StateKey, "Idle")` at :17 and re-attaches at :29). Add `AssemblyReloadEvents.beforeAssemblyReload` for a clean close, `EditorApplication.quitting` for shutdown, exponential backoff with jitter on the client, and server-side stale-session eviction keyed on `session.id` so a reconnect replaces rather than duplicates. Also cap `items[]` (GetGlobalObjectIdSlow is named Slow for a reason) and debounce drag-select in the Hierarchy.

**Proof:** A 30-minute soak in a live Editor: 20 Play/Stop cycles interleaved with 10 script edits that force recompiles, while a script logs every socket state transition and every `presence` frame the web client receives. Pass condition: zero duplicate chips, zero permanently-disconnected states, and after every single reload the chip returns within 3s. Then a hard `kill -9` on the Unity process and confirm the server evicts the session and the chip disappears rather than hanging as a ghost.

### 6. Package it so someone else can actually install it

The owner asked for shareable, so the deliverable is the protocol spec plus a reference publisher, not a Unity feature. Ship: (a) `com.ironmind.editor-presence` as a public git-URL UPM package — a distribution path already proven in this environment, since `/Users/pieroherrera/Projects/Deepmind/Packages/manifest.json:16` resolves `org.khronos.unitygltf` straight from a GitHub URL, no registry needed; (b) EPP v1 written up as a standalone spec with the JSON frames above; (c) a ~50-line reference subscriber (plain HTML page) so a third party can verify their plugin without running T3 at all; (d) a second publisher — a VS Code extension emitting the active file and symbol — as the proof the protocol is not Unity-shaped. Manifest fields to match Bezi's shipped set (`com.bezi.sidekick/package.json:1-24`): name, displayName, description, documentationUrl, author, keywords, unity, version, type, dependencies.

**Proof:** On a clean machine with no prior setup, install the package by pasting the git URL into Unity's Package Manager, paste a token, and get a chip on screen — timed, and the elapsed time reported honestly. Separately: the VS Code extension drives the _same unmodified_ server route and the _same unmodified_ web chip component, screenshotted. If the web client needed any Unity-specific branch to render the VS Code chip, the protocol failed and this step is not done.

## Risks

- SIZING — this is not a one-day task and should not be pitched as one. Honest estimate for step 1 alone (a real selection on screen): 3-5 focused days. Unity package with reconnect ~1.5-2d (the reload path is the hard part and it fires constantly here), server route ~0.5-1d (lower now that `HttpServerRequest.upgrade` is confirmed to exist, so no Effect-RPC spelunking), web subscriber + store + chip ~1d, token plumbing and first-run docs ~0.5d. Steps 1-5 together — the point where an agent actually receives the selection and the thing survives a working day — is realistically 2-3 weeks. Step 6 (shareable package, second editor, spec) is another week. Anyone promising the full picture in a sprint is not counting the reconnect work.
- PRESENCE IS BOUND TO THE SERVER HOST, NOT THE BROWSER HOST. Because we route Unity through the T3 server, the Unity Editor must run on the same machine as `apps/server`. That is true today for the owner but breaks the moment T3 is used against a remote environment over the relay (`VITE_T3CODE_RELAY_URL`, `apps/web/vite.config.ts`). The alternative — browser connects directly to a Unity-hosted socket — fails differently: Electron's CSP would allow it (`connect-src 'self' http: https: ws: wss:`, `apps/desktop/src/electron/ElectronProtocol.ts:84`) but the hosted https web surface would hit mixed-content blocking on `ws://127.0.0.1`, and Unity would have to host a WS server on Mono, which is exactly the problem `ClientWebSocket` lets us avoid. Neither option covers every topology; name the limitation in v1 rather than pretending it generalizes.
- A RAW UPGRADE ROUTE ESCAPES THE AUTHORIZATION TYPE-CHECK. `RPC_REQUIRED_SCOPES` is `satisfies Readonly<Record<WsRpcMethod, AuthEnvironmentScope>>` (`apps/server/src/auth/RpcAuthorization.ts:103`), and its own doc comment says the point is that 'adding an RPC without choosing a scope is a type error instead of a production runtime failure' (:18-22). Our route gets no such protection — a missing scope check is silent. This is a security-touching diff and should get an Opus-tier review per the owner's own doctrine, not a routine one.
- UNVERIFIED: `ClientWebSocket` behavior inside the Unity 6.3 Editor's Mono runtime. The API is present at .NET Standard 2.1 (`apiCompatibilityLevel: 6`, ProjectSettings.asset:988) and this is the standard approach, but I have not executed C# in Unity to confirm the async handshake, TLS, and cancellation behave under the Editor's synchronization context. This is the one assumption that would invalidate step 1's shape, and it is cheap to falsify — a 30-minute spike that opens a socket to any echo server from an EditorWindow, before writing anything else.
- GLOBALOBJECTID IS UNPROVEN IN BOTH REPOS. Grep for `GlobalObjectId` across `/Users/pieroherrera/Projects/Deepmind/Assets` and `Packages` returns zero hits; nothing in the project exercises it. Its stability across nested prefabs is documented but untested here, and `GetGlobalObjectIdSlow` is named for its cost. Cap `items[]` and measure before trusting it on a 50-object multi-select. Also: an unsaved, never-serialized scene GameObject has no GUID-backed identity at all — it can only be represented as 'resolved at selection time', and the protocol should carry `id: null` for it rather than fabricating something durable-looking.
- CROSS-PROJECT CHIP BLEED is the most likely user-visible bug and it is invisible in a single-project demo. Two Unity projects open, or a Unity project plus a VS Code window on a different repo, and the wrong item lands in the composer. `workspace.root` is in the protocol from v1 for this reason, but path normalization (symlinks, macOS case-insensitivity, WSL translation) is where this actually breaks, and this repo already has a `pathExpansion.ts` and `WorkspacePaths.ts` whose conventions we must match rather than reinvent.
- DEAD-RAIL TEMPTATION. `addElementContext` exists, is tested, is persisted, is serialized on send — and has no live producer (`apps/web/src/composerDraftStore.ts:3063`, called only from `composerDraftStore.test.ts`). It will be tempting to squat it to skip step 4. Doing so emits a `<element_context>` block with a `url:` field for a GameObject and renders `<Player>` behind a mouse-cursor icon (`elementContext.ts:117-120`; `ComposerPendingElementContexts.tsx:52`). It buys perhaps a day and costs a rewrite plus a lie in the agent's context.
- SELECTION FREQUENCY IS UNMEASURED. Nothing in either repo subscribes to `Selection.selectionChanged` — zero hits across Deepmind's Assets and Packages; the project's own convention is pull-on-menu-click (`Assets/Scripts/Editor/VfxExporter.cs:27`, `GlbExporter.cs:65`). So the event's real-world cadence under drag-select in the Hierarchy is a genuine unknown. Debounce from day one and log the rate during the step-5 soak rather than assuming it is quiet.

## Owner decisions

- Does the live chip auto-attach on send, or must you pin it first? Auto-attach (whatever is selected when you hit Enter rides along) matches 'ambient' and needs no extra gesture, but it silently attaches context you may have forgotten about. Pin-first is explicit and never surprises you, but it is a second click every time and largely defeats the point of a presence channel. My read is auto-attach with the chip visibly stating it will be included, but this is the product call that shapes everything downstream in step 4 and it is yours.
- When, if ever, does the package get installed into the real Deepmind project? Installing adds a line to `/Users/pieroherrera/Projects/Deepmind/Packages/manifest.json` — a real edit to your real work. Steps 1-5 are provable in a throwaway Unity project. Say when you want it in the live one, and whether that happens before or after the step-5 soak.
- Is deselecting in Unity supposed to clear the chip, or should the last selection stay sticky until replaced? Clearing is honest presence — the chip mirrors the editor exactly. Sticky is more forgiving — you can click into the chat without your context evaporating, which is a real ergonomic issue since clicking away in Unity is easy. The protocol carries `items: []` either way; this is purely how the client interprets it, and it changes how the feature feels more than any other single choice.
- Package identity and license, since the whole point is that other people use it. Name and namespace (`com.ironmind.editor-presence`?), whether the protocol spec is published separately from the Unity implementation, and what license. This determines whether a VS Code or Blender author can build on EPP without asking you, which is the difference between a shared protocol and your plugin.
- Is the presence chip global to the app or scoped per thread? Global means one Unity selection visible in whatever thread you are looking at — simple, and matches how selection actually works. Per-thread means each conversation remembers its own, which fits T3's existing per-thread draft model (`composerDraftStore` keys everything on a thread target) but means the chip can vanish when you switch threads even though nothing changed in Unity. Existing code leans per-thread; presence leans global; I do not think there is a right answer without knowing how you switch threads while working in Unity.

## The one MAJOR finding from review

Step 1's proof is not achievable as written: nothing describes how a Bearer
token reaches Unity's EditorPrefs, and pairing UX was explicitly excluded from
scope. `EnvironmentAuth.authenticateWebSocketUpgrade` accepts a `wsTicket`
query param or an `Authorization: Bearer` header — Unity's `ClientWebSocket`
can set the header where browser JS cannot, but something must put a token
there first. Solve this before step 1, or step 1 cannot be demonstrated.
