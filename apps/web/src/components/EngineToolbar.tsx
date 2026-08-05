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
  type EngineToolbarAction,
  type EngineToolbarView,
} from "./EngineToolbar.logic";
import { Menu, MenuGroup, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { Group, GroupSeparator } from "./ui/group";
import { Button } from "./ui/button";

const ENGINE_LABELS: Readonly<Record<EngineType, string>> = {
  unity: "Unity",
  unreal: "Unreal",
  godot: "Godot",
  threejs: "three.js",
};

const ENGINE_OPTIONS: ReadonlyArray<EngineType> = ["godot", "unity", "unreal", "threejs"];

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
  /** `null` when the project has no detected or overridden engine yet — the
   * selector still renders (so a user can set one), the control cluster
   * does not. */
  readonly resolvedEngineType: EngineType | null;
  readonly view: EngineToolbarView;
  readonly onSelectEngine: (engine: EngineType) => void;
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
}

export function EngineToolbar(props: EngineToolbarProps) {
  const { view } = props;
  const engineLabel = props.resolvedEngineType
    ? ENGINE_LABELS[props.resolvedEngineType]
    : "No engine";

  return (
    <div className="flex shrink-0 items-center gap-2" data-engine-toolbar="true">
      <Menu>
        <MenuTrigger render={<Button size="xs" variant="outline" aria-label="Select engine" />}>
          <span className="max-w-24 truncate">{engineLabel}</span>
          <ChevronDownIcon aria-hidden="true" className="size-3.5" />
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuGroup>
            {ENGINE_OPTIONS.map((engine) => (
              <MenuItem key={engine} onClick={() => props.onSelectEngine(engine)}>
                {ENGINE_LABELS[engine]}
              </MenuItem>
            ))}
          </MenuGroup>
        </MenuPopup>
      </Menu>

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
}) {
  const { view } = props;

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
    const disabledPlayButton = (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button size="xs" variant="outline" disabled aria-label="No editor connected">
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
    if (!view.unitySetupCheckFailed || !props.onRetryUnitySetup) {
      return disabledPlayButton;
    }
    const onRetryUnitySetup = props.onRetryUnitySetup;
    return (
      <div className="flex shrink-0 items-center gap-1">
        {disabledPlayButton}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="outline"
                aria-label="Retry checking Unity's status"
                onClick={() => onRetryUnitySetup()}
              />
            }
          >
            <RotateCcwIcon className="size-3.5" aria-hidden />
          </TooltipTrigger>
          <TooltipPopup side="bottom">Retry checking Unity's status</TooltipPopup>
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
