# Spec — Unity routes resolve the project from `projectId`, never from process cwd

Repo: `~/Projects/t3code-fork`, branch `workbench/dock-port`. Closes #128.
Owner ruling: fix it properly (server-resolved), then prove it end to end.

## The defect, proven live

QA round 3 clicked `Setup Unity Integrations` on the Mafia Game project (owner
authorised). Failure toast in ~0.5s, verbatim:

> "Could not install Pipeline package"
> "Not a Unity project: /Users/pieroherrera Unity projects must have an Assets/ folder."

Cause, measured: the packaged desktop app's backend serves EVERY project from
one process whose cwd is the user's home directory, and every Unity route reads
that cwd:

- `apps/server/src/unity/UnityPipelineInstallRoute.ts:82` — `client.install(serverConfig.cwd)`
- `apps/server/src/unity/UnitySetupProbe.ts:177` — `const workspaceRoot = serverConfig.cwd`
- Inputs are literally empty: `UnitySetupProbeInput = Schema.Struct({})`
  (`packages/contracts/src/unitySetup.ts:238`), `UnityPipelineInstallInput =
Schema.Struct({})` (`packages/contracts/src/unityPipelineInstall.ts:24`).

The "one process, one project" doc comments justifying this
(`UnitySetupProbe.ts:14-19`, `unitySetup.ts:224-237`, `unityPipelineInstall.ts:15-23`)
are TRUE for the CLI shape and FALSE for the desktop app. **Rewrite them** —
do not leave prose asserting a premise the code no longer relies on.

## The design (ratified — do not re-litigate)

Copy the Diff panel's trust model, the strongest precedent in the repo: the
client sends an **opaque server-issued identifier**, the server resolves the
filesystem path from its own store, and **no path ever crosses the wire**.

Precedent to imitate: `OrchestrationGetTurnDiffInput` carries only `threadId`
(`packages/contracts/src/orchestration.ts:1532-1539`); the server resolves via
`projection_threads → projection_projects` selecting `workspace_root`
(`apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts:992-1006`),
consumed at `CheckpointDiffQuery.ts:117-134`.

For Unity, resolve by `projectId` directly:
`ProjectionSnapshotQuery.getProjectShellById(projectId)`
(`Layers/ProjectionSnapshotQuery.ts:2159-2170`) already returns the
`projection_projects` record with `workspaceRoot`.

Explicitly REJECTED alternative: caller-supplied `workspaceRoot`
(the `UnityCommandRoute` / Files / Terminal shape). "Server-resolved, never
caller-supplied" is a security property for a route that WRITES to disk;
an identifier the server resolves keeps it.

### Decision: canonical root, not worktree

Resolve to `project.workspaceRoot`, deliberately NOT
`thread.worktreePath ?? workspaceRoot` (the Diff rule). The Unity Editor binds
to the canonical root (lockfile, editor-presence matching); installing the
Pipeline package into a worktree copy would target a project no Editor has
open. Record this deviation in a comment where the resolution happens.

## Scope

### 1. Contracts (`packages/contracts`)

- `UnitySetupProbeInput` and `UnityPipelineInstallInput`: replace
  `Schema.Struct({})` with `Schema.Struct({ projectId: ProjectId })`
  (required — no optional back-compat; pre-live deletion-over-backcompat
  doctrine).
- `UnitySetupFacts` gains a required boolean fact for "the resolved root has
  `ProjectSettings/ProjectVersion.txt`" (name it in the existing facts style).
  Update every fixture the required field breaks.
- `UnitySetupPrimaryStateResult` gains a new state for "not a Unity project"
  (naming: the existing scheme is S1..S13; S0 is suggested since it
  logically precedes them all). Message, matching the house style of plain
  true sentences: reuse the deleted panel's phrasing — "This project doesn't
  look like a Unity project — no ProjectSettings/ProjectVersion.txt was
  found." (That sentence previously lived ONLY in the deleted Settings
  panel's client fallback; the server classifier never had it, which is half
  of what made round 3's failure look plausible.)

### 2. Server (`apps/server/src/unity`)

- Both routes decode the body, resolve
  `getProjectShellById(projectId)` → `workspaceRoot`, and pass the resolved
  root down. Unknown/deleted `projectId` → a typed, honest error result (not
  a 500, not a fallback to any cwd). **There is no legitimate fallback to
  `serverConfig.cwd` — remove those reads entirely from both routes and the
  probe service.**
