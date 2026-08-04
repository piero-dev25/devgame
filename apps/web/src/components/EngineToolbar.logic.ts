// Pure derivation for the Play/Stop toolbar (#52). No React, no store reads
// — every input is a plain value the component (or a test) hands in, so the
// actual decision of "what does this toolbar show right now" is checkable
// without mounting anything or faking a WebSocket.
import type { EngineType } from "@t3tools/contracts";

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

export interface EngineToolbarView {
  /** The engine this toolbar targets — override or detected, resolved by
   * the caller via `selectProjectEngineType` before this function runs.
   * `null` means no engine is known for the project at all: the toolbar
   * still renders (so the engine selector remains reachable), but with no
   * control cluster. */
  readonly engineType: EngineType | null;
  /** three.js has no engine to command — "Play" means running the
   * project's dev script and opening the preview (#51's existing path),
   * never a presence command. Every other field below is meaningless when
   * this is true; the component branches on it first. */
  readonly isThreeJs: boolean;
  /** Whether a connected editor was found for this project's workspace
   * root. `false` for three.js (irrelevant) and for any engine with
   * nothing currently connected — the correct response is a disabled
   * control cluster, not a hidden toolbar: the engine is known even when
   * nothing is connected right now. */
  readonly hasConnectedEditor: boolean;
  /** Actions to render, already filtered to what the connected editor
   * actually advertised — see spec-editor-presence-commands.md's
   * "Capability advertisement": an unadvertised action must never appear
   * as an enabled (or even present) control, since a plugin that hasn't
   * implemented it will hang, not answer `unsupported_action`. Empty when
   * there is no connected editor. */
  readonly availableActions: ReadonlyArray<EngineToolbarAction>;
  readonly playState: EditorPresencePlayState | null;
}

function toActionSet(capabilities: ReadonlyArray<EditorPresenceCapability>): ReadonlySet<string> {
  return new Set(capabilities);
}

export function resolveEngineToolbarView(input: {
  readonly engineType: EngineType | null;
  readonly connectedEditor: EditorPresenceEntry | null;
}): EngineToolbarView {
  const { engineType, connectedEditor } = input;
  const isThreeJs = engineType === "threejs";
  if (isThreeJs || !connectedEditor) {
    return {
      engineType,
      isThreeJs,
      hasConnectedEditor: false,
      availableActions: [],
      playState: null,
    };
  }
  const actionSet = toActionSet(connectedEditor.capabilities);
  return {
    engineType,
    isThreeJs: false,
    hasConnectedEditor: true,
    availableActions: CONTROL_ACTION_ORDER.filter((action) => actionSet.has(action)),
    playState: connectedEditor.playState,
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
