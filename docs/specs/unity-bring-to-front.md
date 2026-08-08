# Spec — wire the Unity button: raise (or launch), and Play raises too

Repo: `~/Projects/t3code-fork`, branch `workbench/dock-port`. Owner ruling
(2026-08-05, screenshot of the honest tooltip): "we didn't wire it up?" —
wire it. The original plan already specced the design
(docs/workbench/plan-engine-header-redesign.md Phase 3, owner-ratified):
**`Unity` = raise; `Play` = raise + dispatch.**

## Design (settled by prior research — do not re-derive)

- RUNNING editor for this project → raise via macOS `open -a "Unity"`
  through the EXISTING `ExternalLauncher` service
  (`apps/server/src/process/externalLauncher.ts` — it already speaks
  `open`/`xdg-open`; :227-257). Launch Services, no TCC prompt ever. Known,
  ACCEPTED limitation (owner saw the research): app-name targeting cannot
  disambiguate two Editors; pid-precise focus needs an Automation grant we
  deliberately don't buy. Doc-comment this at the call site.
- NOT running → the EXISTING cold-start path
  (`apps/server/src/editorPresence/UnityColdStartRoute.ts`,
  `POST /unity/cold-start`, AuthPresenceCommandScope) already launches the
  Editor with the project. Do not duplicate its logic.

## Scope

### 1. Server — one new route: `POST /unity/raise`

- New contract in `packages/contracts` (path const + input
  `{ projectId: ProjectId }` + a small tagged result union: raised /
  coldStartStarted / error-with-message). Same trust model as every Unity
  route since #128: opaque projectId, server resolves `workspaceRoot` via
  `getProjectShellById`, nothing caller-supplied reaches the filesystem or
  the launcher.
- Behavior: resolve project → check live instance state (the same
  live-match/pipeline facts the cold-start route already checks) →
  running ⇒ `ExternalLauncher` `open -a "Unity"` and return `raised`;
  not running ⇒ delegate to the same internal launch the cold-start
  dispatch performs and return `coldStartStarted`. Unknown project ⇒ the
  standard typed "Project not found." shape.
- Scope: `AuthPresenceCommandScope` — identical to Play/Stop and cold-start
  (raising/launching the Editor is the same risk family; cite
  UnityColdStartRoute's own scope comment).
- Wire into server.ts exactly like the sibling Unity routes.

### 2. Client

- `apps/web/src/unity/postUnityRaise.ts` modeled on
  `postPipelineInstall.ts` (same auth plumbing, decoded-not-cast result).
- `ChatView.tsx`: a `handleBringUnityToFront` following
  `handleSetupUnityIntegrations`'s exact shape (activeProjectRef guard,
  prepared-connection guard with the same honest toast, in-flight re-entry
  guard per the F9 pattern). Toast only on FAILURE — a successful raise is
  its own feedback (the Editor appears); no success toast.
- `EngineToolbar.tsx`: the single `[UnityIcon] Unity` control becomes
  ENABLED when `onBringUnityToFront` is provided and the backend is
  unity-cli — aria-label/tooltip flip from "isn't wired up yet" to "Bring
  the Unity Editor to the front" via the single-expression discipline. When
  the prop is absent it stays honestly disabled exactly as today.
- **Play raises too** (the ratified plan's second half): the transport
  cluster's play action ALSO fires the raise (fire-and-forget alongside the
  existing dispatch — do not serialize them; a raise failure must never
  block the play dispatch). Stop/Pause do NOT raise.

### 3. Tests (red-first where expressible)

- Route: known project + live instance ⇒ launcher invoked with `open -a
Unity` args, result `raised` (red: route doesn't exist — a contract-level
  test importing the path const suffices for red); known project + no live
  instance ⇒ cold-start delegation invoked, `coldStartStarted`; unknown
  projectId ⇒ typed error; insufficient scope ⇒ the standard 403 shape;
  launcher failure ⇒ typed error, not a 500.
- Client: request body carries projectId; report/toast mapping.
- Toolbar: enabled-with-handler renders the active aria-label (red against
  current always-disabled markup); absent-handler stays disabled with the
  current sentence; play click invokes BOTH callbacks.

## Non-goals

- No pid-precise/AppleScript focus, no multi-Editor disambiguation.
- No Windows/WSL behavior change (the launcher's own platform switch
  handles non-mac as best-effort; do not build platform UI).
- No changes to dock files, pairing, install, or transport icon design.

## Acceptance

`pnpm typecheck` Found-line at baseline (Found 14 errors in 2 files); full
`pnpm test` green; verbatim outputs; red-or-why per new test. Live proof is
the owner clicking the button (the Editor visibly rising is not
driver-verifiable) — state that plainly in the report.
