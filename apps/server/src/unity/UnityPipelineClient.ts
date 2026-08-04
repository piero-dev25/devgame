/**
 * Server-side client for Unity's OFFICIAL Pipeline CLI (`com.unity.pipeline`
 * + the `unity` CLI binary it ships alongside) — Play/Stop/Pause for Unity
 * shells out here, NOT through Editor Presence. See
 * docs/workbench/spec-unity-play-stop.md and its owner-directed pivot:
 * `com.unity.pipeline` is already installed in the owner's real project
 * (`~/Projects/Deepmind/Packages/manifest.json`), our own
 * `com.ironmind.editor-presence` package is not, and the `unity` CLI proves
 * a working play/stop round trip against a live Editor RIGHT NOW — so it is
 * the path that can produce a working Play button tonight, not a socket
 * protocol nothing has installed yet. Editor Presence's C# plugin
 * (`unity/com.ironmind.editor-presence/`) is not deleted — it stays the
 * answer for an Editor that can't reach this server directly (behind NAT,
 * remote box) — but it is not this module's concern.
 *
 * VERIFIED LIVE against a real Unity 6000.3.14f1 Editor on a disposable
 * project under `$CLAUDE_JOB_DIR/tmp/unity-cli-test/scratch-project`
 * (created via `Unity -batchmode -quit -createProject`, NEVER
 * `~/Projects/Deepmind` — that is the owner's own running Editor). See this
 * module's test file for the exact `unity` invocations and JSON this
 * implementation is built against — every shape below (the envelope, the
 * `editor_status` result fields, the exact "not ready" error strings) was
 * read from real command output, not from `unity --help` alone.
 *
 * THE DOMAIN-RELOAD HAZARD IS NOT ELIMINATED, JUST SELF-HEALING HERE.
 * Measured live: right after `editor_play` succeeds, `editor_status` (and
 * any other command) can fail for a few seconds with "Cannot connect to
 * Unity Editor Pipeline server at 127.0.0.1:<port>" — the SAME domain
 * reload that used to kill our own WebSocket also drops Pipeline's local
 * HTTP server for a beat. The difference from the original Editor Presence
 * design is not that the reload stopped happening; it's that recovery
 * needs no code of ours — Pipeline's own server comes back on its own, and
 * a plain "retry this specific call" absorbs the gap. `play`/`stop`/`pause`
 * below read status back with a short bounded retry for exactly this
 * reason, matching the verified assertion shape ("read editor state, don't
 * trust the command's own return code").
 *
 * SCOPE, deliberately narrow: play / stop / pause / status / CLI-presence
 * only. No `eval`/`eval_file` (arbitrary C# execution, not bounded by
 * `set_authoring_root` — explicitly out per the owner's ruling). No
 * `editor_step` — Pipeline has no frame-step command at all; step remains
 * Unity-only through the (separate, not-this-module) Editor Presence C#
 * plugin. No generic "run any Pipeline command" passthrough — that would
 * be exactly the "general Unity command abstraction" scope creep this task
 * was told to avoid.
 */
import { isCommandAvailable } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";

const UNITY_CLI_COMMAND = "unity";

/** `unity command <name>`'s own default (`--timeout <seconds>`, default 30)
 * — matched here so ProcessRunner's timeout is never the FIRST one to
 * trip; a few extra seconds of margin for process-spawn overhead. */
const COMMAND_TIMEOUT_SEC = "35 seconds";

/** Bounds the post-action status re-read that absorbs the domain-reload
 * gap described in the module doc above. Measured live: the gap was a
 * couple of seconds on a near-empty disposable project; a real project
 * (with more to reload) can reasonably take longer, so this is generous,
 * not tuned to the smallest project that happened to be measured. */
const POST_ACTION_STATUS_RETRY_ATTEMPTS = 15;
const POST_ACTION_STATUS_RETRY_DELAY_MS = 1000;

