# Spec: Unity Play/Stop (task #49)

Frozen design. If the code disagrees with this spec, correct the spec rather
than diverging from it silently.

> **STATUS (2026-08-03): SUPERSEDED.** Everything below describes driving
> Unity Play/Stop through our own `com.ironmind.editor-presence` C# plugin
> over the Editor Presence WebSocket — the "two paths" split, the domain-
> reload hazard and its "acceptance is an edge, play state is a level"
> ruling, the capability table entry. That plugin was deleted: it was never
> installed in the owner's real project (which already had Unity's own
> `com.unity.pipeline` package) and never compiled. Unity Play/Stop now goes
> through `apps/server/src/unity/UnityPipelineClient.ts`, which shells out to
> the official `unity` CLI (`editor_play` / `editor_stop` / `editor_pause` /
> `editor_status`) — no WebSocket, no domain-reload-vs-socket hazard (Pipeline's
> local server briefly drops during the reload too, but self-heals; see that
> module's own doc for the measured behavior). Cold start is
> `apps/server/src/editorPresence/UnityColdStart.ts`'s `unity open <path>`,
> not the `-executeMethod` entry point this document describes. `step` is
> NOT available on the Pipeline path (no `editor_step` command) — Unity's
> capability there is `play`/`stop`/`pause` only, not the four this document
> lists. This document is left intact below as the historical design record
> for why the original C# approach was built and what it proved; see
> `unity/README.md` for the current state.

## Verified environment

Both are confirmed present on the build machine, so nothing here is blind:

- Unity **6000.3.14f1** at `/Applications/Unity/Hub/Editor/6000.3.14f1/`
- The owner's real project at `~/Projects/Deepmind`, pinned to that same
  version, and already classified `unity` by the shipped `EngineTypeResolver`
- Our plugin package at `unity/com.ironmind.editor-presence/`

## Two paths, because Unity has a project lock

`Temp/UnityLockfile` prevents a second editor instance opening the same
project. That single fact splits the feature in half:

- **Warm path** — an editor is already open on the project. Command frames go
  over the existing Editor Presence connection. This is the path that matters
  and the one to build first.
- **Cold path** — no editor is open. Launch one with
  `-projectPath <path> -executeMethod <Class.Method>`, where the invoked
  method calls `EditorApplication.EnterPlaymode()`.

The cold path is **launch-time only**. It cannot drive an editor that is
already running — the lockfile rejects the second instance. Never present it
as a general "make Unity play" mechanism; picking the wrong path produces a
confusing failure where a second Unity silently refuses to start.

Choose by probing the lockfile, not by remembering what we launched.

## The hazard that will otherwise cost a day

**Entering play mode triggers a domain reload.** Unless the user has changed
Enter Play Mode Options — and we cannot require that — Unity tears down and
recreates the managed app domain when Play begins. That destroys all managed
state, including our WebSocket. The socket dies _during_ the very command that
caused it.

So the naive shape is broken on arrival:

```
receive "play" -> EnterPlaymode() -> [domain reload kills the socket]
                                  -> commandResult never sent
                                  -> caller waits, then times out
```

The button would appear to fail every single time while working perfectly.

### Ruling: acceptance is an edge, play state is a level

Do not try to make `commandResult` carry the outcome. Split the two claims:

- **`commandResult` means "accepted", not "playing".** Send it _before_
  calling `EnterPlaymode()`, while the socket is still alive. It answers "did
  the command reach a plugin that understood it", which is the question the
  correlation id exists to answer.
- **Whether Unity is actually playing is reported through presence.** Add a
  play-state field to what the publisher reports. Presence is already defined
  as a level, republished on reconnect — so after the domain reload the plugin
  reconnects and republishes, and the true state arrives without anyone
  needing to correlate it to a command.

This is not a workaround; it is the existing architecture used as designed.
`spec-editor-presence-commands.md` already states presence is a level and
commands are edges. Play state is a level that happens to be _caused_ by an
edge. Model it as what it is.

The UI consequence, which the toolbar lane (#52) depends on: **the Play button
reflects presence, never the commandResult.** A button driven by command
replies will flicker into a wrong state on every domain reload.

### Consequences to handle

- The plugin must republish play state on reconnect, not only on change —
  otherwise the first post-reload presence frame omits the very thing that
  changed.
- Use `SessionState` (survives domain reloads by design, clears on editor
  exit) if any correlation must outlive the reload. Do **not** use static
  fields; they do not survive.
- `EditorApplication.playModeStateChanged` is the truth source for the level.
  Do not infer play state from having sent a command.
- Exiting play mode also reloads the domain. Both directions, not just entry.

## Unity API notes

- `EditorApplication.EnterPlaymode()` / `ExitPlaymode()` — prefer these over
  assigning `isPlaying`; they are the supported entry points and are explicit
  about intent.
- `EditorApplication.isPlaying` — read for current state.
- `EditorApplication.Step()` — frame advance. Unity is the **only** engine of
  the three with a scriptable frame step, which is why the capability table
  lists `step` for Unity alone.
- **Main thread only.** Every one of the above must be called on Unity's main
  thread. The receive loop is not on it. Route through the plugin's existing
  main-thread pump — it already exists and is proven; do not add a second one.

## Inbound frames are currently discarded

`ReceiveUntilClosedAsync` drops every non-Close frame today. That is the
concrete reason Unity must advertise `capabilities: []` until this task lands,
and it is the first thing to change.

Parse defensively: an unknown `action` is answered `ok: false` with
`error: "unsupported_action"`. Never drop a command silently — a dropped
command is indistinguishable from a hung editor.

## Capabilities

On completion Unity advertises `["play", "stop", "pause", "step"]`. Advertise
only what is implemented and tested — a capability claimed but not honoured
produces exactly the enabled-button-then-timeout experience the capability
table exists to prevent.

## Test bar

- Red→green per guard: each rejection path must fail against the unguarded
  code and pass with it.
- Assert the **effect** — that play state actually changed — never that a
  method was called. Green precondition assertions have hidden two
  "looks wired, does nothing" bugs in this repo already.
- Unknown action answers `unsupported_action`.
- Cold path chooses correctly when the lockfile is present vs absent.
- Full `npm test`, `npm run typecheck`, and `npm run fmt:check` all clean.
  Targeted suites are not sufficient; that has already produced two bad
  commits here.

## Live verification, which tests do not replace

C# unit tests cannot prove a domain reload behaves. The acceptance evidence is
a real Unity editor on `~/Projects/Deepmind` entering play mode from a command
issued by DevGame, **and the Play button showing the correct state after the
reload settles** — the second half is the part most likely to be wrong, and a
green suite will not tell you about it.
