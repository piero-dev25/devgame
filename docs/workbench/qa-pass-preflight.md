# QA pass preflight — quiesce, restart, and environment-vs-product triage

Companion to `qa-plan-final.md`. That plan is written, not run. This document
is the gate its runner clears **before** starting Section A — written after a
live smoke pass on 2026-08-04 found the checkout in a state that would have
made the QA pass unusable if run as-is: the backend was restarting every
10–90 seconds all night from other lanes' live edits, and the resulting
WebSocket churn is, from inside the app, visually indistinguishable from a
real connectivity defect. Running the plan against that would have produced a
list of failures that were part environment noise and part real, with no way
to tell which was which — worse than not running it.

This is not a first occurrence. `docs/workbench/open-app-connection-failure.md`
documents the same class of event once already: "Four lanes edited server
files under `node --watch` all night; the process restarted repeatedly and
eventually stopped listening entirely. That is an orchestration error, not a
product defect — but it made every observation during that window
untrustworthy." This document exists so the next person doesn't have to
rediscover that the hard way mid-pass.

**Every command below marked "confirmed live" was run against the actual
running stack tonight without stopping it. Everything marked "written, not
exercised" is a reasoned procedure that has not itself been through a real
stop→restart→reverify cycle — see section 6.**

## 1. Two launch shapes — know which one you're gating

- **`pnpm dev`** (equivalently `vp run --filter=@t3tools/contracts
  --filter=@t3tools/web --filter=t3 --parallel dev`, which is the literal
  command `scripts/dev-runner.ts` resolves `dev` to): the web-only dev stack.
  Runs the server under `node --watch src/bin.ts`. This is what's actually
  running on this machine right now, shared across lanes, and it's what
  produced tonight's churn — hot-reloading is exactly the property that makes
  it vulnerable to a concurrently-edited checkout.
- **`pnpm dev:desktop` / `npm run start:desktop`** — the launch
  `qa-plan-final.md`'s own "Launching the app under test" section actually
  requires (desktop, not a browser tab, because `isPreviewSupportedInRuntime()`
  gates the three.js preview check to the desktop runtime). Per
  `docs/workbench/wave-0-baseline.md`: this builds `@t3tools/web` and packs
  the server CLI (`t3#build`), then Electron spawns the **built**
  `apps/server/dist/bin.mjs` as its own backend. Not `--watch` — it doesn't
  restart on later edits — but it embeds whatever the tree looked like at
  build time. A build kicked off mid-edit can bake in a broken half-edited
  file just as easily as HMR can crash on one; same underlying hazard
  (untrustworthy tree), different mechanism (a bad snapshot instead of a
  flapping process).

Consequence: quiescing the checkout (section 2) is a precondition for
**either** launch shape, not just the one that visibly restarts. The clean
restart recipe in section 3 is written for the web dev stack specifically,
because that's the one actually running and shared tonight; treat the
desktop build-and-launch as a separate step that only starts once section 2
passes.

## 2. Confirm the checkout is quiesced

**Signal A — restart count over a settling window**, read from the dev
runner's own stdout, not assumed.

The dev-runner's stdout is the source of truth. If you don't already have the
path, find it from the live process rather than guessing:

```sh
lsof -p <vp-run-pid> 2>/dev/null | grep -E '\s[12][uw]\s'   # fd1/fd2 -> the log file, if redirected
```

Confirmed live tonight: both the orchestrator PID and its vite-plus child had
fd1/fd2 pointing at the same file, which was the actual growing stdout of the
running stack, not a stale copy — the file's inode matched, and its `mtime`
tracked wall-clock time exactly with each observed restart.

```sh
grep -n "Restarting 'src/bin.ts'" <path-to-log> | tail -20
```

Concrete numbers observed live tonight, 02:44–02:49am: restarts at 02:44:23,
02:44:49, 02:48:17, 02:48:25, 02:48:35 — three inside 20 seconds at the busy
end. Treat anything that recent as still hot. **Proposed threshold: zero
restarts in the trailing 3 minutes** — chosen because it comfortably exceeds
any single QA checklist item's expected interaction time, but this is a
reasoned proposal, not something observed to actually be sufficient; see
section 6.

**Signal B — working-tree activity**, independent of the log, because a lane
can be editing something the web build absorbs via HMR without restarting
`src/bin.ts` at all (a `.tsx` file, for instance):