- `UnitySetupProbe.probe()` takes the workspace root as a parameter instead
  of reading `ServerConfig`. Keep everything else (S10 pairing grace,
  `Clock`, cwd-pinning of the CLI subprocess) intact.
- Probe collects the new is-Unity-project fact (fs check for
  `ProjectSettings/ProjectVersion.txt` under the resolved root).
- Classifier: the not-a-Unity-project state is checked FIRST — if the root is
  not a Unity project, CLI availability and package state are irrelevant.
- Auth scopes on both routes: UNCHANGED. This spec changes resolution, not
  authorization strength.

### 3. Client (`apps/web/src/unity`, call sites)

- `fetchSetupProbe.ts` and `postPipelineInstall.ts`: accept `projectId`, send
  it as the JSON body (replacing `bodyJsonUnsafe({})`).
- **Probe identity becomes (environmentId, projectId).** Today it is
  environmentId alone in three places, and each becomes wrong the moment the
  probe is project-scoped — two projects in one environment would serve each
  other's cached answers:
  - `setupProbeCache.ts` cache key (`:51,57`) → key on both ids
    (`scopedProjectKey` from `packages/client-runtime` is the existing
    utility for exactly this).
  - `unitySetupProbeAtom.ts` `Atom.family` key → both ids. The atom still
    needs `environmentId` alone for `preparedConnectionAtom`.
  - `invalidateUnitySetupProbeCache` and every caller (ChatView CTA success
    path at `ChatView.tsx:5467`, retry path) → both ids.
  - The stale header comment in `setupProbeCache.ts:10-20` asserting
    "environmentId is the only key that can affect correctness" must be
    rewritten; it documents the old premise.
- `ChatView.tsx`: `handleSetupUnityIntegrations` passes
  `activeProjectRef.projectId` (already in lexical scope, `:1500-1505`); if
  `activeProjectRef` is null, bail with the existing toast pattern rather
  than calling. Probe wiring passes the same ref. Deps arrays updated
  honestly (the F10 review finding was about exactly this).
- `EngineToolbar.logic.ts`: the not-a-Unity-project state must (a) NEVER
  offer the install CTA (`shouldOfferUnityPipelineInstall` stays false), and
  (b) surface its message as the disabled reason through the existing
  single-expression aria-label/tooltip discipline.

### 4. What NOT to touch

- `UnityCommandRoute` (Play/Stop) keeps its existing caller-supplied
  `workspaceRoot` shape this round. It is pre-existing, separately flagged,
  and the client feeds it server-sourced entity state. Migrating it here
  widens the diff under a live E2E deadline. (The client's Play path already
  targets the right project, so the post-install E2E is unaffected.)
- Auth/scope machinery, dev proxy (`/unity` prefix already covers both
  routes — verified, prefix matching ignores body/query), pairing logic.

## Acceptance

1. Grep proof: `serverConfig.cwd`/`ServerConfig` no longer referenced in
   `UnitySetupProbe.ts`, `UnitySetupProbeRoute.ts`,
   `UnityPipelineInstallRoute.ts` (except any legitimately unrelated use —
   name it if one exists).
2. Route tests: known `projectId` resolves to that project's root (fake
   projection query — the pattern in existing route tests); unknown
   `projectId` produces the typed error; the error decodes through the
   contract.
3. Classifier: new-state test proven red first (fact false → old code
   returns S5, new code returns the new state). The S5 fallthrough for a
   non-Unity root is the EXACT live defect — the red leg must reproduce it.
4. Client tests: request body carries `projectId`; cache serves different
   entries for two projects in one environment (this test must fail against
   the old environmentId-only key).
5. Toolbar logic test: new state ⇒ no install CTA, message as disabled
   reason. Red first.
6. `pnpm typecheck`: read the `Found N errors` summary line (ANSI trap —
   never grep "error TS"). Baseline is `Found 20 errors in 3 files`, all
   TS377026 fixture debt in the three Unity server test files. Do not add
   NEW violations: any fixture you touch, migrate to Schema helpers rather
   than adding more JSON.parse.
7. `pnpm test` fully green; report the verbatim summary.

## Proof expected

Files changed, the verbatim typecheck summary line, the verbatim test
summary, and for every red-green test: the failing output first, then the
passing output. Claims without output are not accepted.

## Live verification (owner-run after this lands — not this task's job)

Rebuild the packaged app, click Setup Unity Integrations on Mafia Game, and
the header must flip to the quiet Unity + Play pair within a few seconds with
the manifest actually written. That is QA round 4; do not attempt it from
this task.
