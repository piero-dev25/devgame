# UNVERIFIED — Unity plugin

Unity is not installed on the machine this plugin (and its later
cross-engine audit fixes) were built on. **None of this C# has been
compiled or run.** This file lists every claim in the fixes made during the
cross-engine contract audit (2026-08-03) that could not be checked against a
real Unity Editor, cross-referenced to the exact call site. It supplements,
not replaces, the per-file `UNVERIFIED` comments already in this package
from the original build (`EditorPresenceItemBuilder.cs`'s
`GlobalObjectId.GetGlobalObjectIdSlow` note, `EditorPresenceConnection.cs`'s
`ClientWebSocket`-inside-Mono note, `EditorPresenceStatusOverlay.cs`'s
`UnityEditor.Overlays` note) — those still stand and are not repeated here.

## Close-code diagnosis (`EditorPresenceConnection.cs`)

- **`ClientWebSocket.CloseStatus` / `CloseStatusDescription` are populated
  once a Close message has been received, BEFORE `CloseAsync` is called.**
  `ReceiveUntilClosedAsync` now reads both immediately after
  `result.MessageType == WebSocketMessageType.Close`, before calling
  `CloseAsync`. This is the standard, documented .NET `ClientWebSocket`
  close pattern, but it has not been exercised against a real server
  connection from inside the Unity Editor's runtime.
- **Casting an unnamed close code into `WebSocketCloseStatus` and back to
  `int` recovers the original value.** `WebSocketCloseStatus` only declares
  named members for the standard 1000–1015 codes; EPP's application codes
  (e.g. 4401) have no matching name. The claim rests on general C# enum
  behavior (enums are typed integers, not validated against their declared
  members at runtime) rather than on having actually received a 4401 close
  frame in a running `ClientWebSocket`.
- **The measured server behavior — accept the WebSocket upgrade, THEN
  reject via an application close code — was established for Godot
  (`docs/workbench/godot-probe-findings.md`) and is asserted, not
  independently re-measured, to hold for Unity's `ClientWebSocket` too.**
  This determines WHERE the fix had to live (the post-connect receive loop,
  not a `ConnectAsync` exception handler) — if `ClientWebSocket` behaves
  differently under the hood, this placement could be wrong.

## Credential-rejection halt (`EditorPresenceConnection.cs`, `EditorPresenceSettingsProvider.cs`, `EditorPresenceStatusOverlay.cs`)

- The `_credentialRejected` flag, `HandleEditorUpdate`'s early-return while
  it is set, and `Retry()` clearing it are new control flow untested
  against the Editor's actual `EditorApplication.update` cadence and the
  `async void` continuation timing documented as already-unverified in this
  file's header comment. The LOGIC (don't call `RunConnectAsync()` again
  while halted; do call it immediately when `Retry()` resets
  `_nextConnectAttemptAt` to "now") is straightforward, but has not been
  observed running.
- `EditorPresenceSettingsProvider`'s "Retry now" button and
  `EditorPresenceStatusOverlay`'s rejected-state label/tooltip both read
  `EditorPresenceConnection.CredentialRejected` and `.LastErrorMessage`
  directly — untested that IMGUI (`SettingsProvider`) and UI Toolkit
  (`Overlay`) both redraw promptly enough for these to feel responsive in
  practice, though neither requires anything beyond Unity's normal
  redraw/event cadence.
- `VisualElement.tooltip` (used on the overlay's `Label`) is a real,
  documented UI Toolkit property; not re-confirmed against this project's
  Unity version specifically.
- **CORRECTED same day** (`docs/workbench/godot-probe-findings.md`'s
  "Correction: '>= 4000 means stop retrying' was too coarse"): the halt
  condition first shipped as `closeCode >= 4000` (a plain threshold, via a
  now-removed `AuthRejectionCloseCodeThreshold` constant), then was
  narrowed to `IsCredentialRejection(closeCode)` — a named membership
  check against exactly `{4400, 4401}`. An unrecognized code >= 4000 (e.g.
  4500, server internal error) now falls into `HandleServerClose`'s middle
  branch: shown verbatim, `_credentialRejected` left `false`, so
  `HandleEditorUpdate`'s normal fixed-interval retry keeps running. This
  three-way branch (`IsCredentialRejection` / `>= 4000` unrecognized /
  everything else) is new control flow on top of the already-unverified
  close-code-reading claims above and has the same "reasoned, not
  observed" status — the DISTINCTION being drawn (retry-worthy vs.
  not) is what the Python side's `unreal/tests/test_wire_auth_halt.py`
  mutation-proves; there is no equivalent proof available here since this
  C# cannot run.

## session.id / seq persistence across domain reload (`EditorPresenceConnection.cs`, `EditorPresenceSelectionWatcher.cs`)

- **`UnityEditor.SessionState.GetString`/`SetString` and `GetInt`/`SetInt`
  persist for the life of the Editor process and survive a domain
  reload, resetting only on Editor restart.** This is the load-bearing
  claim behind the whole fix (see `EditorPresenceConnection.cs`'s header
  comment for the full reasoning) and is standard, well-documented Unity
  Editor API behavior — but it was not exercised here: no domain reload was
  actually triggered and observed to confirm `SessionId`/`_sequence` survive
  it as claimed. The pattern mirrors what the original frozen Unity spec
  cited as "already proven in this codebase" at a Deepmind-project file
  this session did not re-read to confirm.
- **Whether `SessionState` keys collide with anything else in a real
  project.** `"Ironmind.EditorPresence.SessionId"` and
  `"Ironmind.EditorPresence.Sequence"` are namespaced by convention only: no
  registry of `SessionState` key usage exists to check against.
