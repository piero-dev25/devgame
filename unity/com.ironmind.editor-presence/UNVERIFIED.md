# UNVERIFIED — Unity plugin (selection-only)

This package is a rebuild of the deleted `com.ironmind.editor-presence`
(git show `33d6cc4d8^`) — see `unity/README.md` for why the original was
deleted. It carries forward exactly four concerns from that package's
reviewed code: the selection watcher, the item builder, the connection/auth
transport, and the pairing settings. It does **not** carry forward the
command dispatcher, play-mode controller, or cold-start entry point — those
are Pipeline's job now (`com.unity.pipeline`, Unity's official package).

This file lists every claim in the code that could not be independently
checked before this pass's live-Editor verification, cross-referenced to
the exact call site, in the same spirit as the deleted package's own
`UNVERIFIED.md` — "keep that discipline" per the brief that produced this
rebuild.

**Status of each claim below is dated to when this file was last edited —
see the "Verified this pass" section at the bottom for what a real
Unity 6000.3.14f1 Editor confirmed.**

## Automatic Library pairing handoff (`EditorPresenceSettings.cs`, version 0.3.0)

The 0.3.0 handoff is additive to the previously live-verified redemption
path, but **this revision could not be compiled or run in a live Unity Editor
in the current environment.** These claims remain unverified:

- `EditorPresenceConnection.HandleEditorUpdate` observes a
  `Library/com.ironmind.editor-presence/pairing.json` written after the
  package has already loaded, including an S10 recovery re-click, without
  interfering with the existing reconnect lifecycle.
- `Directory.GetParent(Application.dataPath)` resolves the current Unity
  project root on every supported Editor host, and `System.IO` can read and
  delete the per-project Library handoff there.
- `JsonUtility.FromJson<PairingHandoffDto>` decodes the server's exact
  `{ "serverUrl": string, "pairingCredential": string }` payload in this
  Editor runtime.
- Automatic redemption reaches the existing
  `RedeemPairingCredential` callback on the Editor main thread, stores only
  the returned bearer in EditorPrefs, deletes `pairing.json` after success,
  and leaves it in place after failure.
- Both the automatic handoff and manual Preferences flow request exactly
  `orchestration:operate`, matching the publisher's only job and allowing a
  Connections "Operate tasks" credential to redeem without wider scopes.
- Automatic handoffs reject non-HTTP(S) schemes and every non-loopback host,
  accept only `localhost`, `127.0.0.1`, or `::1`, leave rejected files in
  place, and surface the failure through the existing Preferences status.
- A stored bearer short-circuits only a handoff for the same `ServerUrl`; a
  different-server handoff may redeem and replace it. The handoff URL is not
  persisted to EditorPrefs unless redemption succeeds, so invalid, stale,
  or failed handoffs cannot overwrite a hand-typed server URL.
- A failed handoff is attempted only once per file contents during a domain
  lifetime; replacing the file with a fresh install-click credential causes
  one new attempt and the existing Preferences status box displays the
  failure without a new UI surface.
- Replacing an installed 0.2.0 embedded package with 0.3.0 causes Unity to
  import/reload the updated Editor scripts as expected.

## `ClientWebSocket` inside the Unity Editor's Mono/CoreCLR runtime (`EditorPresenceConnection.cs`)