/** What the toolbar (#52) may offer for a Unity project reached via this
 * CLI path — deliberately NOT `"step"`: Pipeline has no scriptable
 * frame-step command (confirmed against the live `unity command --json`
 * command listing — no `editor_step` anywhere in it), unlike the
 * WebSocket-based Editor Presence plugin, which does implement it. The
 * capability-gated toolbar already refuses to offer a control an engine
 * can't honour; exporting this constant here means the toolbar doesn't
 * have to separately know or guess this Unity-CLI-specific fact. */
export const UNITY_PIPELINE_CAPABILITIES = ["play", "stop", "pause"] as const;
export type UnityPipelineCapability = (typeof UNITY_PIPELINE_CAPABILITIES)[number];

export type UnityPlayMode = "stopped" | "playing" | "paused";

export interface UnityEditorStatus {
  /** Open string on purpose — observed values so far are "ready" (not
   * playing) and "playing" (playing OR paused; pausing does not change
   * this field). `playMode` below is the axis every caller should actually
   * switch on. */
  readonly status: string;
  readonly compiling: boolean;
  readonly domainReloadInProgress: boolean;
  readonly playMode: UnityPlayMode;
  readonly unityVersion: string;
}

/**
 * The outcome shape every operation below resolves with. Deliberately a
 * plain success value (never a Effect failure channel) for the same reason
 * `EditorPresenceCommandOutcome` (protocol.ts) is: the caller — a server
 * RPC handler behind the toolbar's Play button — needs to render EVERY one
 * of these as a distinct UI state, not catch a typed error.
 *
 * `notReady` is the "honest not-ready signal, distinguishable from a
 * failure" the coordination brief asked for: it covers BOTH "no Editor is
 * open for this project" (`No Pipeline instance found for project: <path>`)
 * AND "an Editor is open but its Pipeline server is mid domain-reload"
 * (`Cannot connect to Unity Editor Pipeline server at ...` /
 * `Invalid response format from Pipeline server`) — see the module doc's
 * hazard note. The CLI itself cannot distinguish "package never installed"
 * from "Editor not running" (same error string either way, confirmed
 * live), so this module doesn't pretend to either.
 */
export type UnityPipelineResult<A> =
  | { readonly _tag: "ok"; readonly value: A }
  | { readonly _tag: "notReady" }
  | { readonly _tag: "cliUnavailable" }
  | { readonly _tag: "error"; readonly message: string };

/** Substrings of `errors[].message` observed live for the "retry, this
 * isn't a real failure" case — see the module doc's hazard note. Matched
 * defensively (substring, not exact-string) since Pipeline's own wording
 * is not a contract this repo controls. */
const NOT_READY_MESSAGE_PATTERNS = [
  "No Pipeline instance found for project",
  "Cannot connect to Unity Editor Pipeline server",
  "Invalid response format from Pipeline server",
] as const;

function isNotReadyMessage(message: string): boolean {
  return NOT_READY_MESSAGE_PATTERNS.some((pattern) => message.includes(pattern));
}

interface UnityCliEnvelope {
  readonly success: boolean;
  readonly data: { readonly result: unknown } | null;
  readonly errors: ReadonlyArray<{ readonly code: string; readonly message: string }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Parses the `unity ... --json` envelope common to every subcommand this
 * module calls: `{ success, command, data: { result, ... } | null, errors,
 * warnings }`. Returns `null` for anything that doesn't even look like the
 * envelope (unparseable JSON, or missing the fields every real response
 * has) — the caller treats that the same as a generic `error`, since a
 * shape this far off is not something to guess at. */
function parseUnityCliEnvelope(raw: string): UnityCliEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.success !== "boolean" || !Array.isArray(parsed.errors)) {
    return null;
  }
  const data =
    isRecord(parsed.data) && "result" in parsed.data
      ? { result: parsed.data.result }
      : parsed.data === null
        ? null
        : undefined;
  if (data === undefined) return null;
  return { success: parsed.success, data, errors: parsed.errors };
}

