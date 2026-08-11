# OPEN GATE — presence has no workspace scoping

**`workspace.root` scoping must be closed before editor presence is enabled
for anyone but the developer running it locally.** Per-role scope enforcement
(the other half of this gate) has since closed — see "What has since closed"
below — but this document stays open, because the remaining hole is still
real and this is the artifact someone reads to decide whether the route may
be exposed.

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

So, at the time this was measured, **every token this server had ever
issued, at any scope, was a full read-and-write credential on the presence
plane.** The route authenticated but did not authorize.

`EditorPresenceRoute.ts`'s header comment described this plainly at the
time — it enforced no per-role scopes and no `workspace.root` matching. The
per-role half is now fixed; the module doc's SECURITY NOTE describes the
current state, including exactly how each role's scope failure is signalled.

## What has since closed

Per-role scopes are enforced: `AuthOrchestrationReadScope` for
`role=subscriber`, `AuthOrchestrationOperateScope` for `role=publisher`,
checked after authentication and before any registry mutation — a rejected
connection (bad credential OR insufficient scope) never allocates a
connection token, registers a publisher, or adds a subscriber. Both roles'
scope rejections are mutation-proven: `EditorPresenceRoute.test.ts` covers a
correctly-scoped session on each role connecting successfully, an
incorrectly-scoped session on each role being refused, and — separately — a
rejected publisher's `hello` frame never reaching the registry even when it
races the server's own rejecting close.

Re-ran the exact weak-token probe above against a `review:write`-only token
today, extended to also capture every message frame received (not just
whether the socket opened) and to check the registry state a properly-scoped
observer sees after the weak publisher's `hello`:

```
weak token scopes: [ 'review:write' ]
weak subscriber  opened=true  frames=0  closeCode=4401  closeReason=insufficient_scope: subscriber requires orchestration:read
weak publisher   opened=true  closeCode=4401  closeReason=insufficient_scope: publisher requires orchestration:operate
registry state after weak publisher's hello: editors=[]
```

Both upgrades still complete (by design — see the AUTH ORDERING NOTE), but
the publisher is closed immediately with code 4401 before it can register
anything (`editors=[]` confirms no other client ever saw it), and the
subscriber is closed the same way having received zero frames (`frames=0`)
— it is never added to the fan-out list, so it neither reads nor writes any
presence data. This is asserted, not just measured once by hand:
`EditorPresenceRoute.test.ts`'s subscriber scope-rejection test collects
every `message` frame the socket receives and asserts the array is empty —
specifically so a regression that registered the subscriber before checking
its scope (the exact shape that would leak a real frame the way the ORIGINAL
weak-token probe did) fails loudly instead of passing on close-code alone.

The related session-hijack fix (any caller claiming an existing `session.id`
and taking over a real editor's identity, closed with code 4402 instead of
being silently muted) is unrelated to this gate and was already in place
before the scope work above.

## What is still open

- **Commands inherit the same `workspace.root` gap, and make it worse in
  kind, not just in degree.** Task #47 added `sendCommand` (server → engine
  Play/Stop/Step/Pause), gated on a new, dedicated `presence:command` scope
  — but that scope, like the read/operate scopes above, is per-role, not
  per-workspace. `sendCommand` addresses purely by `sessionId`
  (`EditorPresenceRegistry.ts`), with **zero** check that the caller's
  workspace matches the target editor's — and every reader already receives
  every publisher's `session.id` for free via `presence` broadcasts
  (`toEntry`), so a session that holds `presence:command` for its OWN
  workspace can enumerate every OTHER connected editor's session id from the
  presence feed and dispatch commands to it too. That is a **category**
  change from the read/write leak documented above, not merely a bigger
  version of it: the read/write gap lets a wrongly-scoped session see or
  spoof STATE for a workspace that isn't theirs; this lets a
  correctly-scoped session make a STRANGER'S EDITOR EXECUTE CODE. Closing
  `workspace.root` scoping for commands is at least as urgent as closing it
  for presence, and arguably more so.
