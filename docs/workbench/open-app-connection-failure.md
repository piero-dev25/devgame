# OPEN: the app cannot complete connection setup with its own environment

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