const UNITY_PLAY_MODES: ReadonlySet<string> = new Set<UnityPlayMode>([
  "stopped",
  "playing",
  "paused",
]);

/** Parses `editor_status`'s `data.result` object. `null` on anything that
 * doesn't have the fields this module actually reads — same "don't guess
 * at an unfamiliar shape" posture as `parseUnityCliEnvelope`. */
function parseEditorStatusResult(result: unknown): UnityEditorStatus | null {
  if (!isRecord(result)) return null;
  const { status, compiling, domainReloadInProgress, playMode, unityVersion } = result;
  if (typeof status !== "string") return null;
  if (typeof compiling !== "boolean") return null;
  if (typeof domainReloadInProgress !== "boolean") return null;
  if (typeof playMode !== "string" || !UNITY_PLAY_MODES.has(playMode)) return null;
  if (typeof unityVersion !== "string") return null;
  return {
    status,
    compiling,
    domainReloadInProgress,
    playMode: playMode as UnityPlayMode,
    unityVersion,
  };
}

/** Every failure mode `ProcessRunner.run` itself can produce (spawn
 * failure, timeout, output-limit) folds into the same generic `error` here
 * — `isAvailable`'s pre-check is what's supposed to catch "the binary
 * doesn't exist" before a spawn is even attempted; a `ProcessRunError`
 * reaching this far is an infrastructure problem, not a Pipeline-specific
 * one, and gets no special handling. */
function processRunErrorToResult<A>(
  error: ProcessRunner.ProcessRunError,
): Effect.Effect<UnityPipelineResult<A>> {
  return Effect.succeed({ _tag: "error", message: error.message });
}

export class UnityPipelineClient extends Context.Service<
  UnityPipelineClient,
  {
    /** Whether the `unity` CLI binary is resolvable on PATH at all — the
     * toolbar's own "disabled control with a real reason, not a timeout"
     * requirement for the case Unity's CLI isn't installed, checked BEFORE
     * ever attempting play/stop/pause/status. */
    readonly isAvailable: () => Effect.Effect<boolean>;
    readonly status: (
      workspaceRoot: string,
    ) => Effect.Effect<UnityPipelineResult<UnityEditorStatus>>;
    /** Enters Play Mode, then reads status back (bounded retry through the
     * domain-reload gap) to CONFIRM the effect, per the module doc's
     * "assert the effect" note — never returns `ok` based on `editor_play`
     * accepting the command alone. */
    readonly play: (workspaceRoot: string) => Effect.Effect<UnityPipelineResult<UnityEditorStatus>>;
    readonly stop: (workspaceRoot: string) => Effect.Effect<UnityPipelineResult<UnityEditorStatus>>;
    readonly pause: (
      workspaceRoot: string,
    ) => Effect.Effect<UnityPipelineResult<UnityEditorStatus>>;
  }
>()("t3/unity/UnityPipelineClient") {}

