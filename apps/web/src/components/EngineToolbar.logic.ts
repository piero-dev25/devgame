// Pure derivation for the Play/Stop toolbar (#52). No React, no store reads
// — every input is a plain value the component (or a test) hands in, so the
// actual decision of "what does this toolbar show right now" is checkable
// without mounting anything or faking a WebSocket.
import type { EngineType, UnitySetupFacts, UnitySetupProbeSuccess } from "@t3tools/contracts";

import type {
  EditorPresenceCapability,
  EditorPresenceEntry,
  EditorPresencePlayState,
} from "../editorPresence/protocol";

/**
 * One value the toolbar can pass to `onAction`, 1:1 with a wire
 * `command.action` — see spec-editor-presence-commands.md's wire shape.
 * This type itself stays UNMERGED — `play`/`pause`/`stop` remain three
 * distinct values sent over the wire, never collapsed into one.
 *
 * What DID change (owner ruling, 2026-08-05, verbatim: "play and stop are
 * the main ones for now, same area (toggle essentially) when unity is on
 * play, shows pause there, and vice verse etc."): Unity's PRESENTATION now
 * uses a Play/Stop toggle followed by a separate Pause latch, and
 * picks which of these values to send by reading the current `playState` —
 * never by counting clicks or flipping local UI state, which is exactly the
 * risk an earlier version of this comment warned against ("collapsing them
 * into one button risks sending the wrong one for an engine whose
 * `playState` this client hasn't caught up with yet"). This one preserves
 * that guarantee rather than dropping it: `resolveUnityPlayToggleAction`
 * derives its answer from `playState`, the same presence/re-read
 * `UnityEditorStatus` source `isPlayEngaged` already reads — never "I
 * clicked this recently." See `EngineToolbar.tsx`'s Unity ready-state doc
 * comment for the transport's exact behaviour. Godot/
 * Unreal's `editor-presence` backend is UNCHANGED by this — still four
 * separate buttons, still exactly this type's four literals, one each.
 */
export type EngineToolbarAction = "play" | "pause" | "stop" | "step";

/**
 * Keeps the transport dispatch independent from Unity's best-effort raise.
 * Dispatch runs first, so even a synchronously failing raise callback cannot
 * prevent Play from reaching the existing command path. Stop/Pause/Step do
 * not raise.
 */
export function invokeUnityToolbarAction(input: {
  readonly action: EngineToolbarAction;
  readonly onAction: (action: EngineToolbarAction) => void;
  readonly onBringUnityToFront?: () => void;
}): void {
  input.onAction(input.action);
  if (input.action === "play") input.onBringUnityToFront?.();
}

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
 *   all (the presence WebSocket). `"threejs-script"` has no engine, full
 *   stop.
 *
 *   SUPERSEDED 2026-08-10 (unity-playstate-presence.md): the line this
 *   replaced claimed `"unity-cli"` "has no publisher and never appears in
 *   the presence feed's editor list" — true when written, wrong since
 *   Unity package 0.3.1. Unity's presence publisher (hello/selection since
 *   #129, now also `playState`) DOES appear in the feed and IS consulted —
 *   see `resolveEngineToolbarView`'s unity-cli branch, which now prefers
 *   `connectedEditor?.playState` over the CLI echo. What's still true, and
 *   is the actual reason this file's dispatch routing is untouched: Unity's
 *   publisher advertises `capabilities: []` (no `command` support), so
 *   `resolveEngineDispatchBackend` still sends every Play/Stop/Pause click
 *   down the CLI shell-out, never a presence `command` frame — only the
 *   read side (what the toolbar SHOWS) changed, not the write side (how a
 *   click is dispatched).
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

function hasLiveUnityEditorMatch(facts: UnitySetupFacts): boolean {
  return (
    facts.pipelineList?._tag === "ran" &&
    facts.pipelineList.matched !== null &&
    facts.pipelineList.matched.isRunning &&
    facts.pipelineList.matched.isReachable
  );
}

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
    facts.isUnityProject &&
    facts.cliAvailable &&
    facts.pipelinePackage.installed &&
    hasLiveUnityEditorMatch(facts)
  );
}

