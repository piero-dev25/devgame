# How git status stays fresh — and the one case where it doesn't

Task #31. Written up because the original framing was wrong and the corrected
version is narrow enough to act on.

**Status:** mechanism VERIFIED by reading; the no-focus case is proven by an
executable test (`apps/server/src/vcs/VcsStatusBroadcaster.test.ts`, commit
`8461a8c48`). One question is still open and needs the QA pass — see the end.

---

## The original claim, and why it was too broad

> "Git status goes stale on external edits."

That came from a live repro run while building the Files panel: a line appended
to `physics.js` from a terminal left the panel stale at 0s, 10s, 20s and 40s,
and a hard reload didn't pick it up either.

The observation is real. The generalization isn't. There *is* a refresh path
that covers the workflow the claim implies, and it predates the repro.

---

## What actually refreshes local status

**There is no filesystem watcher on the working tree.** The only `fs.watch` in
the vcs layer is on a git *trace file* (`GitVcsDriverCore.ts:585`).

**There is no local-status poll loop.** Exactly four things refresh it:

| # | Trigger | Where |
|---|---|---|
| 1 | Agent turn completes | `ProviderCommandReactor.ts:785`, `CheckpointReactor.ts:547` |
| 2 | Git mutation through the app (commit, worktree, ref switch…) | `ws.ts:1598`, `:1773`, `:1793`, `:1814`, `:1824`, `:1830`, `:1836`, `:1842`, `:1850` |
| 3 | Explicit RPC | `WS_METHODS.vcsRefreshStatus`, `ws.ts:1758` |
| 4 | **Window `focus` / `visibilitychange`→visible**, debounced 250 ms | `GitActionsControl.tsx:1191-1213` |

Trigger 4 is the one that matters, and it is easy to miss. `GitActionsControl`
is mounted in `ChatHeader.tsx:192`, so it is effectively always live, and
`DiffDockPanel.tsx:78-87` reads the *same* `vcsEnvironment.status` query — so
the Diff panel is covered by it too.

It is also not ours: `git log -S` puts it in `53a552e80` *("Stream git status
updates over WebSocket (#1763)", Apr 2026)* — upstream T3, months before the
repro above.

### Reconciling the two

Both facts are true, and they fit together exactly one way: **that repro never
fired a focus transition.** Someone timing a panel at 0/10/20/40s has the window
focused the whole time, and a hard reload doesn't fire `focus` on an
already-focused window — which also explains the reload result that otherwise
looks like a much deeper bug.

The prior observation is an *instance* of the real gap, not a counterexample.

---

## The real gap: external writes with no focus transition

Four reachable cases. All share one mechanism, so one proof covers the class:

1. **A build, import, or script run in DevGame's own Terminal panel.** The
   window never loses focus. This is the canonical case — it is entirely inside
   our own product surface.
2. **Play started from our own engine toolbar.** Unity writes while playing; no
   focus change, and *no command to complete either* (see below).
3. Unity open on a second monitor while DevGame keeps focus.
4. A background reimport finishing while DevGame is focused.

In all four, status stays stale until an agent turn, an in-app git action, or
the user alt-tabs away and back.

---

## Two names that lie

Both cost real time here, and both were caught the same way — by tracing the
consumer instead of trusting the name.

**`DEFAULT_VCS_STATUS_REFRESH_INTERVAL = Duration.seconds(30)`**
(`VcsStatusBroadcaster.ts:28`) sits at the top of the broadcaster and reads
exactly like "status refreshes every 30 seconds." It governs the **remote**
loop only (`makeRemoteRefreshLoop`, `:382`) — upstream/PR state. Local status is
never polled. Trusting the name yields a confident, wrong "30-second staleness
window."

**`{ type: "idle" }`** in `terminal/Manager.ts:1656,1664` is the *event-drain*
loop's idle, not the subprocess-idle transition. Grepping for `idle` finds the
wrong one first. The subprocess signal is `hasRunningSubprocess` with its
"cleared when idle" child-command name (`:254`).

---

## Fix shape (not built — awaiting the QA answer)

**The completion signal already exists.** `terminal/Manager.ts` tracks
foreground-subprocess lifecycle (`hasRunningSubprocess`, `:254`) and sessions
carry `cwd` (`:235`, exposed `:330`, `:347`). So "a command finished here, in
this directory" is available server-side with no new signal path.

**It is burst-safe by construction, which is the argument for it.** The trigger
is command *completion*, not file writes. A Unity import touching 10,000 files
is one command → one refresh. A filesystem watcher sees 10,000 events and needs
coalescing plus a settling heuristic that will be wrong on someone's machine.
*The completion signal is burst-safe by construction; a watcher is burst-safe
only by configuration.* That argument is independent of the rule about not
modifying upstream code, so it survives even if that rule relaxes.

It degrades well too: a long `unity -batchmode` import refreshes once, on exit,
which is exactly when the answer becomes correct.

**It fixes one of the four cases.** Case 2 (Play from our toolbar) has no
command to complete and needs the engine-presence path instead. Cases 3 and 4
are unreached as well. Say this plainly wherever it ships — a narrowing
presented as a resolution is how a known gap becomes a surprise later.

**Unverified:** the exact emit site of the `hasRunningSubprocess` true→false
transition. That is what stands between "small" and "small, confirmed."

---

## Still open — needs the QA pass, not more reading

**Does the focus path work when actually exercised?** Alt-tab to an editor,
change a file, alt-tab back, watch the Diff panel. Nobody has tested it. Not
answerable by reading or in-process (`#74`: `apps/web` cannot execute a React
effect in a test).

Three outcomes, three different priorities:

- **Works** → the bug is narrow, and the terminal fix above is the right next step.
- **Broken** → far worse than this document says; the one mechanism covering the
  main workflow doesn't, and every user hits it.
- **Works for `GitActionsControl` but not the Diff/Files panel** → a wiring bug
  in our own dock work.

**Hold the (a) leave-it / (b) client-poll / (c) filesystem-watcher decision until
that is answered.** Choosing (c) — a watcher inside T3's own subsystem, against
the standing rule about not modifying upstream without need, and a permanent
merge conflict for every future merge — on the strength of a repro that may
simply have missed an existing mechanism would be the wrong call.
