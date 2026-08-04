# Editor Presence Protocol — Unity selection in the composer

Design from a mapped + adversarially-reviewed pass. Neither critic refuted it.
Line citations in the source design drifted by 1-6 lines throughout; the
substance was verified correct but re-check any exact line before relying on it.

> **STATUS (2026-08-03): Unity's `com.ironmind.editor-presence` package
> described throughout this document — including the whole "thin vertical"
> walkthrough below — was deleted.** Unity ships an official editor-automation
> package, `com.unity.pipeline`, plus a `unity` CLI, which the owner's real
> project already had installed instead of ours; ours had also never been
> compiled. Unity's Play/Stop/Pause/status/selection now go through Pipeline,
> not this protocol. See `unity/README.md` for the current state and why, and
> `docs/workbench/spec-unity-play-stop.md`'s own status note for the Play/Stop
> pivot specifically. **Godot (`godot/addons/editor_presence/`) and Unreal
> (`unreal/EditorPresence/`) are unaffected** — this protocol, the server
> route, and the web subscriber below remain exactly as designed and are what
> those two engines use; only Unity's publisher is gone. The rest of this
> document is left intact as the historical design record.

## Recommendation

Build a small, editor-agnostic **Editor Presence Protocol (EPP)** and ship the first slice as a thin vertical: a Unity Editor package (our own UPM package) pushes selection state over a plain-JSON WebSocket to a **new raw WS route on the local T3 server** (our own file, one line of registration), and a **new web-client module** (our own file) renders it as an ambient chip above the composer.

Three verifications changed the design versus the input maps:

1. **`HttpServerRequest.upgrade: Effect<Socket.Socket, HttpServerError>` and `upgradeChannel()` exist** (`/Users/pieroherrera/Projects/t3code-fork/apps/server/node_modules/effect/dist/unstable/http/HttpServerRequest.d.ts:74` and `:134`). A raw, non-RPC WebSocket route is a first-class primitive here. This is the single biggest finding: we do **not** need a new RPC method, a new `WS_METHODS` entry, a new `AuthEnvironmentScope` literal, or any change to `packages/contracts`. The transport lane's "new RPC + new scope" cost estimate was overstated. Route registration is one line at `apps/server/src/server.ts:422`, mirroring `websocketRpcRouteLayer` (`apps/server/src/ws.ts:2108-2170`).

2. **Unity is 6000.3.14f1 with `apiCompatibilityLevel: 6` (.NET Standard 2.1)** (`/Users/pieroherrera/Projects/Deepmind/ProjectSettings/ProjectVersion.txt:1`; `/Users/pieroherrera/Projects/Deepmind/ProjectSettings/ProjectSettings.asset:988`). `System.Net.WebSockets.ClientWebSocket` is available, so **we ship no WebSocket DLL**. Plugins that bundle their own WebSocket library do so to support a Unity 2018.3-era .NET 3.5 floor, which we do not have to match. Unity is the WS _client_; it never hosts a socket. That sidesteps the Mono `HttpListener.AcceptWebSocketAsync` problem entirely.

3. **Domain reload fires on every play-mode enter in this project.** `m_EnterPlayModeOptionsEnabled: 1` with `m_EnterPlayModeOptions: 0` (`/Users/pieroherrera/Projects/Deepmind/ProjectSettings/EditorSettings.asset:27-28`) — the toggle is on but neither `DisableDomainReload` (1) nor `DisableSceneReload` (2) is set, so both reloads still happen. The Unity-side socket dies on every script compile **and** every press of Play. Reconnect is the dominant runtime path, not an edge case — which is why mature editor plugins ship a visible connection state (connecting / connected / disconnected). Our status indicator is required in step 1, not deferred.

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

