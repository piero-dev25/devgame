# OPEN GATE — presence has one flat trust level

**This must be closed before editor presence is enabled for anyone but the
developer running it locally.** It is a deliberate step-1 scope call, recorded
here so it cannot ship by being forgotten.

## What was measured

A fresh critic minted a token with **only** `review:write` — no
`orchestration:read`, no `orchestration:operate` — and pointed it at the
presence route:

```
weak token scopes: [ 'review:write' ]
weak subscriber  opened=true  frames=1   <- read ALL presence, including
                                            another user's workspace root
weak publisher   opened=true             <- and injected a selection
```

So **every token this server has ever issued, at any scope, is a full
read-and-write credential on the presence plane.** The route authenticates but
does not authorize.

`EditorPresenceRoute.ts`'s own header comment says this plainly — it enforces
no per-role scopes and no `workspace.root` matching, because
`RPC_REQUIRED_SCOPES` covers RPC methods only and a raw upgrade route gets no
compile-time scope guarantee. The comment is accurate. The gap is total rather
than partial, which the comment does not convey.

## Why it matters more than it first looks

Presence is not decorative. It tells the agent what the user is looking at, and
that goes into the prompt. A caller who can write presence can influence what
the agent believes the user selected; a caller who can read it learns project
paths and workspace roots.

The related hijack — any caller claiming an existing `session.id` and taking
over a real editor's identity — **has since been fixed**: the superseded
connection is now closed with code 4402 instead of being silently muted. But
that fix stops the takeover being _silent_; it does not stop an unauthorized
caller from connecting in the first place. That is this gate.

## What closing it requires

- Per-role scopes: `AuthOrchestrationReadScope` for `role=subscriber`,
  `AuthOrchestrationOperateScope` for `role=publisher`, checked after auth and
  before any registry mutation.
- `workspace.root` scoping, so a subscriber sees only presence for workspaces
  it is entitled to rather than every editor on the machine.
- A test per rule, mutation-proven — a scope check with no test that fails when
  it is removed is not a scope check.

## Until then

Local single-user development only. Do not expose this route over a tunnel, a
relay, or a LAN binding, and do not enable it for a multi-user environment.