export const make = Effect.gen(function* () {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  // `isCommandAvailable` (packages/shared/src/shell.ts) needs FileSystem/Path
  // to stat PATH candidates — resolved once here and threaded through
  // `isAvailable` below, mirroring ExternalLauncher.ts's own
  // `provideCommandResolutionServices` for the identical situation.
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const runUnityCommand = (
    args: ReadonlyArray<string>,
  ): Effect.Effect<UnityCliEnvelope | null, ProcessRunner.ProcessRunError> =>
    processRunner
      .run({
        command: UNITY_CLI_COMMAND,
        args: [...args, "--json"],
        timeout: COMMAND_TIMEOUT_SEC,
      })
      .pipe(Effect.map((output) => parseUnityCliEnvelope(output.stdout)));

  /** Runs one `unity command <name> --project-path <root> --json` call and
   * folds it into a `UnityPipelineResult`, WITHOUT parsing `data.result`
   * yet — callers that need a typed result (status) parse it themselves;
   * callers that only need pass/fail (the action commands, before their
   * own confirming status re-read) use this as-is. */
  const runEditorCommand = (
    action: "editor_play" | "editor_stop" | "editor_pause" | "editor_status",
    workspaceRoot: string,
  ): Effect.Effect<UnityPipelineResult<unknown>> =>
    runUnityCommand(["command", action, "--project-path", workspaceRoot]).pipe(
      Effect.map((envelope): UnityPipelineResult<unknown> => {
        if (envelope === null) {
          return {
            _tag: "error",
            message: `unparseable response from '${UNITY_CLI_COMMAND} command ${action}'`,
          };
        }
        if (envelope.success) {
          return { _tag: "ok", value: envelope.data?.result };
        }
        const message = envelope.errors[0]?.message ?? "unknown Pipeline error";
        if (isNotReadyMessage(message)) {
          return { _tag: "notReady" };
        }
        return { _tag: "error", message };
      }),
      Effect.catch(processRunErrorToResult<unknown>),
    );

  const status: UnityPipelineClient["Service"]["status"] = (workspaceRoot) =>
    runEditorCommand("editor_status", workspaceRoot).pipe(
      Effect.map((result): UnityPipelineResult<UnityEditorStatus> => {
        if (result._tag !== "ok") return result;
        const parsed = parseEditorStatusResult(result.value);
        return parsed === null
          ? { _tag: "error", message: "editor_status returned an unrecognised result shape" }
          : { _tag: "ok", value: parsed };
      }),
    );

  /** After an action command settles (success OR not — a `notReady` reply
   * to the ACTION itself, e.g. no Editor open at all, still means there is
   * no status to confirm), re-reads status with a bounded retry so the
   * caller gets back CONFIRMED state, not merely "the command was
   * accepted." See the module doc's domain-reload hazard note for why a
   * retry is needed here specifically, not everywhere. */
  const confirmWithStatus = (
    workspaceRoot: string,
    attemptsRemaining: number,
  ): Effect.Effect<UnityPipelineResult<UnityEditorStatus>> =>
    status(workspaceRoot).pipe(
      Effect.flatMap((result) => {
        if (result._tag !== "notReady" || attemptsRemaining <= 1) {
          return Effect.succeed(result);
        }
        return Effect.sleep(`${POST_ACTION_STATUS_RETRY_DELAY_MS} millis`).pipe(
          Effect.flatMap(() => confirmWithStatus(workspaceRoot, attemptsRemaining - 1)),
        );
      }),
    );

  const dispatchAndConfirm = (
    action: "editor_play" | "editor_stop" | "editor_pause",
    workspaceRoot: string,
  ): Effect.Effect<UnityPipelineResult<UnityEditorStatus>> =>
    runEditorCommand(action, workspaceRoot).pipe(
      Effect.flatMap((initial) => {
        // A `notReady`/`cliUnavailable`/`error` on the ACTION ITSELF (not
        // yet attempted, or the CLI rejected it outright) has nothing to
        // confirm — surface it as-is rather than spending the retry
        // budget on a status read that will fail for the exact same
        // reason.
        if (initial._tag !== "ok") return Effect.succeed(initial);
        return confirmWithStatus(workspaceRoot, POST_ACTION_STATUS_RETRY_ATTEMPTS);
      }),
    );

  return UnityPipelineClient.of({
    isAvailable: () =>
      isCommandAvailable(UNITY_CLI_COMMAND).pipe(
        Effect.orElseSucceed(() => false),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      ),
    status,
    play: (workspaceRoot) => dispatchAndConfirm("editor_play", workspaceRoot),
    stop: (workspaceRoot) => dispatchAndConfirm("editor_stop", workspaceRoot),
    pause: (workspaceRoot) => dispatchAndConfirm("editor_pause", workspaceRoot),
  });
});

export const layer = Layer.effect(UnityPipelineClient, make);