```sh
git status --porcelain > /tmp/qa-quiesce-a.txt
sleep 120
git status --porcelain > /tmp/qa-quiesce-b.txt
diff /tmp/qa-quiesce-a.txt /tmp/qa-quiesce-b.txt
```

Any difference means someone is still actively changing files in this shared
checkout — quiesce fails regardless of what signal A said. Both signals must
pass. Neither check stops or restarts anything; both are purely observational
and were run this way against the live stack.

## 3. Clean restart recipe (web dev stack)

**Written, not exercised this session** — do not stop the currently-running
stack to test this; other lanes depend on it. The steps below are assembled
from `docs/workbench/wave-0-baseline.md` (which established this exact
convention) and cross-checked against the live process's actual environment
tonight, not run start-to-finish as a fresh boot.

From the repo root (`/Users/pieroherrera/Projects/t3code-fork` — confirmed
this is the shared **main checkout**, not a linked worktree: its `.git` is a
directory, not a `gitdir:`-pointer file, so `resolveWorktreeT3Home` in
`packages/shared/src/devHome.ts` returns `undefined` here and AGENTS.md's
"in a worktree, state defaults to that worktree's own `.t3`" auto-safety-net
**does not apply to this checkout**):

```sh
export T3CODE_HOME="$PWD/.t3-dev"     # not optional here — see hazard below
pnpm dev
```

Read the actual ports from the `[dev-runner]` banner line rather than
assuming `13773`/`5733` — they shift when occupied. Confirmed live tonight:

```
[dev-runner] mode=dev source=default ports serverPort=13773 webPort=5733 baseDir=/Users/pieroherrera/Projects/t3code-fork/.t3-dev
```

### Hazard 1 — the missing-env-var default is the owner's real data

`scripts/dev-runner.ts`'s precedence is `--home-dir` flag → linked-worktree
`.t3` (not applicable here) → ambient `T3CODE_HOME` → `~/.t3`. Skip the
export in this checkout and the server silently lands on `~/.t3` — the
owner's real, shared DevGame database, confirmed present and in current use
on this machine (`~/.t3/userdata` exists). This is not hypothetical: an
earlier launch tonight, preserved in a now-dead log, shows exactly this —
`baseDir=/Users/pieroherrera/.t3` — before the process crashed on an
unrelated `EPIPE`. Whoever ran it had not exported `T3CODE_HOME` first.

### Hazard 2 — a second real instance shares the same display label

There is a genuine, installed T3 Code desktop app on this machine, reachable
on port `3773` (not `13773`), whose environment label is **also** "Piero's
Mac Studio" — documented in `docs/workbench/open-app-connection-failure.md`.
Any admin CLI action (`t3 pair`, `auth pairing create`, etc.) run without an
explicit base dir can resolve against *that* instance instead of the dev one,
and its failure (`invalid_credential`) looks exactly like a broken auth
system rather than "wrong instance." Pass an explicit base dir / `T3CODE_HOME`
to every CLI invocation, not just the dev-runner itself — the label alone
never disambiguates the two.

### Healthy-boot verification

Non-destructive checks, confirmed live tonight against the already-running
instance (not from a fresh boot — see section 6):

```sh
curl -s http://localhost:<webPort>/.well-known/t3/environment
# confirmed live: {"environmentId":"9414c7d1-2ced-4c15-afef-f5971e365722",
#   "label":"Piero's Mac Studio","platform":{"os":"darwin","arch":"arm64"},
#   "serverVersion":"0.0.31","capabilities":{...}}

curl -s -o /dev/null -w '%{http_code}\n' http://localhost:<webPort>/
# confirmed live: 200
```

Record the `environmentId` before and after any restart. Unchanged means the
same dev database survived; changed means a fresh one — expected right after
wiping `.t3-dev`, a red flag otherwise. Never rely on the `label` field to
identify which instance you're talking to (hazard 2, above) — always check
`environmentId`.

Server log should show one `Listening on http://127.0.0.1:<serverPort>` line
with no following `Restarting` line for at least the quiesce window (section
2).

### WS-holds-connection check

The one piece of section 3 that genuinely needs a browser rather than curl —
confirmed live against the already-running, already-connected instance
tonight, **not** from a cold restart:

