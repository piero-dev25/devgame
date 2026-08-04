// Pure derivation for the Play/Stop toolbar (#52). No React, no store reads
// — every input is a plain value the component (or a test) hands in, so the
// actual decision of "what does this toolbar show right now" is checkable
// without mounting anything or faking a WebSocket.
import type { EngineType, UnitySetupFacts, UnitySetupProbeResult } from "@t3tools/contracts";

import type {
  EditorPresenceCapability,
  EditorPresenceEntry,
  EditorPresencePlayState,
} from "../editorPresence/protocol";

/**
 * One button the toolbar can render, 1:1 with a wire `command.action` — see
 * spec-editor-presence-commands.md's wire shape. Deliberately NOT a merged
 * "Play doubles as Stop when already playing" toggle: the wire protocol
 * keeps `play`/`stop` as two distinct actions, and collapsing them into one
 * button risks sending the wrong one for an engine whose `playState` this
 * client hasn't caught up with yet. `play` alone gets a highlighted/active
 * treatment when `playState === "playing"` (or `"paused"`) — driven by
 * presence, never by "I clicked this recently" — see spec-unity-play-stop.md's
 * ruling.
 */
export type EngineToolbarAction = "play" | "pause" | "stop" | "step";

/** Fixed display order — matches the order Unity's own editor toolbar shows
 * these in (Play, Pause, Step), with Stop folded in as the fourth slot
 * rather than a class of its own; an engine simply omits what it doesn't
 * advertise. */
const CONTROL_ACTION_ORDER: ReadonlyArray<EngineToolbarAction> = ["play", "pause", "stop", "step"];

/**
 * The toolbar is NOT one mechanism with per-engine flavor text — it is
 * three genuinely different dispatch paths, discovered while building this
 * (team-lead's finding, 2026-08-03): Unity is redirected to a server-side
 * Unity CLI shell-out (their editor-presence plugin isn't even installed in
 * the owner's real project), three.js has no engine to command at all, and
 * only Godot (and, once #50 lands, presumably Unreal) actually goes over an
 * Editor Presence command frame. This has real consequences beyond which
 * function gets called:
 *
 * - Both `"editor-presence"` AND `"unity-cli"` need `presence:command` —
 *   corrected from an earlier version of this file that gated only
 *   `"editor-presence"`, reasoning from the TRANSPORT ("Unity doesn't use
 *   the presence socket, so it doesn't need the presence scope"). That
 *   reasoning was wrong: the scope doesn't mean "uses the presence socket,"
 *   it means "may make the user's editor execute code." Unity's CLI route
 *   does exactly that — same risk class, different transport, not a new
 *   scope and not an exemption. Leaving it ungated would have shipped an
 *   enabled-looking Unity Play button that any authenticated client could
 *   use to drive someone's editor — precisely the hole `presence:command`
 *   exists to close. Only `"threejs-script"` is genuinely exempt: it runs a
 *   project script the user already configured, and touches no editor.
 * - Only `"editor-presence"` has a live `capabilities`/`playState` feed at
 *   all (the presence WebSocket). `"unity-cli"` has no publisher and never
 *   appears in the presence feed's editor list; `"threejs-script"` has no
 *   engine, full stop.
 */
export type EngineDispatchBackend = "editor-presence" | "unity-cli" | "threejs-script";

/**
 * Exhaustive over `EngineType`'s 4 literals (no `default` — a 5th engine
 * added to the contract without a case added here is a compile error, not
 * a silent fallthrough). Godot and Unreal share the Editor Presence path
 * today; if Unreal (#50) ends up on its own backend the way Unity did, this
 * is the one place that changes.
 */
export function resolveEngineDispatchBackend(engineType: EngineType): EngineDispatchBackend {
  switch (engineType) {
    case "godot":
    case "unreal":
      return "editor-presence";
    case "unity":
      return "unity-cli";
    case "threejs":
      return "threejs-script";
  }
}

/** Unity's actual advertised set on the CLI path, per team-lead's live
 * verification against the owner's real Editor
 * (`com.unity.pipeline 0.4.0-exp.1`): play/stop/pause, no frame-step —
 * Pipeline has no scriptable step API, unlike Unity's OWN editor-presence
 * plugin (never installed in the owner's project) which would have offered
 * it. Fixed, not derived from any live feed — there is no `hello.capabilities`
 * for a backend with no publisher. If the CLI's own capability set ever
 * becomes queryable, this constant is what a live value should replace. */
const UNITY_CLI_ACTIONS: ReadonlyArray<EngineToolbarAction> = ["play", "pause", "stop"];

