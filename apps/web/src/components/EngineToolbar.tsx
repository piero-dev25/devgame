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
  isUnityPauseAvailable,
  isUnityPauseEngaged,
  resolveUnityPlayToggleAction,
  type EngineToolbarAction,
  type EngineToolbarView,
} from "./EngineToolbar.logic";
import { UnityIcon } from "./icons/UnityIcon";
import { MenuGroup, MenuItem } from "./ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { Group, GroupSeparator } from "./ui/group";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Spinner } from "./ui/spinner";

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
   * Re-runs `unitySetupProbeAtom` for this (environment, project) pair —
   * probe identity gained the project half when the routes became
   * project-scoped (`useEnvironmentQuery`'s `refresh`, threaded down from
   * `ChatView.tsx`) — the toolbar's escape hatch from a FAILED status check
   * (see `EngineToolbarView.unitySetupCheckFailed`), closing the "unbounded
   * spinner with no way out" half of #106.
   * `ConnectionsSettings.tsx`'s Settings panel already has an equivalent
   * Retry button; this is the toolbar's.
   */
  readonly onRetryUnitySetup?: () => void;
  /**
   * Installs BOTH Unity packages directly (Pipeline via the CLI, the
   * selection package as an embedded copy — f95c1731c) — no chat turn, no
   * agent, no second confirmation dialog (owner ruling, mid-build revision:
   * the click IS the consent). Calls `postUnityPipelineInstall` (see
   * `ChatView.tsx`'s `handleSetupUnityIntegrations`, the sole implementation
   * of this prop). Rendered while `EngineToolbarView.unityInstallOffered`
   * is true — in the not-ready branch (Pipeline missing) AND in the ready
   * trio (S9: Play works, selection package missing — chips silently off,
   * #129); see `shouldOfferUnityPipelineInstall`'s doc comment for the
   * exact facts.
   *
   * `unitySetupPrompt.ts` — the chat-turn prompt builder this doc comment
   * used to point at — was deleted with the CTA's install-direct revision;
   * do not resurrect that reference for a second caller of this prop.
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
        reflow. Unity replaces this badge with its merged icon-led control;
        every other engine and the no-engine case retain it.
      */}
      {view.backend !== "unity-cli" ? (
        <Badge variant="outline" size="lg" className="max-w-24 truncate px-2 font-medium">
          {engineLabel}
        </Badge>
      ) : null}

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
  // QA round 2 (#124): a NATIVELY `disabled` control never receives pointer
  // events (mouseenter/mouseover) — browsers skip disabled form controls
  // during hit-testing — so a Tooltip/TooltipTrigger wrapped around one can
  // never open on hover. The accessible name was always correct (aria-label
  // doesn't depend on hover), but a sighted pointer user — exactly the
  // audience `unavailableReason` exists for — saw nothing. `aria-disabled`
  // instead of `disabled` keeps the element in the pointer AND focus flow
  // (a genuine improvement: it's now keyboard-reachable too) so the
  // tooltip/focus-visible ring can actually fire; the disabled LOOK
  // (`cursor-not-allowed`/dimmed) is now hand-drawn via `className` since
  // the base button's `disabled:opacity-64` Tailwind variant no longer
  // applies without the native attribute. No separate click guard needed
  // here — `props.onPlay?.()` was already a no-op when `onPlay` is absent.
  // Same fix applies to the disabled Unity identity/transport controls and
  // the generic editor-presence fallback below.
  const disabled = !props.onPlay;
  const button = (
    <Button
      size="xs"
      variant="outline"
      aria-label={label}
      aria-disabled={disabled || undefined}
      className={disabled ? "cursor-not-allowed opacity-64" : undefined}
      onClick={() => props.onPlay?.()}
    >
      <PlayIcon className="size-3.5" aria-hidden />
      <span className="ml-0.5">Play</span>
    </Button>
  );
  if (!disabled || !props.unavailableReason) return button;
  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
}

const UNITY_BRING_TO_FRONT_REASON = "Bringing the Unity Editor to the front isn't wired up yet.";
const UNITY_PAUSE_UNAVAILABLE_REASON = "Nothing is playing to pause.";
const UNITY_PERMISSION_REASON =
  'This session can\'t send engine commands yet. Grant "Control connected editors" in Settings → Connections.';

