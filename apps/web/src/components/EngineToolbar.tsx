// The Play/Stop toolbar (#52). Lives in the chat header's action row
// (`ChatHeader.tsx`), styled to match its neighbours there — `outline`/`xs`
// buttons, `Group`/`GroupSeparator` for a segmented cluster — the same
// convention `ProjectScriptsControl` ("Add action") and `GitActionsControl`
// ("Open" / "Publish repository") already use, per the owner's explicit
// ask to match those rather than stand out. Originally styled after
// `ProviderModelPicker.tsx`'s composer-footer `ComposerControl` look before
// the header move; this file no longer imports that pattern at all.
//
// Presentational: every read comes in as a prop, every write goes out as a
// callback. All of the actual decision logic (which controls to show, what
// state Play is in) lives in `EngineToolbar.logic.ts`, already covered by
// its own mutation-proven test suite — this file is deliberately thin.
import type { EngineType } from "@t3tools/contracts";
import {
  ChevronDownIcon,
  PauseIcon,
  PlayIcon,
  RotateCcwIcon,
  SquareIcon,
  StepForwardIcon,
} from "lucide-react";

import {
  isPlayEngaged,
  resolveUnityPlayToggleAction,
  type EngineToolbarAction,
  type EngineToolbarView,
} from "./EngineToolbar.logic";
import { MenuGroup, MenuItem } from "./ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { Group, GroupSeparator } from "./ui/group";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";

const ENGINE_LABELS: Readonly<Record<EngineType, string>> = {
  unity: "Unity",
  unreal: "Unreal",
  godot: "Godot",
  threejs: "three.js",
};

const ACTION_ICON: Readonly<Record<EngineToolbarAction, typeof PlayIcon>> = {
  play: PlayIcon,
  pause: PauseIcon,
  stop: SquareIcon,
  step: StepForwardIcon,
};

const ACTION_LABEL: Readonly<Record<EngineToolbarAction, string>> = {
  play: "Play",
  pause: "Pause",
  stop: "Stop",
  step: "Step",
};

export interface EngineToolbarProps {
  /**
   * The DETECTED engine — never a user choice (owner ruling: "it's not a
   * 'pick your project', it's just detection of project type, so we should
   * not have it selectable"). `null` when nothing's been detected for this
   * project yet — the label still renders (as "No engine"), the control
   * cluster does not.
   */
  readonly resolvedEngineType: EngineType | null;
  readonly view: EngineToolbarView;
  /** One callback for every control button — the caller switches on the
   * action rather than this component exposing four separate props. */
  readonly onAction: (action: EngineToolbarAction) => void;
  /** three.js has no engine to command; Play here means "run the project's
   * dev script and open the preview" — the existing #51 path, not a
   * presence command. Absent (rather than always-present-and-sometimes-a-
   * no-op) when the resolved engine isn't three.js, so a caller can never
   * wire it to the wrong project by accident. */
  readonly onPlayThreeJs?: () => void;
  /**
   * Why `onPlayThreeJs` is absent, shown in the disabled button's tooltip.
   * Per the "disabled-with-a-reason, never hidden-or-silently-broken"
   * principle: preview is desktop-runtime-only (`isPreviewSupportedInRuntime()`),
   * so a plain browser tab must degrade honestly rather than appear to work.
   */
  readonly threeJsUnavailableReason?: string;
  /**
   * Whether THIS session currently holds `presence:command`. `false` for
   * an unelevated browser tab — see the pairing-link scope option in
   * Settings > Connections, the existing grant path this toolbar points at
   * rather than duplicating. Irrelevant for three.js (no command is ever
   * sent), so it only gates the presence-command control cluster.
   */
  readonly hasPresenceCommandScope: boolean;
  readonly onOpenConnectionsSettings?: () => void;
  /**
   * Re-runs `unitySetupProbeAtom` for this environment (`useEnvironmentQuery`'s
   * `refresh`, threaded down from `ChatView.tsx`) — the toolbar's escape
   * hatch from a FAILED status check (see `EngineToolbarView.unitySetupCheckFailed`),
   * closing the "unbounded spinner with no way out" half of #106.
   * `ConnectionsSettings.tsx`'s Settings panel already has an equivalent
   * Retry button; this is the toolbar's.
   */
  readonly onRetryUnitySetup?: () => void;
  /**
   * Seeds a new chat turn asking the agent to diagnose and fix this
   * project's Unity setup — the CTA's whole job (see
   * `unitySetupPrompt.ts`'s doc comment: the click IS the consent,
   * `.agents/skills/unity-setup/SKILL.md` doesn't ask again). Only ever
   * rendered/called for the `"unity-cli"` backend's not-ready state.
   */
  readonly onSetupUnityIntegrations?: () => void;
}

