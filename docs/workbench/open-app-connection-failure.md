# SOLVED (mechanism), and it was very likely never a product bug

> **Update 2026-08-03, root cause found.**
>
> **Nothing hangs and nothing is swallowed. The server answers in ~75 ms. The
> client then spends ~42 seconds DECODING the reply, and the 15-second
> `CONNECTION_ESTABLISHMENT_TIMEOUT` fires first.**
>
> `server.getConfig` returns ~292 KB — `providers` alone is 300,618 bytes, of
> which opencode contributes 159,754 enumerating 381 models. Decoding it yields
> to Effect's fiber scheduler **48 times**, and that scheduler yields via
> `setTimeout(fn, 0)`. Chrome clamps nested timers to ~1000 ms **in a hidden
> tab**: 48 × ~1000 ms predicts 48 s, and 42 s was measured.
>
> Proven three ways: an A/B on the same socket (a small `server.probe` round
> trips in 20 ms while the large reply never resumes — so dispatch, socket and
> auth are all fine); the same decode run in Node costs 13–27 ms of CPU across
> 48 yields; and raising the timeout to 600 s let the app connect normally.
>
> **Why eight hypotheses missed it.** Chrome's network panel and
> `read_network_requests` **do not show WebSocket frames**. The "app makes two
> HTTP calls and then nothing" clue that drove the whole investigation was an
> artifact of the instrument — the socket, the request and the 285 KB reply
> were there the entire time.
>
> **Independently confirmed here.** Timing twelve nested `setTimeout(0)` calls
> in the live hidden tab did not complete within a 45-second limit, while a
> synchronous evaluation in the same tab returns instantly. Synchronous work
> runs; timer chains are throttled to a standstill. A 48-yield decode cannot
> finish in 15 s under those conditions.
>
> **This is upstream's code, untouched by the fork.** `git log
69dfb7f09a..HEAD -- packages/client-runtime packages/contracts/src/server.ts`
> is empty. The 15 s constant is upstream's and byte-identical at the
> merge-base. Do not patch it here.
>
> **THE MEASUREMENT TRAP, which is the real lesson.** Any agent-driven
> verification through a background or occluded browser window reproduces this
> as a false product failure — and will do so for any other large RPC. Hours
> went into chasing a defect that may not exist outside the instrument.
>
> **STILL UNCONFIRMED: the foreground case.** At Chrome's foreground clamp of
> 4 ms the same decode predicts ~205 ms, comfortably inside budget — but that
> is a prediction, not an observation. Both tabs report
> `visibilityState: "hidden"` because the window is occluded, and desktop
> control is owner-policy routed through Codex rather than driven here.
>
> **The one-minute check that settles it:** bring Chrome to the front, focused
> and unoccluded, and reload the app. If the banner never appears, there is no
> product bug and the fix is documentation only. If it still appears, the
> payload is genuinely too large for the budget and the fix is the design change
> below.
>
> **If it does fail in the foreground**, the defect is upstream's design: a flat
> 15 s deadline covering socket-open _plus_ a decode whose cost scales with the
> installed provider catalog, with no progress signal — so a slow environment
> becomes an unwinnable retry loop that redoes the same work on the same budget.
> The right fix is a **progress-based deadline** (arm for the handshake, disarm
> once the response is in flight), not a larger constant, and it belongs
> upstream. A local workaround would be to keep `providers` off the
> establishment critical path.

---

# Original investigation (superseded above, kept for the eliminated hypotheses)

> **Update 2026-08-03, after the dev-proxy fix (`e8c02bfbd`).**
>
> A fresh critic found that `/editor-presence` was missing from
> `DEV_PROXIED_PATH_PREFIXES`, so vite accepted the upgrade and never answered
> it. The proposed causal chain was: hung presence sockets accumulate → Chrome's
> per-profile pending-connection limit is exhausted → the app's own `/ws` is
> starved → this banner. The critic measured the starvation directly and was
> explicit that "fixing the prefix fully fixes the environment connection" was
> **not** proven.
>
> **It is now disproven.** With the fix in, a single tab, and no other app tab
> open:
>
> - the presence chip connects and renders reliably — that half is fixed and
>   verified repeatedly;
> - **this banner still appears.**
>
> So the missing prefix was a real bug worth fixing on its own merits, and the
> presence feature really was creating hung sockets — but it is not the cause of
> this failure. Everything below still stands, and the open question is
> unchanged: the app makes two `GET /api/auth/session` calls, both 200, and then
> never reaches ticket-minting or a socket.
>
> One hypothesis this update ADDS to the eliminated list: connection-pool
> starvation by presence sockets.

The one thing standing between editor presence and being visibly usable. The
chips render and the indicator shows "Editor presence: connecting…", but they
never populate, because there is no `PreparedConnection` to mint a ticket
against.

```
Piero's Mac Studio: Failed to connect. Reconnecting…
Piero's Mac Studio did not respond during connection setup.
```

Origin: `packages/client-runtime/src/connection/supervisor.ts:509-530` —
`CONNECTION_ESTABLISHMENT_TIMEOUT` is 15 seconds, raced against acquiring a
connected lease. The timeout wins.

**This is NOT caused by the editor-presence work.** It predates it (it was
already logged before that work began) and it reproduces with a completely
fresh server process and a fresh pairing.

## What has been ELIMINATED, each by measurement

| Hypothesis                           | Verdict | Evidence                                                                                                                           |
| ------------------------------------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| The server is unhealthy              | **No**  | HTTP 200s, and a browser WebSocket to `/editor-presence` connected and received live presence frames from a real Godot publisher   |
| The vite dev proxy drops the upgrade | **No**  | A raw WS upgrade returns a byte-identical `401 missing_credential` through `localhost:5733` and directly against `127.0.0.1:13773` |
| The proxy targets the wrong backend  | **No**  | `/.well-known/t3/environment` through vite reports `9414c7d1…`, matching the backend and the app's own URL                         |
| A stale browser session              | **No**  | Re-paired twice via `t3 pair`, including once against a freshly restarted server. Unchanged                                        |
| The backend was simply down          | **No**  | It _was_ down at one point (see below), but the failure reproduces identically against a healthy, freshly booted server            |
| Broken in-flight code                | **No**  | `tsgo --noEmit` reports 0 errors and the server boots clean on a spare port                                                        |
| An environment-id mismatch           | **No**  | App URL, backend descriptor and proxy all report the same id                                                                       |

## What is NOT eliminated

Something in the client's stored connection state or its primary-environment
resolution. The app makes exactly two HTTP calls — both `GET
/api/auth/session`, both 200 — and then never reaches ticket-minting or a
socket. Whatever fails, fails _before_ any request the network panel can see.

The next person should instrument `ConnectionResolver.prepare` /
`ConnectionDriver.connect` (`packages/client-runtime/src/connection/`) and find
out what the lease acquisition is actually waiting on. That is the one question
left.

## Two traps found on the way, both of which cost real time

**There is a second T3 Code on port 3773.** The user's _installed desktop app_,
environment `e8123456…`, label "Piero's Mac Studio" — the same label our fork's
server reports, because it is just the machine name. Every instance looks
identical in any message that prints a label.

`t3 pair` with no `T3CODE_HOME` resolves to THAT instance, mints a valid token
against it, and the token then fails with `invalid_credential` at our server —
a failure that looks exactly like a broken auth system. Always:

```
T3CODE_HOME=<repo>/.t3-dev node src/bin.ts pair --label "…"
```

**Do not run a live-UI verification against a dev server that agents are
editing.** Four lanes edited server files under `node --watch` all night; the
process restarted repeatedly and eventually stopped listening entirely. That is
an orchestration error, not a product defect — but it made every observation
during that window untrustworthy, and it burned time chasing a symptom that was
partly self-inflicted.

## State left behind

The `node --watch` dev server that was running on 13773 died. A replacement was
started on the same port with the same `T3CODE_HOME=.t3-dev`, so the
environment id and data are unchanged — but it is a **plain `node` process, not
`--watch`**, so it will NOT hot-reload on source edits. Restart it under the
normal dev script when convenient.