function UnityControlCluster(props: {
  readonly view: EngineToolbarView;
  readonly hasPresenceCommandScope: boolean;
  readonly onAction: (action: EngineToolbarAction) => void;
  readonly onOpenConnectionsSettings?: () => void;
  readonly onRetryUnitySetup?: () => void;
  readonly onSetupUnityIntegrations?: () => void;
}) {
  const { view } = props;
  const ready = view.availableActions.length > 0;
  const unavailableReason =
    view.disabledReason ??
    (view.hasConnectedEditor
      ? "The connected editor hasn't advertised any commands yet."
      : "No editor is connected for this project.");
  const setupOffered =
    props.hasPresenceCommandScope &&
    view.unityInstallOffered &&
    props.onSetupUnityIntegrations !== undefined;
  const unityLabel = ready ? UNITY_BRING_TO_FRONT_REASON : unavailableReason;
  const unityControl = setupOffered ? (
    <Button size="xs" variant="default" onClick={() => props.onSetupUnityIntegrations?.()}>
      <UnityIcon className="size-3.5" />
      <span className="ml-0.5">Setup Integrations</span>
    </Button>
  ) : (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="xs"
            variant="outline"
            aria-disabled="true"
            className="cursor-not-allowed opacity-64"
            aria-label={unityLabel}
          >
            <UnityIcon className="size-3.5" />
            <span className="ml-0.5">Unity</span>
          </Button>
        }
      />
      <TooltipPopup side="bottom">{unityLabel}</TooltipPopup>
    </Tooltip>
  );

  const transportBlockedReason = !props.hasPresenceCommandScope
    ? UNITY_PERMISSION_REASON
    : ready
      ? null
      : unavailableReason;
  const retryLabel = "Retry checking Unity's status";
  const retryButton =
    !ready && view.unitySetupCheckFailed && props.onRetryUnitySetup ? (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-xs"
              variant="outline"
              aria-label={retryLabel}
              onClick={() => props.onRetryUnitySetup?.()}
            />
          }
        >
          <RotateCcwIcon className="size-3.5" aria-hidden />
        </TooltipTrigger>
        <TooltipPopup side="bottom">{retryLabel}</TooltipPopup>
      </Tooltip>
    ) : null;
  const pendingIndicator =
    !ready && view.unitySetupPending ? (
      <div
        role="status"
        aria-live="polite"
        className="flex items-center gap-1.5 text-xs text-muted-foreground"
      >
        <Spinner className="size-3 shrink-0" aria-hidden />
        <span>Checking Unity's status…</span>
      </div>
    ) : null;

  return (
    <div className="flex shrink-0 items-center gap-1">
      {unityControl}
      <UnityTransportGroup
        playState={view.playState}
        blockedReason={transportBlockedReason}
        onAction={props.onAction}
        {...(!props.hasPresenceCommandScope && props.onOpenConnectionsSettings
          ? { onBlockedClick: props.onOpenConnectionsSettings }
          : {})}
      />
      {retryButton}
      {pendingIndicator}
    </div>
  );
}

function UnityTransportGroup(props: {
  readonly playState: EngineToolbarView["playState"];
  readonly blockedReason: string | null;
  readonly onAction: (action: EngineToolbarAction) => void;
  readonly onBlockedClick?: () => void;
}) {
  const blocked = props.blockedReason !== null;
  const toggleAction = resolveUnityPlayToggleAction(props.playState);
  const toggleEngaged = !blocked && toggleAction === "stop";
  const ToggleIcon = toggleEngaged ? SquareIcon : PlayIcon;
  const toggleLabel = blocked
    ? `Play — ${props.blockedReason}`
    : toggleAction === "stop"
      ? "Stop"
      : "Play";
  const pauseAvailable = !blocked && isUnityPauseAvailable(props.playState);
  const pauseEngaged = !blocked && isUnityPauseEngaged(props.playState);
  const pauseLabel = blocked
    ? `Pause — ${props.blockedReason}`
    : pauseAvailable
      ? "Pause"
      : UNITY_PAUSE_UNAVAILABLE_REASON;
  const blockedOpensSettings = blocked && props.onBlockedClick !== undefined;

  return (
    <Group aria-label="Unity transport controls" className="shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-xs"
              variant={toggleEngaged ? "default" : "outline"}
              aria-label={toggleLabel}
              aria-pressed={toggleEngaged}
              aria-disabled={blocked && !blockedOpensSettings ? "true" : undefined}
              className="aria-disabled:cursor-not-allowed aria-disabled:opacity-64"
              onClick={() => {
                if (blocked) {
                  props.onBlockedClick?.();
                  return;
                }
                props.onAction(toggleAction);
              }}
            />
          }
        >
          <ToggleIcon className="size-3.5" aria-hidden />
        </TooltipTrigger>
        <TooltipPopup side="bottom">{toggleLabel}</TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-xs"
              variant={pauseEngaged ? "default" : "outline"}
              aria-label={pauseLabel}
              aria-pressed={pauseEngaged}
              aria-disabled={(!pauseAvailable && !blockedOpensSettings) || undefined}
              className="aria-disabled:cursor-not-allowed aria-disabled:opacity-64"
              onClick={() => {
                if (blocked) {
                  props.onBlockedClick?.();
                  return;
                }
                if (pauseAvailable) props.onAction("pause");
              }}
            />
          }
        >
          <PauseIcon className="size-3.5" aria-hidden />
        </TooltipTrigger>
        <TooltipPopup side="bottom">{pauseLabel}</TooltipPopup>
      </Tooltip>
    </Group>
  );
}

function ControlCluster(props: {
  readonly view: EngineToolbarView;
  /** Whether THIS session currently holds `presence:command`. Unity is
   * handled by `UnityControlCluster` above; the remaining generic path gates
   * editor-presence backends here. */
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

  if (isUnity) {
    return <UnityControlCluster {...props} />;
  }

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
    // `view.disabledReason` is the specific, backend-supplied reason; the
    // fallback is editor-presence's generic copy when none is available.
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
    // QA round 2 (#124): `aria-disabled` + hand-drawn disabled styling
    // instead of the native `disabled` attribute — see `ThreeJsPlayButton`'s
    // own doc comment for the full root-cause explanation (natively
    // disabled controls never receive pointer events, so a wrapping
    // Tooltip's hover trigger never fires). No onClick here to guard —
    // this button never had one.
    const disabledPlayButton = (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="xs"
              variant="outline"
              aria-disabled="true"
              className="cursor-not-allowed opacity-64"
              aria-label={reason}
            >
              <PlayIcon className="size-3.5" aria-hidden />
              <span className="ml-0.5">Play</span>
            </Button>
          }
        />
        <TooltipPopup side="bottom">{reason}</TooltipPopup>
      </Tooltip>
    );
    return disabledPlayButton;
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
