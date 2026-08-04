# Spec: Editor Presence commands (server → engine)

Frozen design for task #47. Implementation follows this; if the code disagrees
with the spec, the spec is wrong and should be corrected rather than silently
diverged from.

Editor Presence is currently one-way: engines publish selection, subscribers
read presence. This adds a **command** direction so DevGame can tell a
connected editor to do something — Play and Stop first.

## Why extend EPP rather than build a new channel

The connection, the DPoP-derived credential, the per-editor session registry,
reconnect-with-backoff, and — the fiddly part — a correct main-thread pump in
all three plugins already exist and are proven. A second channel would
re-implement every one of those.

It also rules out Unreal's built-in Python Remote Execution protocol, which
could technically trigger Play: it has **no authentication and executes
arbitrary code**. Extending a channel we already authenticate is both less work
and less dangerous.

## Prerequisite, not optional

**Task #46 lands first.** The route authenticates but does not authorize, and
because it is a raw WebSocket upgrade it sits outside `RpcAuthorization.ts`, so
no compile-time check will warn anyone. A read-only presence feed with no scope
check is a low-stakes bug. A _command_ channel with no scope check means any
authenticated session can make someone's editor run code. Commands do not ship
before enforcement does.

## Wire shape

`protocol.ts` documents an asymmetry that has already cost one wrong
implementation: inbound `selection` is **flat**, outbound `presence` **nests**,
and the stated reason is that an inbound frame describes _one editor's own
state_ (no wrapper needed) while an outbound frame carries _a set_ of editors
(each needs a key to hang state off).

A command is addressed to exactly one editor. By that same rule it is **flat**.

Server → engine:

```
{ v: 1, type: "command", id: "<uuid>", at: "<iso8601>",
  action: "play" | "stop" | "step" | "pause", params?: { ... } }
```

Engine → server, in response:

```
{ v: 1, type: "commandResult", id: "<same uuid>", ok: true }
{ v: 1, type: "commandResult", id: "<same uuid>", ok: false,
  error: "<short machine-readable reason>" }
```

`id` correlates the two. Without it a UI that fires Play twice cannot tell
which reply belongs to which press.

`action` is an **open string**, consistent with `editor.id` and `items[].kind`,
which the spec already keeps open rather than a closed union. Engines differ in
what they can do and new actions will be added; an unknown action must be
answered `ok: false` with `error: "unsupported_action"`, never dropped. A
dropped command is indistinguishable from a hung editor.

## Capability advertisement

**The feature is required; the field is optional.** Those are not in tension,
and an earlier draft of this heading said only "required", which was ambiguous
enough that an implementer had to stop and ask which was meant.

- Required: the app MUST discover what each engine can do, and the toolbar MUST
  NOT offer a control an engine cannot honour.
- Optional: the `capabilities` key itself, so a plugin built before this
  existed keeps working rather than appearing capability-less.

The `hello` frame gains an optional `capabilities: string[]`.

This is load-bearing for the UI, because the engines genuinely differ and the
toolbar must not offer what an engine cannot do:

|               | play | stop | pause | step              |
| ------------- | ---- | ---- | ----- | ----------------- |
| Unity         | yes  | yes  | yes   | **yes**           |
| Godot         | yes  | yes  | yes   | no scriptable API |
| Unreal (5.5+) | yes  | yes  | yes   | no scriptable API |

Frame-step is Unity-only through supported APIs. Driving it elsewhere would
mean synthesising clicks on a toolbar button, which is fragile and needs the
editor focused — out of scope.

A `hello` with no `capabilities` key is treated as `["play", "stop"]`, so an
older plugin keeps working instead of appearing capability-less.

## Registry change

The registry currently retains, per publisher, a handle that can only _close_
the connection (`sessionSuperseded`). Subscribers get a full write handle;
publishers do not. Commands need a per-editor **send** handle, keyed by session
id, so the server can address one specific connected editor.

Keep the existing connection-token guard when adding it. That token is what
stops a stale reconnect from mutating a newer session's state, and a send path
that skips it would let a superseded connection receive commands meant for its
replacement.

## Rules that are easy to get wrong

**Commands are not connection failures.** A refused or failed command is an
in-band `commandResult` with `ok: false`. Do **not** add close codes for it.
The existing close-code set is a _named_ set, not a numeric threshold —
4400/4401 are credential-class and mean stop retrying; everything else means
keep retrying. Closing a socket because Play failed would make an engine
disconnect over a recoverable error.

**Presence is a level, not an edge** — the existing design note. Commands are
the opposite: each is an _edge_, delivered once, not replayed on reconnect. A
Play queued while an editor was disconnected must **not** fire when it comes
back; by then the user's intent is stale. Drop undelivered commands on
disconnect and surface that to the caller.

**Bound the command rate.** `items[]` is capped at 64 for a reason that applies
here too: a runaway caller must not be able to hammer an editor. A modest
per-session rate limit belongs in this change, not a later one.

## Test bar

- Red→green per guard: each rejection path must fail against the unguarded code
  and pass with it. A test that passes both ways proves nothing.
- Assert the **effect** — that the engine actually received the frame and acted
  — not that a function was called. Green precondition assertions have already
  hidden two "looks wired, does nothing" bugs in this repo.
- Round-trip the correlation id: two commands in flight, replies matched to the
  right one.
- Unknown action answers `unsupported_action` rather than being dropped.
- A command issued to a disconnected editor does not fire on reconnect.
- Full suite (`npm test`) and `npm run typecheck`, both clean. Targeted suites
  are not sufficient; that has already produced two bad commits.

## Live verification, which tests do not replace

Godot is installed (4.7.1) and a real project fixture with the addon already
installed lives at `godot/project.godot`. The acceptance evidence is a human
pressing Play in DevGame and the Godot game window appearing — not a green
suite.
