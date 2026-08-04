// The Play/Stop toolbar (#52). Appearance copied from
// `ProviderModelPicker.tsx`'s Popover + `ComposerControl` trigger pattern —
// deliberately NOT its state model, which mounts per composer/per chat tab.
// This toolbar's engine selection is per-PROJECT (`engineSelectorStore.ts`),
// so every thread against the same project sees the same selector state no
// matter where in the DOM this component happens to be mounted.
//
// Presentational: every read comes in as a prop, every write goes out as a
// callback. All of the actual decision logic (which controls to show, what
// state Play is in) lives in `EngineToolbar.logic.ts`, already covered by
// its own mutation-proven test suite — this file is deliberately thin.
import type { EngineType } from "@t3tools/contracts";
import { ChevronDownIcon, PauseIcon, PlayIcon, SquareIcon, StepForwardIcon } from "lucide-react";

import { ComposerControl, ComposerControlChevron } from "./chat/ComposerControl";
import {
  isPlayEngaged,
  type EngineToolbarAction,
  type EngineToolbarView,
} from "./EngineToolbar.logic";
import { Menu, MenuGroup, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { Button } from "./ui/button";
import { cn } from "~/lib/utils";

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
}

export function EngineToolbar(props: EngineToolbarProps) {
  const { view } = props;
  const engineLabel = props.resolvedEngineType
    ? ENGINE_LABELS[props.resolvedEngineType]
    : "No engine";

  return (
    <div className="flex items-center gap-1" data-engine-toolbar="true">
      <Menu>
        <MenuTrigger
          render={
            <ComposerControl
              aria-label="Select engine"
              className="max-w-32 min-w-0 justify-between whitespace-nowrap"
            />
          }
        >
          <span className="min-w-0 flex-1 truncate">{engineLabel}</span>
          <ComposerControlChevron />
        </MenuTrigger>
        <MenuPopup align="start">
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
  const button = (
    <Button
      size="sm"
      variant="default"
      aria-label="Run preview"
      disabled={!props.onPlay}
      onClick={() => props.onPlay?.()}
    >
      <PlayIcon />
      Play
    </Button>
  );
  if (props.onPlay || !props.unavailableReason) return button;
  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipPopup side="bottom">{props.unavailableReason}</TooltipPopup>
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
}) {
  const { view } = props;

  if (view.requiresPresenceCommandScope && !props.hasPresenceCommandScope) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="sm"
              variant="ghost"
              aria-label="Engine control requires an additional permission"
              onClick={() => props.onOpenConnectionsSettings?.()}
            >
              <PlayIcon />
              Play
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
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button size="sm" variant="ghost" disabled aria-label="No editor connected">
              <PlayIcon />
              Play
            </Button>
          }
        />
        <TooltipPopup side="bottom">
          {view.hasConnectedEditor
            ? "The connected editor hasn't advertised any commands yet."
            : "No editor is connected for this project."}
        </TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <div className="flex items-center gap-0.5">
      {view.availableActions.map((action) => {
        const Icon = ACTION_ICON[action];
        const isPlay = action === "play";
        const engaged = isPlay && isPlayEngaged(view.playState);
        return (
          <span key={action} className={cn("flex items-center", isPlay && "relative")}>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-sm"
                    variant={engaged ? "default" : "ghost"}
                    aria-label={ACTION_LABEL[action]}
                    aria-pressed={engaged}
                    onClick={() => props.onAction(action)}
                  />
                }
              >
                <Icon />
              </TooltipTrigger>
              <TooltipPopup side="bottom">{ACTION_LABEL[action]}</TooltipPopup>
            </Tooltip>
            {isPlay ? <PlayTargetMenu onAction={props.onAction} /> : null}
          </span>
        );
      })}
    </div>
  );
}

/**
 * The play-target dropdown slot, built from v1 even though it holds exactly
 * one entry today — the future landing spot for per-scene play targets
 * (Unreal's "Selected Viewport / New Editor Window / VR / Standalone" is
 * the reference shape; deferred with the rest of Unreal, but the slot
 * itself isn't engine-specific and costs nothing to have ready now). The
 * one entry present today does the same thing the Play button does; it
 * exists so the slot is exercised rather than dead UI.
 */
function PlayTargetMenu(props: { readonly onAction: (action: EngineToolbarAction) => void }) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Play target options"
            className="-ml-0.5"
          />
        }
      >
        <ChevronDownIcon className="size-3" />
      </PopoverTrigger>
      <PopoverPopup align="start">
        <MenuGroup>
          <MenuItem onClick={() => props.onAction("play")}>Default</MenuItem>
        </MenuGroup>
      </PopoverPopup>
    </Popover>
  );
}