/**
 * Whether the header's `Setup Unity Integrations` CTA (`EngineToolbar.tsx`)
 * should offer to run `postUnityPipelineInstall` at all — owner ruling: the
 * CTA performs the install directly (no agent, no confirmation dialog), so
 * it must never appear for a not-ready reason installing the Pipeline
 * package can't fix. Same "read the EXPLICIT facts, never
 * `UnitySetupPrimaryState.state`'s position in the taxonomy" posture
 * `isUnityPlayReady` above already established, for the identical reason:
 * depending on which literal state string the classifier currently emits
 * for "package missing" would make this gate an accident of
 * `UnitySetupClassifier.ts`'s check order, silently wrong the day that
 * ordering changes, with no failing test to catch it (this file's
 * `isUnityPlayReady` doc comment has the fuller version of this same
 * argument).
 *
 * Package installation deliberately does not require Unity's live state:
 * S4 (Unity open, package missing) and S5 (Unity closed, package missing)
 * are both fixable because `postPipelineInstall.ts` succeeds without an
 * Editor. Pairing recovery is intentionally narrower. With Unity closed,
 * "publisher not registered" cannot distinguish never-paired from
 * paired-but-closed, so offering S10 forever would violate "quiet once it
 * works." Only that term requires the same running+reachable `pipelineList`
 * match the classifier uses. The server mint path is deliberately
 * asymmetric: a setup request that reaches it while Unity is closed still
 * writes the 24-hour handoff for the next Editor launch.
 *
 * The package facts remain independent of Unity's live state; the pairing
 * recovery fact is trusted only with a live match:
 *  - `isUnityProject` — S0 is never an installation opportunity.
 *  - `cliAvailable` — no working `unity` binary, no install to run (S1/S2).
 *  - `!pipelinePackage.installed` — nothing missing means nothing to add.
 *  - `!pipelinePackage.declaredInManifest` — already added, just awaiting
 *    Unity's own resolver (S13); re-running install has nothing left to do.
 *  - an installed selection package without a registered publisher — S10's
 *    recovery is a re-click, but only while a live Editor proves the absent
 *    publisher means unpaired rather than merely closed.
 *
 * S8 (package installed, but an update is available) is a genuinely
 * DIFFERENT case this function does not attempt to cover: `isUnityPlayReady`
 * is already `true` there (Play works fine on the older version), so
 * `EngineToolbar.tsx`'s not-ready CTA branch — the only place this function
 * is consulted — never even runs for S8. Whether an "update available"
 * affordance belongs somewhere in the READY state's own two-button pair is
 * a real, separate design question this change does not answer.
 */
