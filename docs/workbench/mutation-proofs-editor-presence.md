# Mutation proofs — editor presence

A passing test proves nothing until it has been shown to fail against the bug
it claims to guard. Each guard below was broken deliberately, the suite run to
confirm RED, then restored from a backup copy and re-run to confirm GREEN.

Restores were done from a `cp` backup, never `git checkout --`, and the tree
was confirmed clean (`git status --porcelain` empty) afterwards.

| #   | Guard                                                                                                                      | Mutation                                                                                                                                                                                                                                                  | Result                                                                                                                                                                                                                                                                                                                       |
| --- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Unreal sends the FLAT selection shape                                                                                      | `protocol.py`: rebuild the frame nested under `selection`                                                                                                                                                                                                 | **RED** — 1 failure + 6 errors; GREEN on restore                                                                                                                                                                                                                                                                             |
| 2   | An application close (≥4000) must NOT reconnect                                                                            | `connection.ts`: add `scheduleReconnect()` to the ≥4000 branch                                                                                                                                                                                            | **RED** — "an application-level close (code >= 4000) shows the server's reason verbatim and does not reconnect"; 8 others still passed                                                                                                                                                                                       |
| 3   | Publisher auth happens AFTER the upgrade                                                                                   | `EditorPresenceRoute.ts`: move auth back before `request.upgrade`                                                                                                                                                                                         | **RED** — both "closes a missing-credential publisher upgrade with 4400 after accepting it" and the 4401 twin                                                                                                                                                                                                                |
| 4   | Godot caps a selection at 64 items                                                                                         | `epp_selection.gd`: `MAX_ITEMS := 64` → `999`                                                                                                                                                                                                             | **RED** — "cap: 80 selected nodes truncate to 64 — 80"                                                                                                                                                                                                                                                                       |
| 5   | Nothing selected attaches NOTHING                                                                                          | `editorSelectionContext.ts`: delete the `chips.length === 0` guard                                                                                                                                                                                        | **RED** — "attaches nothing when there is nothing selected or pinned"                                                                                                                                                                                                                                                        |
| 6   | Publisher requires `AuthOrchestrationOperateScope`                                                                         | `EditorPresenceRoute.ts`: revert to the pre-scope-check baseline (no scope check at all)                                                                                                                                                                  | **RED** — "closes a publisher session that authenticates but lacks the operate scope, credential-class" timed out (60s) waiting for a close that never came, because the unscoped session was never rejected; GREEN on restore                                                                                               |
| 7   | Subscriber requires `AuthOrchestrationReadScope`                                                                           | `EditorPresenceRoute.ts`: same pre-scope-check baseline as #6                                                                                                                                                                                             | **RED** — the subscriber scope test's `assert.isFalse(outcome.opened)` failed (`expected true to be false`) — an unscoped subscriber connected freely; GREEN on restore                                                                                                                                                      |
| 8   | A rejected publisher never calls `registry.registerPublisher`, even if a `hello` is processed the instant `onOpen` settles | `EditorPresenceRoute.ts`: reintroduce `authenticate.pipe(catchIf, catchIf, Effect.map(() => connectionToken = registry.newConnectionToken()))` — the trailing `Effect.map` runs unconditionally, even after a `catchIf` recovers a rejection into success | **RED** — both "a publisher rejected for insufficient scope..." and "a publisher rejected for a bad credential..." failed with `registerPublisherCallCount()` returning `1`, not `0`; GREEN on restore                                                                                                                       |
| 9   | A rejected subscriber never receives a `presence` frame, even if `registry.addSubscriber` is called before the scope check | `EditorPresenceRoute.ts`: move `registry.addSubscriber(send)` / `send(initialFrame)` above the scope check inside `runSubscriberConnection`'s `onOpen`                                                                                                    | **RED** — "closes a subscriber session that authenticates but lacks the read scope, ... before any presence frame reaches it" failed: `outcome.messages` was `['{"v":1,"type":"presence","editors":[]}']`, not `[]` — the connection still closed with the right code, but only after leaking a real frame; GREEN on restore |

Guards #8 and #9 are deliberately NOT proven over a real WebSocket, unlike
#1–#7 — `EditorPresenceRoute.test.ts`'s own module doc records why a
real-network reproduction of the `connectionToken` race was tried first and
abandoned (`effect`'s `Socket.ts` propagates a rejection's close faster than
any client-side timing can lose the race, in either direction, in this
runtime). Guard #8 instead drives `runPublisherConnection` (exported for
exactly this) directly with a fake `Socket` that deterministically invokes
the message handler right after `onOpen` settles — no timing, no flakiness.
Guard #9 IS a real-wire test (subscribers don't have a comparable exported
seam), which is why its mutation is a source change rather than a fake.

Every mutation failed the _named_ test that describes the behaviour and left
its siblings passing, which is the property that matters: the guard is specific,
not incidentally coupled to unrelated assertions.

## The near-miss worth recording

Mutation 3 was first run as
`pnpm exec vp test run --project unit src/.../EditorPresenceRoute.test.ts`,
copied from the web app's invocation. The server workspace has no `unit`
project, so vitest exited with `No projects matched the filter "unit"` and the
grep for `FAIL`/`Tests` matched nothing at all.

Piped through `grep`, that produced **empty output for both the mutated and the
restored run** — which reads exactly like "no failures". Had it not been
re-run bare, mutation 3 would have been recorded as a pass while never having
executed a single test.

This is the vacuous-verification failure mode in its purest form: the check
appeared to succeed because the command never ran. Any mutation run whose RED
phase produces _no_ output is not evidence — a mutation that changes nothing
visible is indistinguishable from a command that did nothing at all.

## Not covered

These are unit-level guards. They say nothing about the Unity or Unreal editor
bindings, which cannot be executed on this machine at all, nor about the Godot
addon's `EditorSelection` binding, which needs the editor open. Those remain
listed in each package's own UNVERIFIED notes.
