# QA environment procedure

Companion to `qa-plan-final.md`. Read this **before** running the pass.

**Why this exists.** A smoke pass found the backend restarting every 10–90
seconds — `node --watch` reacting to six lanes editing files — and matched those
restarts to WebSocket drops in the browser. Sending a chat message and opening a
terminal both depend on that connection, and both are load-bearing QA steps. Run
the pass against a restarting backend and you get a failure list where
environment noise and real defects are indistinguishable, which is worse than
not running it.

Each step below is labelled **VERIFIED** (observed on the live stack while
writing this) or **UNEXERCISED** (written from source, not run — the dev stack
could not be restarted because other lanes were using it). Treat UNEXERCISED
steps as a first draft that may need correcting in the moment.

---

## 1. Confirm the checkout is quiesced

**Do not eyeball this.** "Seems quiet" is not observable; a restart is.

### The restart signal — VERIFIED

`node --watch src/bin.ts` does **not** restart in place. It keeps its own pid and
**replaces its child process** on every reload. So the child's pid and start time
are a restart counter that needs no log access.

Observed while writing this:

```
watcher parent   pid 99135   started 00:02:40
its child        pid 40143   started 02:55:55
```

Nearly three hours apart on the same stack — the parent is stable, the child is
what churns.

### The check

```sh
# 1. find the watcher (stable across restarts)
pgrep -f "node --watch src/bin.ts"

# 2. sample its child twice, 90s apart
WATCHER=<pid from step 1>
pgrep -P "$WATCHER" | while read p; do
  echo "child=$p started=$(ps -o lstart= -p "$p")"
done
sleep 90 && <repeat>
```

**Quiesced = the child pid and start time are identical across both samples.**
Different pid ⇒ at least one restart in the window ⇒ **do not start the pass.**

90 seconds is chosen to exceed the upper end of the observed 10–90s restart
interval. If a lane is mid-edit, this will keep failing; that is the correct
outcome, not an obstacle to route around.

Also confirm nothing is mid-write: `git status --porcelain` in the repo should be
stable across the same window. Files appearing and disappearing means a lane is
actively editing.

---

## 2. The stack, and where its values come from

**Establish these from the runner's own output, not from this document.** The
dev-runner logs one line at startup (`scripts/dev-runner.ts:700-702`):

```
[dev-runner] mode=<mode> source=<source> serverPort=<n> webPort=<n> baseDir=<path>
```

`baseDir` is authoritative for the data directory. If it disagrees with anything
below, believe the runner.

### Observed values — VERIFIED

|          |                                            |
| -------- | ------------------------------------------ |
| Server   | `127.0.0.1:13773`                          |
| Web      | `[::1]:5733`                               |
| Data dir | `<repo>/.t3-dev` — exists at the repo root |

Confirmed with `lsof -nP -iTCP -sTCP:LISTEN` (the `-sTCP:LISTEN` filter matters —
without it `lsof -i` also matches client connections, including a browser's).

### Why `.t3-dev` and not something else — VERIFIED from source

`dev-runner.ts:671-679` resolves the home directory by precedence:

1. `--home-dir` (explicit flag) — wins
2. **the worktree's own `.t3`** — outranks the ambient env var by design, so dev
   state stays off the shared home
3. ambient `T3CODE_HOME`
4. `DEFAULT_T3_HOME`

Note `~/.t3-dev` does **not** exist, and the shared `~/.t3` is the wrong target —
an earlier attempt to use it died on `EPIPE`.

### Clean restart — UNEXERCISED

Written from the scripts, **not run**, because other lanes were using the stack:

```sh
cd <repo> && npm run dev        # scripts/dev-runner.ts dev
```

Then read the `[dev-runner]` line back and confirm `baseDir` ends in `.t3-dev`
and the ports match section 1. **If you are the first to run this, correct this
section from what you actually see.**

---

## 3. Telling environment failure from product failure, mid-pass

**This is the one that decides whether the pass is worth anything.** When a chat
send or a terminal open fails, answer "did the backend just restart?" _before_
writing it down.

### The check that works without log access — VERIFIED mechanism

```sh
pgrep -P "$(pgrep -f 'node --watch src/bin.ts')" \
  | while read p; do ps -o lstart= -p "$p"; done
```

**If that start time is more recent than the moment your action failed, the
backend restarted underneath you. It is not a defect. Redo the step.**

Record the child start time at the beginning of each QA step; comparing it after
a failure is then a one-line answer.

### On log lines — UNEXERCISED

`node --watch` prints `Restarting 'src/bin.ts'` on reload, but **there is no log
file to grep**: `.t3-dev/` contains only `caches/`, `userdata/` and `worktrees/`
(VERIFIED — no `*.log` anywhere under it). That output goes to the terminal
running `npm run dev`, which the QA runner may not own.

That is why the pid check above is the primary method and the log line is the
fallback. If you do have the dev-runner terminal, `Restarting` there is the
direct confirmation.

### Classification rule

| Symptom                                                | Verdict                             |
| ------------------------------------------------------ | ----------------------------------- |
| Action failed **and** child start time moved           | environment — redo, don't record    |
| Action failed, child start time unchanged              | **product defect — record it**      |
| Action failed, then succeeded on retry with no restart | **record it** — a flake is a defect |

The third row matters: "it worked the second time" is not a pass.

---

## 4. Existing test state — do not create data in the owner's real projects

The smoke pass left usable threads on **a Unity project** and **a no-engine
project**. Prefer those over creating new ones.

**Hard constraint: nothing mutating under `~/Projects/Deepmind`.** That is the
owner's real Unity project. It is fine as a _read_ target — engine detection,
selection chips, the `<engine>` headline — but the QA pass must not write to it,
including through an agent turn that edits files.

If a step needs a writable project, create a throwaway outside `~/Projects`
rather than reusing a real one.

---

## What is untested in this document

Stated plainly so nobody trusts it further than it has earned:

- **The clean-restart recipe has not been run.** The stack could not be
  restarted while lanes were using it.
- **The `Restarting 'src/bin.ts'` log line is from `node --watch` behaviour, not
  observed here** — no log file exists to confirm the wording.
- Everything in sections 1 and 3's pid method, and every value in section 2's
  observed table, **was observed on the live stack** and can be relied on.

The first runner to exercise the restart recipe should correct section 2 from
what they see, and delete this note's first two bullets once they have.