- The async handshake/read/write shape (`async Task` methods kicked off
  from a single `async void` entry point, pumped by nothing special —
  Unity's Editor process runs a normal .NET thread pool) is the standard,
  documented `ClientWebSocket` pattern. Whether it behaves identically
  under the Editor's specific synchronization context was unconfirmed prior
  to this pass.
- `ClientWebSocket.CloseStatus` / `CloseStatusDescription` being populated
  once a Close message is received, BEFORE `CloseAsync` is called, and
  casting an unnamed close code (e.g. 4401) through `WebSocketCloseStatus`
  and back to `int` recovering the original value — both are standard,
  documented .NET behavior, not previously exercised against a real server
  connection from inside this Editor's runtime.
- The measured server behavior — accept the WebSocket upgrade, THEN reject
  via an application close code — was established for Godot
  (`docs/workbench/godot-probe-findings.md`) and was asserted, not
  previously re-measured, to hold for Unity's `ClientWebSocket` too. This
  determines WHERE the credential-rejection handling lives (the post-connect
  receive loop, not a `ConnectAsync` exception handler).
- A 4400/4401 credential rejection clears the stored bearer before setting
  the retry halt, returning the machine to an unpaired state that an existing
  or newly written Library handoff can recover; this includes task #113's
  long-lived-backend session-expiry scenario.

## `SessionState` persistence across domain reload (`EditorPresenceConnection.cs`'s `SessionId`, `EditorPresenceSelectionWatcher.cs`'s `_sequence`)

- `UnityEditor.SessionState.GetString`/`SetString` and `GetInt`/`SetInt`
  persisting for the life of the Editor process and surviving a domain
  reload (resetting only on Editor restart) is the load-bearing claim
  behind why `session.id` and `_sequence` are SessionState-backed rather
  than plain static fields. Standard, well-documented Unity Editor API
  behavior — this pass's verification includes forcing a domain reload
  (script recompile) and confirming both values survive it; see "Verified
  this pass" below.
- Whether the `SessionState` keys (`Ironmind.EditorPresence.SessionId`,
  `Ironmind.EditorPresence.Sequence`) collide with anything else in a real
  project: namespaced by convention only, no registry of `SessionState` key
  usage exists to check against.

## `GlobalObjectId.GetGlobalObjectIdSlow` (`EditorPresenceItemBuilder.cs`)

- Stability across nested prefabs and cost on a large multi-select were
  unmeasured prior to this pass — nothing in the disposable verification
  project exercises a deeply nested prefab. This pass's live verification
  covers plain scene GameObjects and a small multi-select only; a
  large/deeply-nested-prefab selection remains unverified.

## Label fallback (`EditorPresenceItemBuilder.cs`)

- Whether `UnityEngine.Object.name` can genuinely be empty for something a
  user selects through normal Editor interaction (as opposed to only via
  direct scripting) was not independently confirmed. The fallback is
  defensive regardless — the failure mode (an item silently vanishing, no
  error) is bad enough to guard against even if rare.

## Pairing / token exchange (`EditorPresenceSettings.cs`, `EditorPresenceSettingsProvider.cs`)

- The literal `scope` string sent by both redemption entry points is exactly
  `"orchestration:operate"`; this revision could not exercise either path
  against a live server to confirm the granted bearer carries only that
  scope.
- `UnityWebRequestAsyncOperation.completed` firing on the main thread
  regardless of Play/Edit mode, with no coroutine host required, is
  documented Unity behavior; this pass's verification exercises a real
  pairing redeem against a live server (see below), which is the strongest
  available confirmation short of reading Unity's own runtime source.

## What was intentionally NOT carried forward from the deleted package

- `EditorPresenceCommandDispatcher.cs`, `EditorPresencePlayModeController.cs`,
  `EditorPresenceColdStartEntryPoint.cs` — command handling, play/stop
  dispatch, and the `-executeMethod` cold-start entry point. All of it is
  Pipeline's job now.
- `commandResult` / `playState` frames, and the `command` inbound frame
  entirely. This plugin never parses one — see
  `EditorPresenceConnection.cs`'s `ReceiveUntilClosedAsync`, which drains
  every inbound frame's bytes (required to observe a server-initiated
  Close) but never inspects the content of a non-Close frame.
- `EditorPresenceStatusOverlay.cs` (the Scene-view toolbar status dot). The
  deleted package's frozen spec called this "required in step 1, not
  deferred" given how often domain reload kills the socket — that reasoning
  still holds, but this thin rebuild puts the identical status readout
  (connected/connecting/disconnected, credential-rejected + Retry) in the
  Preferences page (`EditorPresenceSettingsProvider.cs`'s
  `DrawConnectionStatusRow`) instead of duplicating it as a second UI
  surface, to keep the file count and line count down. If reconnect
  frequency in practice makes the Preferences-page-only readout too easy to
  miss, re-adding the overlay is a small, self-contained addition — the
  status data it would read (`EditorPresenceConnection.State` /
  `.CredentialRejected` / `.LastErrorMessage`) already exists.