- **Session-id takeover doubles as command interception once commands
  exist — PARTIALLY closed by task #60, one real gap remains.** The
  existing "reconnect replaces the stale connection" design (any caller
  claiming an existing `session.id` supersedes the prior connection) was
  written for presence, where the worst case is a spoofed/duplicated state
  broadcast. With commands, the SAME mechanism let an attacker who reads a
  victim's `session.id` from the presence feed open a NEW connection
  claiming that same id and silently intercept that session's command
  frames as if it were the real editor.

  **What's closed**: `EditorPresenceRegistry.ts`'s `PublisherRecord` now
  binds a `session.id` to its FIRST claimant's own authenticated
  `sessionId` (`AuthenticatedSession.sessionId` — unique per issued
  credential, from `EnvironmentAuth`'s `sessions.issue()`); a LATER claim
  from a KNOWN, DIFFERENT `sessionId` is refused and the refused
  connection is closed with 4402 (deliberately NOT 4401 — see the
  registry's own doc on why sending a credential-class, permanently-stop
  code here would risk permanently stranding a LEGITIMATE editor, not
  just an attacker; see "what's still open" below for why that ambiguity
  exists at all). Round 1 of this fix bound to `subject` instead and an
  independent review reproduced the takeover anyway: EVERY client-facing
  provisioning path (`t3 pair`, the RPC pairing route) hardcodes
  `subject: "one-time-token"`, so two independently-paired real clients —
  no administrative shortcut needed — share an identical subject and an
  equality check on it is vacuous. `sessionId` doesn't have this problem
  (verified: `sessions.issue()` mints a fresh, unique session record on
  every credential exchange regardless of subject collision) and is
  confirmed stable across the legitimate reconnect case that must not
  break (a real editor's WS dropping/reconnecting with its same
  persisted, still-valid token resolves to the SAME `sessionId` every
  time, since token verification looks up the token's persisted session
  record rather than minting a fresh one per request).

  **What's still open (the F2 gap, named by the same review)**:
  `session.id` remains entirely caller-asserted and readable by anyone
  with `orchestration:read` — this fix protects whoever FIRST claims a
  given id from being displaced, but does nothing to stop an ATTACKER
  from being the one who claims it first, before the legitimate editor
  ever does. In that ordering, the attacker becomes "the first known
  claimant," the legitimate editor's later, correct reconnect is the one
  refused, and the attacker goes on receiving that session's commands.
  `sendCommand` still resolves purely by `sessionId` with nothing binding
  a dispatch to the caller's actually-intended recipient. Closing this
  requires binding a `session.id` to an expected identity or
  `workspace.root` BEFORE the race can happen (at pairing/provisioning
  time) or having the dispatcher supply an expected identity that
  `sendCommand` verifies fresh at send time — both cut across
  `EditorPresenceDispatchCommandInput`'s contract and the web client that
  populates it, i.e. the SAME `workspace.root` scoping problem named
  below, not a separate one. Tracked as follow-up work, not closed here.

- **`workspace.root` scoping.** A session with the right role-scope can see
  (subscriber) or publish as (publisher) presence for **every** workspace on
  the machine, not just its own — `AuthOrchestrationReadScope` /
  `AuthOrchestrationOperateScope` are per-role, not per-workspace. This is
  the actual remaining gate.
- **Subscriber credential-rejection visibility.** A separate, lower-severity
  item, tracked independently: a subscriber's pre-upgrade HTTP 401 for a
  missing/invalid credential is not actually visible to a raw browser
  `WebSocket` (a WS handshake failure exposes no status code to JS, by
  spec), so the web client currently cannot distinguish "your token is bad,
  stop retrying" from "the server is unreachable, keep retrying" and
  defaults to the latter. Deliberately NOT closed by the scope-enforcement
  work above — that work's own subscriber SCOPE rejection was specifically
  built to avoid landing in this same blind spot (see the module doc's
  SECURITY NOTE for why it closes post-upgrade instead), but the
  pre-existing CREDENTIAL path was left alone rather than restructured
  as a side effect.
- A test per rule, mutation-proven — a scope check with no test that fails
  when it is removed is not a scope check. This standard is met for the
  per-role scope work; it still needs to be met for `workspace.root`
  scoping once that lands.

## Until then

Local single-user development only. Do not expose this route over a tunnel, a
relay, or a LAN binding, and do not enable it for a multi-user environment —
a caller who correctly holds a read or operate scope, but for a DIFFERENT
project, can still see or publish presence for a workspace that isn't
theirs. This applies with EQUAL force to `presence:command`: it is a
per-role scope, not a per-workspace one, so granting it to any client at
all — even under the "consciously tick it in Connections settings" flow —
means that client can, in principle, address commands to any editor
connected to this server, not just the ones in its own workspace.
