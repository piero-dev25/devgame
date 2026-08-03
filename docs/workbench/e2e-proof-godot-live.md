# The chain works: real Godot → live server → subscriber

Proven 2026-08-03 against the running dev server on `13773`, using Godot 4.7.1
as a genuine engine runtime on both ends. No mocks, no fakes, real WebSocket
frames, real bearer auth.

## What was run

A verifier script (orchestrator's own, deliberately NOT the shipped addon, so
the proof does not depend on the code under test) speaking the wire contract
directly. Two Godot processes: one `role=subscriber`, one `role=publisher`,
both authenticating with an `Authorization: Bearer` handshake header.

Frames the subscriber received, in order:

```
{"v":1,"type":"presence","editors":[]}
{"v":1,"type":"presence","editors":[{... "session":{"id":"probe-session-69024"},
    "connected":true,"selection":null}]}
{"v":1,"type":"presence","editors":[{... "selection":{"seq":1,"items":[
    {"label":"PlayerCharacter","path":"res://scenes/player.tscn","detail":"CharacterBody3D"},
    {"label":"MainCamera",...}]}}]}
{"v":1,"type":"presence","editors":[{... "selection":{"seq":2,"items":[
    {"label":"MainCamera",...}]}}]}
{"v":1,"type":"presence","editors":[]}
```

Empty state, publisher appears, a two-object selection, a shrink to one object,
publisher disappears on disconnect. That is the whole feature's transport,
end to end, driven from outside our own stack.

## Getting a token: `t3 pair`

```
node src/bin.ts pair --ttl 30m --label "editor-presence-verifier"
```

then exchange the printed code at `POST /oauth/token` per
[engine-credential-flow.md](engine-credential-flow.md).

This is worth stating loudly because a lot of time was lost to not knowing it:
**`t3 pair` is a documented subcommand and `--help` lists it.** The mistake was
reverse-engineering the auth internals instead of reading the CLI's own
interface first. The startup pairing code still does not work for a headless
client; a `t3 pair` credential does.

## The asymmetry that cost the most time

**Inbound `selection` frames are FLAT. Outbound `presence` frames NEST.**

```
publisher → server:   {"v":1,"type":"selection","seq":1,"at":"…","items":[…]}
server → subscriber:  {"v":1,"type":"presence","editors":[{…,"selection":{"seq":1,"at":"…","items":[…]}}]}
```

`parseEditorPresenceInboundFrame` reads `seq`/`at`/`items` from the **top level**
of the frame, while its own result type wraps them in a `selection` object and
the outbound frame nests them too. Both engine clients get this right — Unity's
`SelectionFrameDto` is flat, and the Unreal builder is flat with a comment
saying why — but the shape misled the orchestrator's verifier into sending
nested frames, which the server silently dropped, and it also garbled a
subagent's written report of its own correct code.

Two independent readers misread it, so the asymmetry is not obvious and should
carry a comment at the parser. A nested frame is not rejected loudly; it is
dropped, and the publisher looks connected while no selection ever arrives —
the exact silent-failure class this protocol's lenient parsing is otherwise
good at avoiding.

## What this does and does not prove

**Proves:** the route, the registry's fan-out and last-known-state retention,
bearer auth on a raw upgrade, the selection contract including multi-object and
shrink, and cleanup on disconnect — all from a real engine.

**Does not prove:** the Godot addon's `EditorSelection` binding, the Unity
package (Unity is not installed), the Unreal plugin's engine binding (Unreal is
not installed), or the browser rendering the chips. The first three are why the
selection source stays injectable in every client; the last is next.