- The `capabilities` field in `hello` is always an empty array
  (`EditorPresenceProtocol.Capabilities`) — this plugin advertises nothing.
  Not a partial or reduced set: zero, because it implements zero commands.

## Verified before 0.3.0 (2026-08-04, real Unity 6000.3.14f1 Editor, disposable project)

All of the following were exercised against a real, running Unity
6000.3.14f1 Editor on a disposable scratch project (never Deepmind), with a
real T3 server instance and a real EPP subscriber client observing the wire:

- **Compiles clean.** `Csc` + ILPostProcess succeeded for
  `Ironmind.EditorPresence.Editor.dll` with zero `error CS` and zero
  assembly-load errors (`LogAssemblyErrors (0ms)`).
- **`ClientWebSocket` inside this Editor's runtime works as assumed.**
  Connected, sent `hello`, received a `presence` frame back reflecting it,
  survived a real domain reload (forced recompile) with a clean
  disconnect/reconnect cycle logged by `EditorPresenceConnection.SetState`.
- **`SessionState` persistence claim: CONFIRMED, not just asserted.**
  Forced a real domain reload mid-session. `session.id` was byte-identical
  before and after
  (`7fec9ec4e65e48c9b6317e0e49b17dcc`), and `_sequence` continued `3 -> 4`
  after reconnect rather than resetting to 1. This is the exact bug
  (stale high-water-mark seq silently dropping every post-reload update)
  the whole SessionState design exists to prevent, and it did not
  reproduce.
- **`capabilities: []` was actually sent and actually received this way.**
  The subscriber's `presence` frame showed `"capabilities": []` on the
  registered editor, every time, across every reconnect.
- **`GlobalObjectId` / label / detail resolution, for real GameObjects,
  single- and multi-select, and deselect:**
  - Single select -> `{"kind":"gameobject","label":"SelectionProbeAlpha","id":null,"path":null,"detail":"(unsaved scene) / SelectionProbeAlpha"}`.
    `id: null` is correct and expected: these were unsaved scene objects
    (`GlobalObjectId.identifierType == 0`), so the "no durable identity"
    path was what actually ran, not the common case.
  - Multi-select (2 objects) -> `items[]` with both, in selection order.
  - Deselect -> `items: []`, not a dropped/missing frame.
  - Not yet exercised: a _saved_ scene object or a prefab instance (which
    would exercise the non-null `GlobalObjectId` path and a real `path`
    value), and a large/deeply-nested-prefab multi-select. Still an open
    gap — see the `GetGlobalObjectIdSlow` section above.
- **No `command`/`commandResult`/`playState` frame was ever sent or
  received.** Every frame observed on the subscriber across the whole
  session was `hello` -> `presence` (with `playState: null` always) and
  `selection`. Nothing else.
- **Pairing flow works against a live server.** `EditorPresenceSettings`'s
  `RedeemPairingCredential` (invoked via reflection from a throwaway
  in-project test harness — no scripted "open Preferences window and
  paste" tool exists in this Pipeline build, so the GUI itself was not
  clicked) redeemed a real `t3 pair`-minted device token against
  `POST /oauth/token` and stored a working bearer session; `ForgetToken`
  was called afterward to leave no residue in the shared, editor-install-
  wide EditorPrefs store.
- **Selection change was driven via Pipeline's own `set_selection`
  command** (`Selection.objects = objects; Selection.activeObject = ...`),
  not a mouse click — this exercises the real, same `UnityEditor.Selection`
  API and event a click would, but a literal mouse-driven click in the
  Hierarchy was not separately exercised this pass.
- **Gotcha found, not a plugin bug:** `EditorApplication.update` (and
  therefore this plugin's 100ms selection-publish debounce) is throttled
  when the Editor window has never been given focus / is backgrounded —
  a real behavior of this Editor process in this environment, not
  something the plugin can or should work around. Calling Pipeline's
  `editor_focus` (or any real user having the window open and focused, the
  normal case) resolves it immediately. Worth knowing if this plugin is
  ever driven in another headless/CI-style context.
