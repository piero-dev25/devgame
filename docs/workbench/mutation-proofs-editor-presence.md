# Mutation proofs — editor presence

A passing test proves nothing until it has been shown to fail against the bug
it claims to guard. Each guard below was broken deliberately, the suite run to
confirm RED, then restored from a backup copy and re-run to confirm GREEN.

Restores were done from a `cp` backup, never `git checkout --`, and the tree
was confirmed clean (`git status --porcelain` empty) afterwards.

| #   | Guard                                           | Mutation                                                           | Result                                                                                                                                 |
| --- | ----------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Unreal sends the FLAT selection shape           | `protocol.py`: rebuild the frame nested under `selection`          | **RED** — 1 failure + 6 errors; GREEN on restore                                                                                       |
| 2   | An application close (≥4000) must NOT reconnect | `connection.ts`: add `scheduleReconnect()` to the ≥4000 branch     | **RED** — "an application-level close (code >= 4000) shows the server's reason verbatim and does not reconnect"; 8 others still passed |
| 3   | Publisher auth happens AFTER the upgrade        | `EditorPresenceRoute.ts`: move auth back before `request.upgrade`  | **RED** — both "closes a missing-credential publisher upgrade with 4400 after accepting it" and the 4401 twin                          |
| 4   | Godot caps a selection at 64 items              | `epp_selection.gd`: `MAX_ITEMS := 64` → `999`                      | **RED** — "cap: 80 selected nodes truncate to 64 — 80"                                                                                 |
| 5   | Nothing selected attaches NOTHING               | `editorSelectionContext.ts`: delete the `chips.length === 0` guard | **RED** — "attaches nothing when there is nothing selected or pinned"                                                                  |

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
