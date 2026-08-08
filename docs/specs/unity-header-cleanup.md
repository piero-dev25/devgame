# Spec — one Unity control + Unity-style icon-only transport cluster

Repo: `~/Projects/t3code-fork`, branch `workbench/dock-port`. Owner rulings
from two annotated screenshots (2026-08-05), verbatim intent:

1. "There's two unity, there should be only one ([UnityIcon] Setup
   Integrations) -> then after it setup and is up to date … it shows
   [UnityIcon] Unity only."
2. "Theres two button areas for play and stop, make it like unity reference
   … no need for word play/pause just the icons."

## Current state (what the owner sees)

Header row renders FOUR Unity-ish elements: a plain-text `Unity` Badge (the
engine label), a separate disabled `Unity` button (bring-to-front), a
bordered `Play` button, and a separate bordered `Stop` button — plus words
on everything.

## Target state

### A. One Unity control (`EngineToolbar.tsx`)

- DELETE the engine-label `Badge` for the Unity backend and DELETE the
  separate bring-to-front button. They merge into ONE control:
  - Setup needed (`view.unityInstallOffered`, either branch): a single
    filled (`variant="default"`) button: `[UnityIcon] Setup Integrations` —
    the word "Unity" leaves the LABEL because the icon carries it. Same
    onClick (`onSetupUnityIntegrations`), same gating, same everything else.
  - Ready (and no install offered): a single quiet outline control:
    `[UnityIcon] Unity`. It keeps the bring-to-front semantics exactly as
    the deleted button had them (currently aria-disabled with the stated
    "isn't wired up yet" reason + tooltip — the #124 discipline, unchanged).
  - Not-ready-without-install states (S1/S6/S13/…): the single control shows
    `[UnityIcon] Unity` with the classifier sentence as its
    aria-label/tooltip via the existing single-expression discipline —
    replacing the Badge+disabled-Play-reason split for the LABEL portion
    only; the disabled transport cluster below still carries the reason too.
- NON-Unity backends and the no-engine case are OUT OF SCOPE: the Badge
  rendering for godot/unreal/threejs/"No engine" stays exactly as is.

  **Superseded (2026-08-08):** the no-engine case's Badge is GONE. The
  owner's screenshot report ("just not show the no engine chip in there and
  any other chip that is game harness specific") replaced the "No engine"
  chip with nothing at all — see
  docs/specs/no-engine-ui-for-non-game-projects.md. godot/unreal/threejs are
  unaffected by that later change; only the null-engine badge this line
  described is gone.

### B. Unity icon (new, tiny)

No engine icon assets exist in apps/web (verified). Add an inline SVG React
component (e.g. `apps/web/src/components/icons/UnityIcon.tsx`): the standard
Unity cube mark, single path(s), `viewBox`-scaled, `fill="currentColor"`,
`aria-hidden`, sized via className like the lucide icons already used
(`size-3.5` convention in this file). No external asset, no new dependency.

### C. Transport cluster, Unity-reference style (`EngineToolbar.tsx` ready branch)

Replace the current worded Play/Pause-toggle + separate Stop with ONE
segmented `Group` (the `Group` component already imported in this file) of
exactly TWO icon-only buttons, matching the owner's reference crops:

- Button 1 — play/stop toggle: `PlayIcon` when stopped/paused-at-stop;
  while PLAYING it shows `SquareIcon` (stop) in the ENGAGED visual
  (`variant="default"`, as the reference's blue square). Click dispatches
  `play` when stopped, `stop` when playing.
- Button 2 — pause: `PauseIcon`, engaged visual while `playState ===
"paused"`, disabled-with-reason when nothing is playing (a paused state
  needs something running). Click dispatches `pause` (and `play` to resume
  when paused — mirror Unity: pressing pause while paused resumes? NO —
  Unity's pause is a latch; pressing play resumes. Keep it simple: pause
  button dispatches `pause` only, and is engaged while paused; resume is
  button 1).
- NO visible words on either button. Accessibility does NOT regress: each
  button keeps a precise aria-label ("Play" / "Stop" / "Pause" with the
  disabled reason where applicable) and its Tooltip, both via the existing
  single-expression discipline. The #124 aria-disabled convention (never
  the native attribute on tooltip-wrapped disabled controls) is unchanged.
- The logic derivations live in `EngineToolbar.logic.ts`
  (`resolveUnityPlayToggleAction` etc.) — extend/adjust there as pure
  functions; the component stays thin.

The disabled (not-ready) Play rendering in the not-ready branch becomes the
same icon-only cluster, disabled with reasons — not the old worded button.

## Tests (this file's suites will need real surgery — do it honestly)

Many existing assertions check `>Play<` / `>Stop<` words. Update them to the
new shape: assert icon-only (no visible Play/Stop/Pause TEXT in the Unity
cluster — anchored, not substring-vacuous), aria-labels present and exact,
engaged stop shows while playing, the SINGLE Unity control (exactly one
element carrying the Unity name in the ready state — the round-8/9 "two
Unity" complaint is the regression this guards), CTA label is now "Setup
Integrations" with the icon. Red-first where the assertion can fail against
current code (the single-Unity-control count test MUST be red first: current
code renders two).

## Non-goals

- No versioning/update states (owner: "later we will have versioning too").
- No bring-to-front implementation (still stated-disabled).
- No changes to non-Unity engines, the dock, server, contracts, or the
  install/pairing flow.
- Do not rename `onSetupUnityIntegrations` or touch ChatView beyond what a
  label/no-op requires (ideally nothing).

## Acceptance

1. Ready state renders EXACTLY ONE control whose accessible name or label
   contains "Unity" (red-first count test), plus the two-icon transport
   cluster with zero visible transport words.
2. Setup state renders the single filled `[icon] Setup Integrations` CTA and
   the disabled icon cluster.
3. `pnpm typecheck` Found-line at baseline (Found 14 errors in 2 files);
   full `pnpm test` green; verbatim outputs.
4. Every changed test's red-or-why documented.