All three tiers, each at its thinnest. UNITY (our own package `com.ironmind.editor-presence`, installed into a throwaway scratch project — never into Deepmind): `[InitializeOnLoad]` static class subscribing `UnityEditor.Selection.selectionChanged`; builds `items[]` from `Selection.objects` using `obj.name` for `label`, `GlobalObjectId.GetGlobalObjectIdSlow(obj).ToString()` for `id`, `AssetDatabase.GetAssetPath` for `path`; a single `ClientWebSocket` with the Bearer header set from an EditorPrefs-stored token; 100ms debounce; a status dot in the Editor toolbar showing connecting/connected/disconnected. Package shape is the standard editor-only UPM layout: top-level `package.json` plus an `Editor/` folder holding one asmdef with `"includePlatforms": ["Editor"]`, and real `.cs` sources rather than a compiled assembly. SERVER (our file `apps/server/src/editorPresence/EditorPresenceRoute.ts`): `HttpRouter.add("GET", "/editor-presence", …)` using `HttpServerRequest.upgrade`; authenticate via the existing `authenticateWebSocketUpgrade`; branch on `?role=`; keep a `Map<sessionId, LastState>` and a subscriber set; fan out. WEB (our files `apps/web/src/editorPresence/{store,useEditorPresence,EditorPresenceChips}.tsx`): subscriber socket derived from the connection target's `wsBaseUrl` (`packages/client-runtime/src/connection/model.ts:13`) reusing the same wsTicket, own store, own chip component with its own icon. NOT in this step: send-time serialization, persistence, pin/unpin, multi-editor UI, pairing UX.

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

The owner asked for shareable, so the deliverable is the protocol spec plus a reference publisher, not a Unity feature. Ship: (a) `com.ironmind.editor-presence` as a public git-URL UPM package — a distribution path already proven in this environment, since `/Users/pieroherrera/Projects/Deepmind/Packages/manifest.json:16` resolves `org.khronos.unitygltf` straight from a GitHub URL, no registry needed; (b) EPP v1 written up as a standalone spec with the JSON frames above; (c) a ~50-line reference subscriber (plain HTML page) so a third party can verify their plugin without running T3 at all; (d) a second publisher — a VS Code extension emitting the active file and symbol — as the proof the protocol is not Unity-shaped. Manifest fields, the standard shipped set: name, displayName, description, documentationUrl, author, keywords, unity, version, type, dependencies.

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

---

## OWNER DECISIONS — settled 2026-08-03

### 1. Attachment: auto-attach, with a pin

**Default (unpinned):** the chip follows the Unity selection live and
**auto-attaches on send**. Whatever is selected when you hit Enter rides along.

**Click the chip to PIN it:** that item is locked and keeps riding on every
message regardless of what happens in Unity — clicking around the hierarchy,
deselecting, opening another scene. **Click again to unpin**, returning it to
following the live selection.

Owner's words: _"you can click on the chip to attach so it is always riding
until you unattach (by clicking on the chip again)"_.

Why this is better than either option originally offered: auto-attach alone
has a real failure mode — select something, get distracted, and twenty minutes
later it silently rides along with an unrelated question. Pin-to-attach alone
destroys the ambient quality that is the whole point. This gets both: nothing
is ever silent because the chip visibly tracks the selection, and when you
genuinely want to hold an object while poking around Unity, you say so once.

### 2. Deselect behaviour: moot, by construction

The original question was whether deselecting in Unity should clear the chip
or leave it sticky. The pin resolves it:

- **unpinned** → follows Unity exactly, including deselect. Honest presence.
- **pinned** → holds regardless. Explicit intent.

Stickiness becomes something the user asks for rather than something the
system guesses at. That is strictly better than either default.

### 3. Scope: global

One chip, showing the current Unity selection, visible in whatever thread you
are looking at. Unity has exactly one selection; the chip mirrors it.

Consequence, accepted: a thread about footstep audio will show the collider you
currently have selected, because that is genuinely what is selected. The chip
means **"selected now"**, never "selected once" — which is what keeps it
honest and is why presence is not persisted.