export function shouldOfferUnityPipelineInstall(facts: UnitySetupFacts): boolean {
  if (!facts.isUnityProject || !facts.cliAvailable) {
    return false;
  }
  const pipelineMissing =
    !facts.pipelinePackage.installed && !facts.pipelinePackage.declaredInManifest;
  // The one click now installs BOTH packages (f95c1731c), so a missing
  // SELECTION package is an installation opportunity too — the owner hit
  // exactly this live: Pipeline installed, Play working, chips silently
  // off, and nothing to click (#129). `installed` flips as soon as the
  // embedded copy lands (the probe reads the embedded package.json without
  // waiting for Unity's resolver), so the CTA disappears right after a
  // successful click rather than lingering until Unity re-resolves.
  const selectionMissing = !facts.selectionPackage.installed;
  const pairingMissing =
    facts.selectionPackage.installed &&
    !facts.selectionPublisherRegistered &&
    hasLiveUnityEditorMatch(facts);
  return pipelineMissing || selectionMissing || pairingMissing;
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
 * same facts, not one derived from the other.
 *
 * `error` distinguishes "still loading" from "loaded and failed" — found
 * live (2026-08-04, team-lead + presence-authz): before this, a probe
 * fetch that REJECTED (network failure, a hung request past its own
 * timeout, anything) left `setup` at `null` forever, and this function had
 * no way to tell that apart from "hasn't resolved yet" — "Checking Unity's
 * status…" stayed on screen permanently instead of ever becoming a stated
 * failure. The chat header's setup probe follows the same non-negotiable:
 * resolve to success or a stated reason, never an indefinite loading
 * message. */
function unityDisabledReason(
  setup: UnitySetupProbeSuccess | null,
  error: string | null,
): string | null {
  if (setup === null) {
    return error !== null ? `Couldn't check Unity's status — ${error}` : "Checking Unity's status…";
  }
  return "message" in setup.primary ? setup.primary.message : null;
}

export interface EngineToolbarView {
  /** The engine this toolbar targets — the project's server-DETECTED engine
   * type (`activeProject.engineType` in `ChatView.tsx`), never a user
   * choice — owner ruling: engine identity is detection, not a picker.
   * `null` means no engine is known for the project at all.
   *
   * Superseded ruling (no-engine-ui-for-non-game-projects spec, rev 2,
   * 2026-08-08): a `null` engine used to still render the toolbar, as a
   * placeholder undetected-engine badge with no control cluster. The
   * owner's screenshot report ("just not show the no engine chip … and
   * any other chip that is game harness specific") replaced that:
   * `EngineToolbar.tsx` now renders NOTHING for this view — see its own
   * early-return doc comment. */
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
   * for `"unity-cli"` and `"threejs-script"` (irrelevant), and for
   * `"editor-presence"` with nothing currently connected. The correct
   * response to `false` on `"editor-presence"` is a disabled control
   * cluster, not a hidden toolbar: the engine is known even when nothing is
   * connected right now.
   *
   * SUPERSEDED 2026-08-10 (unity-playstate-presence.md critique F6):
   * this used to say `"unity-cli"` is `false` because it has "no publisher,
   * ever" — wrong since Unity package 0.3.1 (see `EngineDispatchBackend`'s
   * own doc comment for the fuller correction). This field stays `false`
   * for `"unity-cli"` regardless, but not because no publisher exists — a
   * Unity presence publisher exists and now feeds `playState`
   * (`resolveEngineToolbarView`'s unity-cli branch reads
   * `connectedEditor?.playState`). What this field actually MEANS is
   * "presence-DRIVEN controls" — i.e. whether the control cluster's
   * enabled/disabled state and available actions come from a presence
   * `capabilities` feed — and unity-cli's controls are not that: they stay
   * gated on `UnitySetupProbe`'s classified facts (`isUnityPlayReady`), same
   * as before this task, wholly independent of whether a Unity publisher is
   * connected. */
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
   * For `"unity-cli"`, `connectedEditor?.playState ?? unityPlayState` — see
   * `resolveEngineToolbarView`'s unity-cli branch for the precedence
   * rationale. Always `null` for `"threejs-script"`.
   *
   * SUPERSEDED 2026-08-10 (unity-playstate-presence.md): this used to
   * say `"unity-cli"` gets "the caller-supplied `unityPlayState`" and
   * nothing else, because there was no status RPC wired for Unity at all.
   * That's still true in the narrow sense — there is still no `unity
   * command editor_status` RPC reachable from here — but it's no longer the
   * whole story: Unity package 0.3.1 publishes a real presence `playState`
   * feed, and it now wins whenever it has an opinion. `unityPlayState` (the
   * CLI's own last-known-good echo, set from a successful dispatch reply)
   * is the fallback for when presence has none — see the merge-point
   * comment at this backend's `playState` assignment for the full
   * reasoning, including its honest bound during a long presence outage. */
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
  /**
   * Whether `disabledReason` reflects a FAILED status check — a rejected
   * `unitySetupProbeAtom` fetch, or the atom's own bounded wait for the
   * environment's connection giving up (#106) — rather than a genuine
   * classified state (S1-S13, e.g. "Pipeline package missing"). Only ever
   * `true` for the `"unity-cli"` backend; always `false` otherwise. Drives
   * whether the toolbar offers a Retry control: retrying a confirmed
   * classifier state wouldn't change the answer (the project genuinely
   * isn't set up yet), but retrying a failed/timed-out CHECK might — see
   * `unityDisabledReason`'s doc comment for the two branches this
   * distinguishes.
   */
  readonly unitySetupCheckFailed: boolean;
  /**
   * Whether the not-ready state's `Setup Unity Integrations` CTA should
   * render — see `shouldOfferUnityPipelineInstall`'s own doc comment for the
   * exact facts this is gated on. Only ever `true` for the `"unity-cli"`
   * backend, and only while `availableActions.length === 0` (i.e. mutually
   * exclusive with being ready) — `false` for every other backend, and
   * `false` for `"unity-cli"` whenever the not-ready reason is something an
   * install can't fix, INCLUDING while `setup` is still `null` (no probe
   * result yet — never offer an action before knowing whether it would
   * help, same "unknown treated as not-ready" default `isUnityPlayReady`'s
   * own resolution already uses).
   */
  readonly unityInstallOffered: boolean;
  /**
   * Whether Unity's status check is CURRENTLY in flight — `unitySetupQuery.isPending`
   * (`useEnvironmentQuery`, `state/query.ts`), threaded straight through
   * (see `resolveEngineToolbarView`'s own `unitySetupPending` param doc
   * comment for why nothing here re-derives it). Only ever `true` for the
   * `"unity-cli"` backend; always `false` otherwise.
   *
   * F13 (merge-gate review, low): the connection-wait + HTTP fetch this
   * covers is bounded but can still run up to ~35s
   * (`UNITY_SETUP_CONNECTION_WAIT_TIMEOUT_MS` + `fetchSetupProbe.ts`'s own
   * 20s bound), and until this field existed nothing in `EngineToolbarView`
   * distinguished "still checking" from "confirmed not ready" — the
   * generic "Checking Unity's status…" placeholder rendered with no
   * visual sense of progress and no live region, so a screen-reader user
   * heard it once (on focus) and never again if it later changed.
   * `EngineToolbar.tsx` uses this to render a `role="status"` spinner
   * ADDITIVE to (never instead of) whatever the not-ready branch already
   * renders — it does not change what `disabledReason` says or whether
   * Retry/the CTA render, both governed entirely by `unitySetupCheckFailed`/
   * `unityInstallOffered` as before.
   */
  readonly unitySetupPending: boolean;
  /** Whether ANY classified probe result is in hand (fresh or the caller's
   * retained last-good). Distinguishes "re-checking over known state" (no
   * indicator at all — the known controls stay) from "first load, nothing
   * classified yet" (the compact spinner). */
  readonly unitySetupResolved: boolean;
}

function toActionSet(capabilities: ReadonlyArray<EditorPresenceCapability>): ReadonlySet<string> {
  return new Set(capabilities);
}

export function resolveEngineToolbarView(input: {
  readonly engineType: EngineType | null;
  /** Only consulted for the `"editor-presence"` backend. */
  readonly connectedEditor: EditorPresenceEntry | null;
  /**
   * Only consulted for the `"unity-cli"` backend, and only as the FALLBACK
   * when `connectedEditor` has no playState opinion — see the merge point
   * at this backend's `playState` assignment. `null` until a server
   * endpoint exists to query Unity CLI play state (`unity command
   * editor_status`, per team-lead's verification, has no client-reachable
   * route yet — the same gap `dispatchEditorCommand` had for Godot before
   * this task added one). A caller with nothing to pass should omit this
   * or pass `null` explicitly; do not guess `"stopped"`.
   *
   * SUPERSEDED 2026-08-10 (unity-playstate-presence.md): this doc used
   * to describe `unityPlayState` as the ONLY play-state source for
   * `"unity-cli"` ("play state is caller-supplied-only"). As of Unity
   * package 0.3.1, `connectedEditor`'s presence-reported `playState` is
   * consulted first — this field is now the one-shot echo that fills the
   * gap only while presence has nothing to say (no publisher connected, an
   * older package, or the momentary post-reconnect null window).
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
  readonly unitySetup?: UnitySetupProbeSuccess | null;
  /**
   * Only consulted for the `"unity-cli"` backend, and only when `unitySetup`
   * is still `null` — the real reason the fetch never resolved to a value
   * (a rejected promise's message), so `unityDisabledReason` can show a
   * stated failure instead of "Checking Unity's status…" forever. `null`/
   * omitted means "no failure known" — either the fetch hasn't settled yet,
   * or it succeeded (in which case `unitySetup` itself is non-null and this
   * is never consulted).
   */
  readonly unitySetupError?: string | null;
  /**
   * Only consulted for the `"unity-cli"` backend — `unitySetupQuery.isPending`
   * (`useEnvironmentQuery`), threaded straight through with no re-derivation:
   * this function already has no way to independently know whether a fetch
   * is in flight (it sees only settled inputs — `unitySetup`/`unitySetupError`),
   * so the caller is the only place this can come from. `undefined`/omitted
   * means "caller hasn't wired this" and defaults to `false`, same posture
   * every other optional field here uses — never a guess that something IS
   * pending. See `EngineToolbarView.unitySetupPending`'s own doc comment
   * for why this exists (F13).
   */
  readonly unitySetupPending?: boolean;
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
      unitySetupCheckFailed: false,
      unityInstallOffered: false,
      unitySetupPending: false,
      unitySetupResolved: false,
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
      unitySetupCheckFailed: false,
      unityInstallOffered: false,
      unitySetupPending: false,
      unitySetupResolved: false,
    };
  }

  if (backend === "unity-cli") {
    const setup = input.unitySetup ?? null;
    const unitySetupError = input.unitySetupError ?? null;
    const playReady = setup !== null && isUnityPlayReady(setup.facts);
    return {
      engineType,
      backend,
      requiresPresenceCommandScope: true,
      hasConnectedEditor: false,
      availableActions: playReady ? UNITY_CLI_ACTIONS : [],
      // unity-playstate-presence.md (2026-08-10): presence wins
      // WHENEVER it is non-null, because it is a level sourced from Unity's
      // own EditorApplication callbacks and republished in full on every
      // reconnect (protocol.ts's own design principle) — `unityPlayState`
      // is only the fallback for presence-has-no-opinion (no publisher
      // connected, an older package that never sent a frame, or the
      // momentary post-reconnect null window before Unity's watcher
      // resends). Post-click transient: after a harness Play, presence may
      // say "stopped" for a sub-second until Unity's own callback fires —
      // intentional; the reverse choice (trusting the echo over presence)
      // reintroduces #136 in miniature, which is the bug this whole task
      // exists to fix. During Unity's play-mode domain reload the publisher
      // DISCONNECTS, so `connectedEditor` goes null and the echo bridges
      // the gap. HONEST BOUND: this composition holds only while
      // disconnections are short — the echo carries no age and no
      // invalidation, so a LONG presence outage (credential rejection
      // halting reconnect, a backend restart, #113's degraded pairing)
      // reverts the toolbar to exactly today's echo-only behavior until
      // presence returns. That is the status quo, not a regression.
      playState: connectedEditor?.playState ?? input.unityPlayState ?? null,
      disabledReason: playReady ? null : unityDisabledReason(setup, unitySetupError),
      // A failed CHECK, not a confirmed classifier state — see this field's
      // own doc comment. Only possible while `setup` is still `null`
      // (`unityDisabledReason` only reads `error` in that branch); once a
      // real probe result has arrived, `disabledReason` (if any) is always
      // a classified S0-S13 sentence, never a failure.
      unitySetupCheckFailed: !playReady && setup === null && unitySetupError !== null,
      // `setup !== null` guards the same "unknown treated as not-ready" way
      // `playReady` itself does — no probe result yet means no CTA, not a
      // default-to-offered guess. Deliberately NOT gated on `!playReady`
      // any more: S9 (Pipeline working, selection package missing) is
      // play-ready AND install-fixable, and the owner's "loud when setup
      // is needed, quiet once it works" applies to chips too — the ready
      // trio renders the CTA alongside a working Play in that state.
      unityInstallOffered: setup !== null && shouldOfferUnityPipelineInstall(setup.facts),
      unitySetupPending: input.unitySetupPending ?? false,
      unitySetupResolved: setup !== null,
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
      unitySetupCheckFailed: false,
      unityInstallOffered: false,
      unitySetupPending: false,
      unitySetupResolved: false,
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
    unitySetupCheckFailed: false,
    unityInstallOffered: false,
    unitySetupPending: false,
    unitySetupResolved: false,
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

/**
 * What the first button in Unity's Play/Stop transport segment should send
 * on its next click. It ends a playing session and starts or resumes every
 * other known state.
 *
 * Only two of the three `EditorPresencePlayState` values get their own
 * face here — `"playing"` ⇒ `"stop"`, everything else ⇒ `"play"` — which
 * means `"stopped"` AND `"paused"` share the `"play"` face. That's a
 * deliberate reading of "vice verse etc.," not an oversight: `"play"` is
 * literally the correct wire action to RESUME a paused session (there is
 * no separate "resume" verb — `UnityPipelineClient.ts`'s `editor_play` is
 * the one command that both starts from stopped and resumes from paused),
 * so collapsing stopped+paused onto the same face is the toggle correctly
 * tracking what its click DOES, not merely mirroring the three raw states
 * 1:1. `null` (no status read yet — see `EngineToolbarView.playState`'s own
 * doc comment for where this can come from: presence, the CLI echo, or
 * neither) falls into the same `"play"` face — showing Pause would claim
 * knowledge of a playing session this client has no evidence for.
 *
 * SUPERSEDED 2026-08-10 (unity-playstate-presence.md): this doc used
 * to say `null` means "there is no live status feed for Unity, only a
 * caller-supplied last-known value." As of Unity package 0.3.1 there IS a
 * live status feed (Unity's presence `playState`) — `null` now means
 * neither that feed nor the CLI echo has an opinion, a narrower and rarer
 * case (no publisher connected AND no prior successful dispatch), not "no
 * live feed exists at all."
 *
 * Pause remains a separate latch and always dispatches `"pause"`.
 */
export function resolveUnityPlayToggleAction(
  playState: EditorPresencePlayState | null,
): "play" | "stop" {
  return playState === "playing" ? "stop" : "play";
}

/** Whether Unity's separate Pause button should use its engaged visual. */
export function isUnityPauseEngaged(playState: EditorPresencePlayState | null): boolean {
  return playState === "paused";
}

/** A running or paused session can be paused; stopped and unknown cannot. */
export function isUnityPauseAvailable(playState: EditorPresencePlayState | null): boolean {
  return playState === "playing" || playState === "paused";
}
