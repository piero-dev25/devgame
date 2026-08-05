# Spec — delete the Settings → Connections "Unity integration" panel

Repo: `~/Projects/t3code-fork`, branch `workbench/dock-port`.
Closes task #110. Fixes the round-2 QA FAIL on Item 1.

## Why (read this — it decides the shape of the fix)

Live QA round 2 on commit `2ab34a9d8`, on a real Unity project ("Mafia Game"):

- The **chat header** correctly showed engine `Unity` and a `Setup Unity
Integrations` CTA.
- **Settings → Connections → "Unity integration"** simultaneously showed
  _"Not a Unity project"_ / _"This project doesn't look like a Unity project —
  no ProjectSettings/ProjectVersion.txt was found."_, with **no** CLI /
  Pipeline / Editor / selection rows and **no** Retry control.

Two screens, same app, contradicting each other about the same project.

The cause is already diagnosed and is **not** a probe bug. `UnitySetupSection`
fetches the probe for **`primaryEnvironmentId`** — the local backend's own
bound project (`ServerConfig.cwd` server-side) — regardless of which project
the user is looking at. Against any thread whose environment differs from the
primary one, it reports the **wrong project** under a heading naming the right
one. `ChatHeader.tsx:67-77` already guards this exact mismatch for
`OpenInPicker`; the Unity panel never had that gate.

**The decision is to delete the panel, not to re-scope it.** Unity integration
is project-scoped by owner ruling and now lives in the chat header, which
computes `activeProjectRef` and probes with the **thread's** `environmentId` —
the only correctly-scoped surface in the app. Keeping a second, globally-scoped
copy is what produced the contradiction. Deleting it resolves #110 by
construction.

## Scope

Delete from `apps/web/src/components/settings/ConnectionsSettings.tsx`
(3851 lines) the Unity integration panel and every helper that exists only to
serve it. Verified: **zero external importers.** `UnitySetupSection`,
`UnitySetupRows`, `formatPackageLockStatus`, `formatUnityCliStatus`,
`formatSelectionPackagePairingSuffix` and `isEditorOpenForThisProject` are all
file-local. The only outside mention is a **comment** in
`apps/web/src/components/EngineToolbar.logic.ts:203` referring to
"`UnitySetupSection`'s own fix" — update that comment to point at whatever
now carries the behaviour, or restate the rule without the dangling name. Do
not leave a reference to a symbol that no longer exists.

Also remove any import in that file that becomes unused as a result
(`invalidateUnitySetupProbeCache`, `unitySetupProbeAtom`, the
`UnitySetupFacts` / `UnitySetupPackageLockState` /
`UnitySetupPipelineListOutcome` types, icons, etc.) — but **only** where the
deletion is what made them unused.

## KEEP — do not delete (adopt, don't remove)

These are shared with the header, which is the surface we are keeping:

- `apps/web/src/unity/setupProbeCache.ts`
- `apps/web/src/unity/fetchSetupProbe.ts`
- `apps/web/src/unity/unitySetupProbeAtom.ts`
- `apps/web/src/unity/postPipelineInstall.ts`
- every Unity contract/type in `packages/contracts` and the shared package
- the entire server side (`apps/server/src/unity/**`) — untouched

If you find yourself deleting anything under `apps/web/src/unity/`, stop: that
is out of scope.

## Non-goals

- Do **not** touch `EngineToolbar.tsx` / `EngineToolbar.logic.ts` beyond the
  one stale comment above. Another lane is editing those files right now.
- Do **not** touch `apps/web/src/dock/**`. Same reason.
- Do **not** re-scope, "fix", or reimplement the panel elsewhere. Delete it.
- Do **not** change server routes or contracts.
- No git operations beyond `git add` + your own commit. Never `git stash`.

## Acceptance

1. The Unity integration panel is gone from Settings → Connections. No
   heading, no rows, no "Not a Unity project" string reachable from Settings.
2. `rg "UnitySetupSection|UnitySetupRows|formatUnityCliStatus"` returns
   nothing in `apps/web/src` except intentional prose you have updated.
3. Typecheck clean. **Run `pnpm typecheck` and read its `Found N errors`
   summary line — do NOT grep for `error TS`.** `@effect/tsgo` emits ANSI
   codes _between_ the words, so `grep "error TS"` matches nothing even when
   there are 20 real errors. This trap has already burned this project three
   times.
4. Full test suite green: `pnpm test`. Baseline is 2123 passing across 240
   files — report the actual numbers you get, and if any test dies because it
   covered only the deleted panel, delete that test with the panel and say
   which ones.
5. Report: files changed, line delta, the `Found N errors` line verbatim, and
   the test summary verbatim.

## Proof expected

Paste the verbatim output of `pnpm typecheck` (the summary line) and
`pnpm test` (the final summary). Claims without that output are not accepted.