export function EngineToolbar(props: EngineToolbarProps) {
  const { view } = props;
  const engineLabel = props.resolvedEngineType
    ? ENGINE_LABELS[props.resolvedEngineType]
    : "No engine";

  return (
    <div className="flex shrink-0 items-center gap-2" data-engine-toolbar="true">
      {/*
        Owner ruling: "it's not a 'pick your project', it's just detection
        of project type, so we should not have it selectable." A plain
        `Badge` (renders as a `<span>` by default — no button semantics, no
        click handler, nothing implying it opens anything) replaces the
        Menu/MenuTrigger dropdown that used to live here. `size="lg"` is the
        closest `Badge` size to the removed button's height (`Button`'s
        `xs`), so this control's neighbours in the header row don't visibly
        reflow.
      */}
      <Badge variant="outline" size="lg" className="max-w-24 truncate px-2 font-medium">
        {engineLabel}
      </Badge>

      {view.backend === "threejs-script" ? (
        <ThreeJsPlayButton
          {...(props.onPlayThreeJs ? { onPlay: props.onPlayThreeJs } : {})}
          {...(props.threeJsUnavailableReason
            ? { unavailableReason: props.threeJsUnavailableReason }
            : {})}
        />
      ) : view.backend ? (
        <ControlCluster
          view={view}
          hasPresenceCommandScope={props.hasPresenceCommandScope}
          onAction={props.onAction}
          {...(props.onOpenConnectionsSettings
            ? { onOpenConnectionsSettings: props.onOpenConnectionsSettings }
            : {})}
          {...(props.onRetryUnitySetup ? { onRetryUnitySetup: props.onRetryUnitySetup } : {})}
          {...(props.onSetupUnityIntegrations
            ? { onSetupUnityIntegrations: props.onSetupUnityIntegrations }
            : {})}
        />
      ) : null}
    </div>
  );
}

/**
 * three.js's Play button is a single, unconditional control — no capability
 * gating (there's no publisher to advertise anything), no presence scope.
 * When `onPlay` is absent (no preview surface in this runtime, or no
 * configured preview script) it disables WITH a reason, per the
 * "disabled-with-a-reason, never hidden-or-silently-broken" principle: a
 * vanished control teaches the user nothing, a silently-broken one is worse.
 */
function ThreeJsPlayButton(props: {
  readonly onPlay?: () => void;
  readonly unavailableReason?: string;
}) {
  // Single source for the accessible name AND the tooltip body — see #111:
  // a hand-written second `aria-label` literal is exactly how the "Run
  // preview" bug (and #107's Unity twin) drifted from the real disabled
  // reason. One expression, two consumers, divergence impossible.
  const label = props.onPlay || !props.unavailableReason ? "Run preview" : props.unavailableReason;
  const button = (
    <Button
      size="xs"
      variant="outline"
      aria-label={label}
      disabled={!props.onPlay}
      onClick={() => props.onPlay?.()}
    >
      <PlayIcon className="size-3.5" aria-hidden />
      <span className="ml-0.5">Play</span>
    </Button>
  );
  if (props.onPlay || !props.unavailableReason) return button;
  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
}