/**
 * Whether Unity's Play/Pause/Stop controls may be clicked at all, per #92's
 * `UnitySetupProbe` — gated on the EXPLICIT facts (Pipeline package
 * installed, a matched live+reachable instance for this project), never on
 * `UnitySetupPrimaryState.state`'s position in the S1-S12 taxonomy.
 *
 * That taxonomy is ORDERED (Pipeline checks run before the selection-
 * package check, so a project missing only the optional selection package
 * lands on S9 rather than S11) purely so ONE state can answer "what's the
 * single most useful sentence to show right now." Depending on that
 * ordering here — e.g. "Play is ready once the classifier reaches the
 * selection check" — would make Play's own readiness an accident of check
 * order: correct today only because Pipeline happens to be checked first,
 * silently wrong the day a state is inserted or reordered, with no failing
 * test to catch it. Reading the facts directly has no such dependency —
 * team-lead's ruling, 2026-08-04, in response to exactly this design
 * question. This mirrors (does not call) `classifyUnitySetup`'s own
 * `liveMatch` computation in `apps/server/src/unity/UnitySetupClassifier.ts`;
 * keep the two in sync if that logic changes, since the server has no
 * client-facing "is play ready" field of its own to reuse here — `primary`
 * answers a different question (see this function's callers).
 */
export function isUnityPlayReady(facts: UnitySetupFacts): boolean {
  return (
    facts.cliAvailable &&
    facts.pipelinePackage.installed &&
    facts.pipelineList?._tag === "ran" &&
    facts.pipelineList.matched !== null &&
    facts.pipelineList.matched.isRunning &&
    facts.pipelineList.matched.isReachable
  );
}

/** The message to show when Unity's controls are disabled — `primary`'s own
 * classified sentence, verbatim (S12 included: the CLI's raw message,
 * unedited, per plan §1's "never map an unrecognized CLI string onto a
 * friendly sentence"). This is the ONE place `primary.state` is consulted
 * for Unity — for the reason shown, never for whether the button is
 * clickable (see `isUnityPlayReady`'s doc comment). Every variant except
 * `"S11"` carries `message`; `isUnityPlayReady` returning `false` should
 * always mean `primary` is one of those (S11 implies the same facts this
 * function's caller already found ready) — checked with `"message" in`
 * rather than assumed, since the two are independently computed from the
 * same facts, not one derived from the other. */
function unityDisabledReason(setup: UnitySetupProbeResult | null): string | null {
  if (setup === null) return "Checking Unity's status…";
  return "message" in setup.primary ? setup.primary.message : null;
}

export interface EngineToolbarView {
  /** The engine this toolbar targets — override or detected, resolved by
   * the caller via `selectProjectEngineType` before this function runs.
   * `null` means no engine is known for the project at all: the toolbar
   * still renders (so the engine selector remains reachable), but with no
   * control cluster. */
  readonly engineType: EngineType | null;
  /** `null` exactly when `engineType` is `null` — see `resolveEngineDispatchBackend`. */
  readonly backend: EngineDispatchBackend | null;
  /** Whether commands for this view need `presence:command` — true for
   * `"editor-presence"` AND `"unity-cli"` (both can make the user's editor
   * execute code; see `EngineDispatchBackend`'s doc comment for why
   * gating only the presence-socket path was wrong), false only for
   * `"threejs-script"`. The component gates its scope-missing UI on THIS,
   * never on a toolbar-wide flag. */
  readonly requiresPresenceCommandScope: boolean;
  /** Whether a connected editor was found for this project's workspace
   * root. Only meaningful for the `"editor-presence"` backend — `false`
   * for `"unity-cli"` (no publisher, ever) and `"threejs-script"`
   * (irrelevant), and for `"editor-presence"` with nothing currently
   * connected. The correct response to `false` on `"editor-presence"` is a
   * disabled control cluster, not a hidden toolbar: the engine is known
   * even when nothing is connected right now. */
  readonly hasConnectedEditor: boolean;
  /** Actions to render. For `"editor-presence"`, filtered to what the
   * connected editor actually advertised — see
   * spec-editor-presence-commands.md's "Capability advertisement": an
   * unadvertised action must never appear as an enabled (or even present)
   * control, since a plugin that hasn't implemented it will hang, not
   * answer `unsupported_action`. For `"unity-cli"`, the fixed
   * `UNITY_CLI_ACTIONS` set. Empty for `"threejs-script"` — the component
   * renders its own single Play button for that backend instead of this
   * list. */
  readonly availableActions: ReadonlyArray<EngineToolbarAction>;
  /** For `"editor-presence"`, the connected editor's own reported state.
   * For `"unity-cli"`, the caller-supplied `unityPlayState` (there is no
   * status RPC wired yet as of this change — see `resolveEngineToolbarView`'s
   * doc comment — so this is `null` until one exists). Always `null` for
   * `"threejs-script"`. */
  readonly playState: EditorPresencePlayState | null;
  /** Why the control cluster is disabled (`availableActions.length === 0`)
   * — `null` when there's nothing backend-specific to say (the component
   * falls back to its own generic "no editor connected" copy for
   * `"editor-presence"`) or when the cluster isn't disabled at all. For
   * `"unity-cli"`, `UnitySetupProbe`'s own classified sentence — see
   * `unityDisabledReason`'s doc comment for why `primary.message`, never a
   * paraphrase, and never `primary.state` itself for the enable/disable
   * decision (see `isUnityPlayReady`). */
  readonly disabledReason: string | null;
}

