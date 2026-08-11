# The "websocket port-timing" flake — recharacterized, not reproduced

Task #59. Written up because the original title turned out to be a guess, and
the corrected picture is more useful than the guess even without a live
reproduction.

**Status:** NOT reproduced despite 41 attempts across four distinct regimes.
No code changed. This document is the deliverable — see the closing section
for why a fix wasn't attempted on the strength of what's here.

---

## The original claim, and what's actually behind it

Task #59's title: "Intermittent test flake — websocket port-timing in
`apps/server`." The only hard fact behind that title is: during an earlier
`apps/server` full-suite run this session, `ProviderRuntimeIngestion.test.ts`
failed once; a clean re-run immediately after came back green.

**The original error text was never captured.** That's a real gap in the
methodology at the time, not a detail being glossed over — it means the
"websocket port-timing" mechanism was never established from evidence. It was
inferred from the file name and a guess, then written down as if it were a
diagnosis. The rest of this document is what happens when that inference gets
checked instead of trusted.

---

## Reproduction attempts: 41, zero failures

| # | Regime | Count | Result |
|---|---|---|---|
| 1 | Solo full `apps/server` suite, back-to-back | 6 runs | 0 failures |
| 2 | Two full suites launched **concurrently** against each other (deliberate cross-process resource contention) | 2 runs | 0 failures |
| 3 | `PortScanner.test.ts` alone, tight loop | 25 runs | 0 failures |
| 4 | `ProviderRuntimeIngestion.test.ts` alone, under **verified** sustained ~7-core CPU load (14 background `node -e "while(true){}"` processes, confirmed via `ps aux` at ~50% each throughout, killed and confirmed cleared afterward) | 8 runs | 0 failures |

Regime 2 was chosen because a websocket/port mechanism would most plausibly
need cross-process contention to manifest. Regime 4 was chosen because if the
real mechanism is scheduler latency under load (see below), CPU saturation is
the variable that should trip it. Neither did.

**This means: no fix here would be built on a demonstrated mechanism.**
Widening a timeout or changing port allocation on the strength of a guess is
how a flake gets rarer without getting correct — and rarer is worse, because
it survives long enough to fail during a verification pass instead of during
development, which is exactly the moment its cost is highest.

---

## `ProviderRuntimeIngestion.test.ts` has no network code at all

Re-read `createHarness()` in that file specifically to check the "websocket"
half of the title. It composes:

- `ManagedRuntime.make(layer)` — in-process, no sockets
- A hand-written fake `ProviderServiceShape` (`streamEvents` backed by a
  `PubSub`, `startSession`/`sendTurn`/etc. all synchronous stubs)
- `SqlitePersistenceMemory` — in-memory SQLite

Nothing in this file can produce a literal port or websocket race. Whatever
tripped it once, it wasn't that.

## What the file *does* have: a hand-counted wall-clock deadline

`waitForThread` (`ProviderRuntimeIngestion.test.ts:173-193`):

```ts
async function waitForThread(readModel, predicate, timeoutMs = 2000, threadId = ...) {
  const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + timeoutMs;
  const poll = async () => {
    const snapshot = await readModel();
    const thread = snapshot.threads.find(...);
    if (thread && predicate(thread)) return thread;
    if ((await Effect.runPromise(Clock.currentTimeMillis)) >= deadline) {
      throw new Error("Timed out waiting for thread state");
    }
    await Effect.runPromise(Effect.yieldNow);
    return poll();
  };
  return poll();
}
```

This is exactly the failure class flagged the same night, hours earlier, in
task #81's own test methodology: **a fixed budget is a silent ceiling under
load, not a correctness bound.** Under genuine system contention, an Effect
fiber that normally resolves in single-digit milliseconds can legitimately
take longer than 2000ms with no bug behind it — the assertion doesn't
distinguish "the code is broken" from "the scheduler was busy."

That's a *plausible* mechanism for the one observed failure. It is not a
*proven* one — regime 4 above ran this exact file under real, confirmed CPU
saturation eight times and never tripped it. Stated as what it is: the more
likely of two unproven candidates, not a diagnosis.

## The same shape, duplicated across nine files