function ControlCluster(props: {
  readonly view: EngineToolbarView;
  /** Whether THIS session currently holds `presence:command` — irrelevant
   * unless `view.requiresPresenceCommandScope` is true. Unity's `"unity-cli"`
   * backend and three.js's `"threejs-script"` backend never gate on this;
   * only `"editor-presence"` (Godot today) does — see
   * `EngineToolbar.logic.ts`'s `EngineDispatchBackend` doc comment for why
   * the scope check moved from a toolbar-wide flag to a per-view field. */
  readonly hasPresenceCommandScope: boolean;
  readonly onAction: (action: EngineToolbarAction) => void;
  readonly onOpenConnectionsSettings?: () => void;
  /** See `EngineToolbarProps.onRetryUnitySetup`'s own doc comment. */
  readonly onRetryUnitySetup?: () => void;
  /** See `EngineToolbarProps.onSetupUnityIntegrations`'s own doc comment. */
  readonly onSetupUnityIntegrations?: () => void;
}) {
  const { view } = props;
  const isUnity = view.backend === "unity-cli";

  if (view.requiresPresenceCommandScope && !props.hasPresenceCommandScope) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="xs"
              variant="outline"
              aria-label="Engine control requires an additional permission"
              onClick={() => props.onOpenConnectionsSettings?.()}
            >
              <PlayIcon className="size-3.5" aria-hidden />
              <span className="ml-0.5">Play</span>
            </Button>
          }
        />
        <TooltipPopup side="bottom">
          This session can't send engine commands yet. Grant "Control connected editors" in Settings
          → Connections.
        </TooltipPopup>
      </Tooltip>
    );
  }

  if (view.availableActions.length === 0) {
    // `view.disabledReason` is the specific, backend-supplied reason
    // (Unity's `UnitySetupProbe`-classified sentence today) — the fallback
    // ternary below is `"editor-presence"`'s own generic copy, kept for
    // when nothing more specific is available rather than replaced, since
    // `disabledReason` is `null` there by design (see `EngineToolbarView`'s
    // doc comment).
    const reason =
      view.disabledReason ??
      (view.hasConnectedEditor
        ? "The connected editor hasn't advertised any commands yet."
        : "No editor is connected for this project.");
    // #107: the accessible name used to be the hard-coded literal
    // "No editor connected" regardless of `reason` — so a screen reader (and
    // our own computer-use QA driver, which reads the accessible NAME, not
    // the visible tooltip) always heard that generic sentence even when
    // `reason` had Unity's own specific classified message. Same fix as
    // #111's `ThreeJsPlayButton`/`RightPanelMaximizeControl`: one expression
    // drives both the aria-label and the tooltip body, so they can't drift.
    const disabledPlayButton = (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button size="xs" variant="outline" disabled aria-label={reason}>
              <PlayIcon className="size-3.5" aria-hidden />
              <span className="ml-0.5">Play</span>
            </Button>
          }
        />
        <TooltipPopup side="bottom">{reason}</TooltipPopup>
      </Tooltip>
    );
    // Retry only ever offered for a FAILED status check (a rejected fetch,
    // or the probe atom's own bounded wait for the connection giving up —
    // #106), never for a confirmed classifier state: retrying "Pipeline
    // package missing" wouldn't produce a different answer, so no control
    // is shown there — see `unitySetupCheckFailed`'s own doc comment.
    const retryButton =
      view.unitySetupCheckFailed && props.onRetryUnitySetup ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="outline"
                aria-label="Retry checking Unity's status"
                onClick={() => props.onRetryUnitySetup?.()}
              />
            }
          >
            <RotateCcwIcon className="size-3.5" aria-hidden />
          </TooltipTrigger>
          <TooltipPopup side="bottom">Retry checking Unity's status</TooltipPopup>
        </Tooltip>
      ) : null;

    // The owner's mock: not-ready Unity gets a loud CTA (the header saying
    // what to do next) beside the same disabled Play a sighted user would
    // otherwise stare at with no obvious next step — but ONLY when
    // `view.unityInstallOffered` says an install would actually fix THIS
    // project's specific not-ready reason (see
    // `shouldOfferUnityPipelineInstall`'s own doc comment in
    // EngineToolbar.logic.ts for the exact facts it's gated on — package
    // missing and CLI available is all it needs; Unity's own live state is
    // deliberately irrelevant, since the install works with Unity closed).
    // Every OTHER not-ready reason (no CLI, package already declared and
    // just awaiting Unity's resolver) falls through to the plain
    // disabledPlayButton below — showing an "install" CTA next to a problem
    // installing can't fix would be a control that looks like it helps but
    // doesn't.
    //
    // `variant="default"` is the SAME filled/`--primary` vocabulary
    // `ComposerPrimaryActions.tsx`'s own "Implement" button and the
    // plan-sidebar submit button already use elsewhere in this codebase —
    // reusing that existing variant rather than hand-rolling bespoke classes
    // matching the composer send button's exact (differently-directioned)
    // hover state, so this doesn't become a THIRD subtly-different "filled
    // button" convention. This is the first `variant="default"` control in
    // this header row — every neighbour (`Add action`, `Open`, `Commit`,
    // and every other control in THIS toolbar) is `variant="outline"`;
    // deliberate, per the mock, not an oversight.
    if (view.unityInstallOffered && props.onSetupUnityIntegrations) {
      const onSetupUnityIntegrations = props.onSetupUnityIntegrations;
      return (
        <div className="flex shrink-0 items-center gap-1">
          <Button size="xs" variant="default" onClick={() => onSetupUnityIntegrations()}>
            Setup Unity Integrations
          </Button>
          {disabledPlayButton}
          {retryButton}
        </div>
      );
    }

    if (!retryButton) {
      return disabledPlayButton;
    }
    return (
      <div className="flex shrink-0 items-center gap-1">
        {disabledPlayButton}
        {retryButton}
      </div>
    );
  }

  // Owner's mock, ready state, ORIGINALLY: "collapses to two quiet outline
  // buttons — Unity (bring the Editor to the front) and Play (bring to
  // front AND play)." Deliberately Unity-only — every OTHER engine (Godot/
  // Unreal today, both `"editor-presence"`) keeps the existing multi-action
  // Group below untouched; that toolbar path isn't part of this change
  // (owner, separately: sharing this structure across engines is explicitly
  // "later," not this change — see `resolveUnityPlayToggleAction`'s own
  // comment about that Group staying at four separate buttons).
  //
  // The Play button is now a Play/Pause TOGGLE — owner ruling, 2026-08-05,
  // verbatim: "play and stop are the main ones for now, same area (toggle
  // essentially) when unity is on play, shows pause there, and vice verse
  // etc." `resolveUnityPlayToggleAction` (EngineToolbar.logic.ts) is the
  // pure derivation of what the toggle's next click sends; this component
  // only renders its answer.
  //
  // Where Stop lives (this build's own design call, since the owner's
  // instruction named the toggle's two faces but not Stop's placement):
  // a THIRD, always-visible button next to the toggle, disabled with a
  // stated reason while nothing is playing — not folded into the toggle
  // (a play/pause/stop three-way cycle on one button is a worse click
  // model than Unity's own editor toolbar, which the owner's mock is
  // modeled on: Play and Stop are separate controls there too), and not a
  // control that only APPEARS once something is playing (this file's own
  // "disabled-with-a-reason, never hidden-or-silently-broken" principle —
  // see `ThreeJsPlayButton`'s doc comment — applies here exactly as it does
  // to every other control in this file; an appearing/disappearing button
  // is a worse discoverability story than one that's honestly disabled,
  // and the owner named Stop as one of "the main ones," not a conditional
  // extra).
  //
  // Still deliberately NOT attempted, per the owner not having ruled on it:
  //  - Bring-to-front. `open -a "Unity"` via `ExternalLauncher` is a
  //    separate task. The `Unity` button below is PRESENT but DISABLED with
  //    a stated reason, not omitted and not a silent no-op — same principle
  //    as Stop's disabled state above: a control that LOOKS clickable but
  //    does nothing on click would be worse than one that's honestly
  //    disabled, and omitting it entirely would leave the ready state
  //    showing only two buttons, not the trio this change now renders.
  if (isUnity) {
    const engaged = isPlayEngaged(view.playState);
    const toggleAction = resolveUnityPlayToggleAction(view.playState);
    const ToggleIcon = toggleAction === "pause" ? PauseIcon : PlayIcon;
    const toggleLabel = toggleAction === "pause" ? "Pause" : "Play";
    // Same single-expression-drives-both-aria-label-and-tooltip discipline
    // #111 established (see `ThreeJsPlayButton`'s doc comment) — a disabled
    // Stop that a screen reader announces as just "Stop," with no hint that
    // clicking does nothing, is the same class of bug #107 fixed for the
    // ready-state Play button.
    const stopLabel = engaged ? "Stop" : "Nothing is playing to stop.";
    return (
      <div className="flex shrink-0 items-center gap-1">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button size="xs" variant="outline" disabled aria-label="Bring Unity to the front">
                Unity
              </Button>
            }
          />
          <TooltipPopup side="bottom">
            Bringing the Unity Editor to the front isn't wired up yet.
          </TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="xs"
                variant={engaged ? "default" : "outline"}
                aria-label={toggleLabel}
                aria-pressed={engaged}
                onClick={() => props.onAction(toggleAction)}
              >
                <ToggleIcon className="size-3.5" aria-hidden />
                <span className="ml-0.5">{toggleLabel}</span>
              </Button>
            }
          />
          <TooltipPopup side="bottom">{toggleLabel}</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="xs"
                variant="outline"
                disabled={!engaged}
                aria-label={stopLabel}
                onClick={() => props.onAction("stop")}
              >
                <SquareIcon className="size-3.5" aria-hidden />
                <span className="ml-0.5">Stop</span>
              </Button>
            }
          />
          <TooltipPopup side="bottom">{stopLabel}</TooltipPopup>
        </Tooltip>
      </div>
    );
  }

  return (
    <Group aria-label="Engine controls" className="shrink-0">
      {view.availableActions.map((action) => {
        const Icon = ACTION_ICON[action];
        const isPlay = action === "play";
        const engaged = isPlay && isPlayEngaged(view.playState);
        return (
          <Tooltip key={action}>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant={engaged ? "default" : "outline"}
                  aria-label={ACTION_LABEL[action]}
                  aria-pressed={engaged}
                  onClick={() => props.onAction(action)}
                />
              }
            >
              <Icon className="size-3.5" aria-hidden />
            </TooltipTrigger>
            <TooltipPopup side="bottom">{ACTION_LABEL[action]}</TooltipPopup>
          </Tooltip>
        );
      })}
      {/* Separator before the play-target chevron, matching
          `GitActionsControl`'s quick-action-plus-chevron shape exactly —
          one separator between the button cluster and the menu trigger,
          not between every individual button. */}
      <GroupSeparator />
      <PlayTargetMenu onAction={props.onAction} />
    </Group>
  );
}

/**
 * The play-target dropdown slot, built from v1 even though it holds exactly
 * one entry today — the future landing spot for per-scene play targets
 * (Unreal's "Selected Viewport / New Editor Window / VR / Standalone" is
 * the reference shape; deferred with the rest of Unreal, but the slot
 * itself isn't engine-specific and costs nothing to have ready now). The
 * one entry present today does the same thing the Play button does; it
 * exists so the slot is exercised rather than dead UI. Grouped as the last
 * segment of the same `Group` the control buttons sit in, mirroring
 * `GitActionsControl`'s quick-action-plus-chevron shape exactly.
 */
function PlayTargetMenu(props: { readonly onAction: (action: EngineToolbarAction) => void }) {
  return (
    <Popover>
      <PopoverTrigger
        render={<Button size="icon-xs" variant="outline" aria-label="Play target options" />}
      >
        <ChevronDownIcon aria-hidden="true" className="size-3.5" />
      </PopoverTrigger>
      <PopoverPopup align="end">
        <MenuGroup>
          <MenuItem onClick={() => props.onAction("play")}>Default</MenuItem>
        </MenuGroup>
      </PopoverPopup>
    </Popover>
  );
}