- **The consequence claimed for the OLD (pre-fix) behavior** — a fresh
  `session.id` on every domain reload produces a transient duplicate
  registry entry until the old TCP connection's abort is detected
  server-side — is reasoned from reading
  `apps/server/src/editorPresence/EditorPresenceRegistry.ts`'s
  `registerPublisher`/`removePublisher` logic directly, not observed by
  running both sides together.

## Label fallback (`EditorPresenceItemBuilder.cs`)

- That `UnityEngine.Object.name` can actually BE an empty string for a
  GameObject or asset a user has genuinely selected (as opposed to only
  being empty via direct scripting, e.g. `gameObject.name = ""`, which a
  normal Editor workflow might never produce) was not independently
  confirmed — the fix is defensive regardless of how commonly this occurs
  in practice, since the failure mode (an item silently vanishing with no
  error) is bad enough to guard against even if rare.

## Truncation logging (`EditorPresenceSelectionWatcher.cs`)

- No change in risk profile from the original build — `Debug.LogWarning`
  is the same mechanism already used elsewhere in this package
  (`EditorPresenceConnection.cs`'s send-failure logging), just applied to a
  new condition.

## Missing `scope` field on the redeem request (`EditorPresenceSettings.cs`)

- The literal scope string added
  (`"orchestration:read orchestration:operate terminal:operate review:write relay:read"`)
  is taken directly from `docs/workbench/engine-credential-flow.md`, which
  states it matches `AuthStandardClientScopes` in
  `packages/contracts/src/auth.ts` — not independently re-derived from the
  TypeScript source in this pass, and not exercised against a live redeem
  request from this plugin.

## Task #49 (Unity Play/Stop) — new C# added, still not compiled or run

This machine has `dotnet`/`mono` neither installed, and this pass was
explicitly instructed not to open, modify, or launch Unity (a separate
driver handles live verification) — so, same as every prior pass, **none of
this C# has been compiled or run.** New files:
`EditorPresenceCommandDispatcher.cs`, `EditorPresencePlayModeController.cs`,
`EditorPresenceColdStartEntryPoint.cs`; modified:
`EditorPresenceProtocol.cs`, `EditorPresenceConnection.cs`.

- **`EditorApplication.pauseStateChanged` and `EditorApplication.isPaused`
  exist and behave as documented on Unity 6000.3.** Asserted from public
  Unity Editor scripting API documentation, not independently confirmed
  against this project's exact Editor build.
- **`WebSocketReceiveResult.EndOfMessage`-driven multi-fragment
  accumulation via a `MemoryStream`, decoded once via
  `Encoding.UTF8.GetString` at the end, is the correct way to reassemble a
  logical `ClientWebSocket` text message.** Standard, documented
  `System.Net.WebSockets` usage, but — same caveat as every other claim
  about `ClientWebSocket`'s behavior inside this Editor's Mono/CoreCLR
  runtime in this file's own header comment — not exercised here.
- **`JsonUtility.FromJson<CommandFrameDto>` silently ignores JSON keys with
  no matching C# field (e.g. an inbound `params` object) rather than
  throwing.** This is documented `JsonUtility` behavior and is relied on by
  `CommandFrameDto` deliberately omitting a `params` field entirely (no
  action this build implements reads it) — not independently re-confirmed
  by running it.
- **The exact ordering guarantee the hazard section of
  docs/workbench/spec-unity-play-stop.md demands** — `commandResult` fully
  sent and awaited-complete BEFORE the corresponding
  `EditorPresencePlayModeController.Dispatch` call ever runs, since the
  dispatch is queued for a LATER `EditorApplication.update` tick rather than
  invoked inline — is reasoned from the shape of `async`/await and
  `ConcurrentQueue` in this codebase's existing async patterns, not observed
  against a real domain reload actually racing the socket.
- **Whether `EditorApplication.playModeStateChanged` reliably fires (and in
  what order relative to `isPlaying`/`isPaused` settling) around a domain
  reload in THIS project's specific `EnterPlayModeOptions` configuration**
  (`m_EnterPlayModeOptionsEnabled: 1`, neither `DisableDomainReload` nor
  `DisableSceneReload` set, per the frozen spec's own citation of
  `EditorSettings.asset`) is asserted from the frozen spec's description,
  not independently re-measured.
- **The cold-path entry point's `-executeMethod` contract** —
  that Unity actually invokes a public static parameterless method named on
  the command line, once, after the project finishes loading — is
  documented, standard Unity CLI behavior, not exercised here (no cold
  launch was performed; see
  `apps/server/src/editorPresence/UnityColdStart.test.ts` for what WAS
  exercised: the pure argv-construction and lockfile-probe logic only, both
  of which are TypeScript and run under `npm test`).

## What was intentionally NOT changed

- `EditorPresenceConnectionState.cs`'s three-state enum
  (`Disconnected`/`Connecting`/`Connected`) is unchanged. "Credential
  rejected" is layered on top via `CredentialRejected` +
  `LastErrorMessage`, not a fourth enum value — this avoids touching every
  existing `switch`/`state switch` expression over the enum
  (`EditorPresenceStatusOverlay.ColorForState`/`LabelForState`,
  `EditorPresenceSettingsProvider.DrawConnectionStatusRow`) for a state
  that is really "Disconnected, for a specific reason," matching how
  `epp/indicator.py`'s Python-side equivalent handles the same distinction
  (a `last_error` string alongside three states, not a fourth state).
- The `ReconnectIntervalSeconds` fixed 3-second retry / no backoff-jitter
  for the NON-auth-rejection disconnect path was left as-is — that
  hardening is explicitly flagged in this file's own existing comment as
  "step 5... not step 1" of the frozen spec, and is out of scope for a
  contract-conformance audit. Only the auth-rejection case (a NEW category
  of failure this audit is specifically about) got new control flow.