function toActionSet(capabilities: ReadonlyArray<EditorPresenceCapability>): ReadonlySet<string> {
  return new Set(capabilities);
}

export function resolveEngineToolbarView(input: {
  readonly engineType: EngineType | null;
  /** Only consulted for the `"editor-presence"` backend. */
  readonly connectedEditor: EditorPresenceEntry | null;
  /**
   * Only consulted for the `"unity-cli"` backend. `null` until a server
   * endpoint exists to query Unity CLI play state (`unity command
   * editor_status`, per team-lead's verification, has no client-reachable
   * route yet — the same gap `dispatchEditorCommand` had for Godot before
   * this task added one). A caller with nothing to pass should omit this
   * or pass `null` explicitly; do not guess `"stopped"`.
   */
  readonly unityPlayState?: EditorPresencePlayState | null;
  /**
   * Only consulted for the `"unity-cli"` backend. `null`/omitted means "no
   * probe result yet" (still loading, or the caller hasn't wired the fetch
   * for this render) — treated the SAME as "not ready": Play stays
   * disabled with a "Checking Unity's status…" placeholder rather than
   * defaulting to enabled, which was the actual defect (#92) this field
   * fixes — `UNITY_CLI_ACTIONS` used to render unconditionally, so the only
   * way a user learned Unity was unreachable was clicking Play and getting
   * a generic toast.
   */
  readonly unitySetup?: UnitySetupProbeResult | null;
}): EngineToolbarView {
  const { engineType, connectedEditor } = input;
  if (engineType === null) {
    return {
      engineType: null,
      backend: null,
      requiresPresenceCommandScope: false,
      hasConnectedEditor: false,
      availableActions: [],
      playState: null,
      disabledReason: null,
    };
  }

  const backend = resolveEngineDispatchBackend(engineType);

  if (backend === "threejs-script") {
    return {
      engineType,
      backend,
      requiresPresenceCommandScope: false,
      hasConnectedEditor: false,
      availableActions: [],
      playState: null,
      disabledReason: null,
    };
  }

  if (backend === "unity-cli") {
    const setup = input.unitySetup ?? null;
    const playReady = setup !== null && isUnityPlayReady(setup.facts);
    return {
      engineType,
      backend,
      requiresPresenceCommandScope: true,
      hasConnectedEditor: false,
      availableActions: playReady ? UNITY_CLI_ACTIONS : [],
      playState: input.unityPlayState ?? null,
      disabledReason: playReady ? null : unityDisabledReason(setup),
    };
  }

  // backend === "editor-presence"
  if (!connectedEditor) {
    return {
      engineType,
      backend,
      requiresPresenceCommandScope: true,
      hasConnectedEditor: false,
      availableActions: [],
      playState: null,
      disabledReason: null,
    };
  }
  const actionSet = toActionSet(connectedEditor.capabilities);
  return {
    engineType,
    backend,
    requiresPresenceCommandScope: true,
    hasConnectedEditor: true,
    availableActions: CONTROL_ACTION_ORDER.filter((action) => actionSet.has(action)),
    playState: connectedEditor.playState,
    disabledReason: null,
  };
}

/** Whether the Play control should render in its "engaged" (highlighted)
 * state — presence-driven, per spec-unity-play-stop.md: a domain reload can
 * kill the connection between a Play click and any reply, so the button
 * must reflect what presence last reported, not local click state. Paused
 * counts as engaged (the session is still "in play mode", just halted). */
export function isPlayEngaged(playState: EditorPresencePlayState | null): boolean {
  return playState === "playing" || playState === "paused";
}