### OPEN: pin + live selection together?

Not settled. When `PlayerRoot` is pinned and you then select `Ground`:

- **(a) Pin replaces following** — one chip, the pinned one; live selection
  ignored while anything is pinned. Simplest and never ambiguous.
- **(b) Pinned AND live** — a chip row showing `PlayerRoot 📌` and `Ground`,
  both attaching. Supports "why do these two clip", which is a very common
  game-dev question — but it is a set to manage and needs a way to see what is
  riding at a glance.

Recommendation is (b) for usefulness, but it is the larger build. **Implement
(a) first**; it is a strict subset, and the protocol already carries an array
of items so (b) needs no protocol change — only client state.

---

## DECIDED 2026-08-03: multi-object — pinned AND live together

The open question was whether pinning replaces live-following or coexists with
it. **It coexists, and the chip row is multi-object.**

So the row can carry several items at once:

```
⬡ PlayerRoot 📌   ⬡ Ground 📌   ⬡ Camera        ← live, follows Unity
   pinned            pinned        (unpinned)
```

- **Unpinned items** follow the Unity selection and are replaced as it changes.
- **Pinned items** stay until you click them again to release.
- **Everything shown attaches on send.**

This is what makes "why do these two clip through each other" a single
question. Pin the player, pin the ground, then keep clicking around Unity —
both stay, and whatever you have selected right now rides along too.

No protocol change is needed: `selection.items` is already an array, and the
server already replaces publisher state wholesale per frame. Pinning is purely
client-side — the chip store keeps a pinned set that survives incoming frames,
while unpinned chips are replaced by each frame's `items`.

Implementation note: because pinned items outlive the frames that introduced
them, the store must retain each pinned item's full payload (`id`, `label`,
`path`, `kind`, `detail`) rather than re-deriving it from the current frame —
a pinned object is frequently no longer in the live selection at all.

---

## BLOCKER RESOLVED: how a token reaches Unity

The review flagged, correctly, that step 1 had no proof path — nothing
described how a Bearer token gets into the Unity plugin, and pairing UX was
out of scope. That is now answered, and the answer needs **no new auth
infrastructure at all**.

**Unity is just another bearer-paired client, exactly like T3's mobile app.**

The evidence, all pre-existing:

- `EnvironmentAuthPolicy.ts:39` lists `sessionMethods:
["browser-session-cookie", "bearer-access-token", "dpop-access-token"]`.
  A bearer session is first-class, not a workaround.
- `EnvironmentAuth.ts:821` and `:835` mint sessions with
  `method: "bearer-access-token"`.
- `t3 pair` mints a one-time token for an already-running server and prints it
  (`apps/server/src/cli/pair.ts`), which redeems into a session token.
- `packages/client-runtime/src/connection/onboarding.ts:133`
  (`updateBearerConnection`) and its `BearerConnectionTarget` are how
  **apps/mobile** already connects — a non-browser client holding a bearer
  token is a shipped path with a working precedent.

### The flow

1. The user runs `t3 pair` (or we surface a token in settings later).
2. They paste it into the Unity plugin's preferences field — one time.
3. The plugin redeems it, stores the resulting session token in `EditorPrefs`,
   and sets `Authorization: Bearer <token>` on the WebSocket handshake.
   `ClientWebSocket.Options.SetRequestHeader` can do this; browser JS cannot,
   which is precisely why the bearer path exists for non-browser clients.
4. `authenticateWebSocketUpgrade` accepts it like any other session.

### Why this is the right answer rather than a shortcut

It reuses T3's own device-pairing model rather than inventing a parallel one.
We are treating the Unity Editor as what it actually is — another device
pairing with a local server — which is the case their auth was already built
for. That keeps our footprint on their code at the two one-line edits already
established, and it means the security properties are theirs, reviewed and
shipped, not ours improvised.

**Step 1 now has a proof path**: pair once, select a GameObject, see the chip.