1. Open the app in a real, foregrounded, focused browser tab — not headless,
   not backgrounded (see section 4's second cause for why this matters).
2. Watch the environment banner for at least 60 seconds without touching
   anything.
3. **Pass:** connected state holds the whole window, no reconnect chip.
   **Fail:** "Connecting…" or "Failed to connect. Reconnecting…" appears
   during that window. If it does, go to section 4 before writing anything
   down.

## 4. Environment failure vs. product failure — the fast check

The same visible banner — "Piero's Mac Studio: Failed to connect.
Reconnecting…", "…could not establish a WebSocket connection" — has **two
separate, already-documented causes** that have nothing to do with each
other. Check both before treating it as a finding:

| Check | How | If this is the cause |
| --- | --- | --- |
| Backend restart churn | `grep "Restarting 'src/bin.ts'"` in the dev-runner's stdout for the ~60s before the failure timestamp you observed | Not a defect. `node --watch` reacted to a live edit from another lane — confirmed live tonight by matching restart timestamps (02:44:23, 02:44:49) to the exact moment the banner flipped in the browser. Wait for a quiesced window (section 2) and retry the same step before concluding anything. |
| Tab visibility / backgrounding | Was the browser tab genuinely foregrounded and focused the whole time, or could it have been occluded (driven by an automation tool, or the window lost focus)? | Not necessarily a defect either. `docs/workbench/open-app-connection-failure.md` traced a near-identical banner to Chrome throttling nested `setTimeout` chains in a hidden tab — a ~200ms `server.getConfig` decode stretched to ~42s against the 15s `CONNECTION_ESTABLISHMENT_TIMEOUT` (`packages/client-runtime/src/connection/supervisor.ts:509-530`). That doc's own one-minute check: bring Chrome to the front, focused and unoccluded, reload. If the banner clears, it was the tab. This is tracked separately (task #29, "likely a measurement artifact," not settled) — don't re-open it as a new finding under a different name. |

If **neither** explains it — no restart in the window, and the tab was
genuinely foregrounded the whole time — that's the case worth writing down as
a real finding. Everything else is environment noise, however convincing it
looks from inside the app.

## 5. Existing state — reuse it, don't manufacture over it

The smoke pass (2026-08-04) found real, already-existing threads in this
fork's `.t3-dev` state (none of it is Deepmind, none of it is the shared
`~/.t3`):

- A Unity-engine project ("Mafia" / "Mafia Game") — engine selector reads
  "Unity", Play button present. Confirm which Unity path it's actually wired
  for (A3 in `qa-plan-final.md` is the server-side CLI path, not Editor
  Presence) before relying on it for a specific sub-check.
- A no-engine project ("wb-e2e") with several real threads — "Reply with
  promoted," "Testing," "Reply with the word two," "Explain jumpVelocity in
  physics.js" — useful for Section B (dock panel) checks that don't need an
  engine.
- A third project ("not-a-repo," thread "Reply With Ready") — not inspected
  further, noted for completeness.

If a check genuinely needs fresh data (e.g. a negative-path check that
depends on a project with no prior state), prefer a new thread under an
**existing** project over registering a brand-new one, so the project list
doesn't grow unbounded across repeated QA runs.

## 6. What's verified live vs. written-but-unexercised

Stated plainly rather than left to bleed together:

**Verified live tonight:** the restart-churn signal and its cadence (section
2); the healthy-boot curl checks and the `.well-known/t3/environment`
response shape (section 3); the `T3CODE_HOME` precedence logic, read from
`scripts/dev-runner.ts` and cross-checked against the live process's actual
environment; the WS-holds-connection behavior of the *already-running,
already-connected* instance; the existing-state inventory (section 5).

**Written, not exercised:** the full stop→restart→reverify cycle in section 3
— the running stack was deliberately left alone, per instruction, since other
lanes depend on it; the `dev:desktop`/`start:desktop` build-and-launch path
(section 1) was not run this session; the 3-minute quiesce threshold is a
reasoned proposal, not something observed to be sufficient or necessary; and
the WS-holds-connection pass condition is framed from an already-connected
instance's behavior, not from a cold boot's first handshake.

**Hard constraint, unchanged from every other document in this set: nothing
here mutates anything under `~/Projects/Deepmind`.**