Grepped for the same pattern (`Clock.currentTimeMillis`-based deadline, poll
loop, throw on timeout) rather than treating the one instance as isolated:

- `apps/server/src/provider/Layers/ProviderSessionReaper.test.ts`
- `apps/server/src/provider/Layers/CursorProvider.test.ts`
- `apps/server/src/provider/Layers/CursorAdapter.test.ts`
- `apps/server/src/provider/Layers/GrokAdapter.test.ts`
- `apps/server/src/terminal/Manager.test.ts`
- `apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts`
- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts`
- `apps/server/src/orchestration/Layers/CheckpointReactor.test.ts`
- `apps/server/src/server.test.ts`

Spot-checked `CheckpointReactor.test.ts`: three separate instances in that one
file alone (thread state, orchestration event, git ref), each an exact
structural match — same deadline computation, same 10ms-sleep poll loop, same
throw shape. This is a systemic pattern in this test suite's integration
helpers, not an incidental one-off in the file that happened to fail once.

**Recommended fix shape, not built:** a shared polling helper with a
generously large ceiling and an explicit comment that the timeout is a safety
valve against a genuinely hung test, not a correctness bound — or replace the
hand-rolled `while` loop with `Effect.retry`/`Schedule`, which makes the
"how many attempts, how much total time" budget a declared policy instead of
an ad hoc recomputed deadline in nine separate places.

**Why this wasn't done tonight:** nine files of test-infrastructure change,
none of it individually exercised against a proven failure, immediately
before a verification sweep, is the same trap that produced most of tonight's
other meaningless-green-test findings — a change that looks like a fix and
has never been watched catching the thing it claims to fix. This is a
scoping decision for whoever picks it up next, not a technical blocker.

---

## A second, separate, genuinely port-shaped finding: `PortScanner.test.ts`

Independent of the timeout theory above. `PortScanner.test.ts`'s
`commonDevServer` resource (`Effect.acquireRelease` wrapping
`openCommonDevServer`, which iterates `PortScanner.COMMON_DEV_PORTS` — 3000,
3001, 3333, 4173, 4200, 4321, 5000, 5173, 5174, 5175, 5500, 8000, 8080, 8081,
8888, 9000) is the **only** place in the whole `apps/server` test suite that
binds a real, fixed, well-known TCP port instead of an OS-assigned ephemeral
one (`port: 0`, the pattern every other real-server test in this suite uses
correctly — `server.test.ts`, `bin.test.ts`).

Two adjacent tests in the same `describe` block each independently
acquire/release this resource — a close-then-reopen cycle on the same real
port, back to back, between two tests. 25 solo runs of this file didn't trip
it, so this isn't proven as a live-failure cause either. But it carries a risk
the other candidate doesn't: **it can collide with an actual dev server the
owner has running locally** on one of those exact ports, which is a real,
plausible, environment-not-product cause of a red `PortScanner.test.ts` during
any QA pass or verification sweep that happens to coincide with the owner
running `npm run dev`/`vite`/etc. on their own machine.

**Not changed to ephemeral ports** — detecting a server on a *known, common
dev port* is the feature under test; switching to `port: 0` would make the
test pass without testing what it's for.

---

## Summary for whoever picks this up

- No proven root cause. 41 attempts, four regimes including deliberate
  concurrency and verified CPU saturation, zero reproductions.
- The title's literal claim ("websocket port-timing") doesn't match
  `ProviderRuntimeIngestion.test.ts`'s actual code — there's no network layer
  there to race.
- Best-evidenced candidate: `waitForThread`'s hand-counted 2000ms deadline,
  duplicated across nine files — a systemic anti-pattern, not proven as this
  flake's cause, but a real defect shape independent of whether it's the
  cause.
- Second, separate, genuinely port-shaped candidate: `PortScanner.test.ts`'s
  fixed-port acquire/release cycle — also unproven, but the one place in the
  suite architecturally capable of a literal port collision, and the one with
  a plausible non-product explanation (a real dev server on the owner's
  machine).
- See `docs/workbench/qa-pass-preflight.md` section 4 for the triage entry
  this produced: if `PortScanner.test.ts` fails during a QA pass, check for a
  listener on the common dev ports before recording it as a defect.
