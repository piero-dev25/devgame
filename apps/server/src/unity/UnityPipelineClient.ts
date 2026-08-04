/**
 * Server-side client for Unity's OFFICIAL Pipeline CLI (`com.unity.pipeline`
 * + the `unity` CLI binary it ships alongside) — Play/Stop/Pause for Unity
 * shells out here, NOT through Editor Presence. See
 * docs/workbench/spec-unity-play-stop.md and its owner-directed pivot:
 * `com.unity.pipeline` is already installed in the owner's real project
 * (`~/Projects/Deepmind/Packages/manifest.json`), our own
 * `com.ironmind.editor-presence` package was not, and the `unity` CLI
 * proves a working play/stop round trip against a live Editor RIGHT NOW —
 * so it is the path that can produce a working Play button tonight, not a
 * socket protocol nothing had installed. `com.ironmind.editor-presence` has
 * since been DELETED entirely ("Delete our Unity plugin — Unity is served
 * by com.unity.pipeline") — never installed, never compiled, and made
 * redundant by Pipeline; see `docs/workbench/unity-integration-architecture.md`.
 * Unity is now the one engine of the three (Godot, Unreal, Unity) with no
 * Editor Presence publisher at all.
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
 * `editor_step` — Pipeline has no frame-step command at all, and (now that
 * `com.ironmind.editor-presence` is deleted) Unity has no scriptable
 * frame-step path through this codebase anymore, unlike the frozen spec's
 * original assumption. No generic "run any Pipeline command" passthrough —
 * that would be exactly the "general Unity command abstraction" scope
 * creep this task was told to avoid.
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
  /** `data`'s own shape is NOT common across subcommands — see the note
   * below. Left as `unknown`; each caller narrows it for the specific
   * subcommand it ran. */
  readonly data: unknown;
  readonly errors: ReadonlyArray<{ readonly code: string; readonly message: string }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Parses the outer `unity ... --json` envelope common to every subcommand
 * this module calls: `{ success, command, data, errors, warnings }`.
 * Returns `null` for anything that doesn't even look like the envelope
 * (unparseable JSON, or missing the fields every real response has) — the
 * caller treats that the same as a generic `error`, since a shape this far
 * off is not something to guess at.
 *
 * `data`'s OWN inner shape is deliberately NOT validated here — it used to
 * be (a hardcoded `{ result: unknown }` wrapper), which was correct for
 * `editor_status`/`editor_play`/`editor_stop`/`editor_pause` (verified live,
 * per this module's doc comment) but WRONG for `pipeline list`: a real
 * captured sample (2026-08-04, `Mafia Game`, a live Editor) has
 * `data: { instances, latestVersion, summary }` directly, with no nested
 * `result` key at all. Forcing that shape through the old `data.result`
 * check made every real `pipeline list` response fail to parse. Each caller
 * now pulls what it needs from `data` itself — `extractEnvelopeResult` for
 * the `{ result }`-shaped commands, `parsePipelineListResult` directly for
 * `pipeline list`. */
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
  return { success: parsed.success, data: parsed.data, errors: parsed.errors };
}

/** Pulls `data.result` for the subcommands verified to nest their payload
 * that way (`editor_status`/`editor_play`/`editor_stop`/`editor_pause`).
 * `undefined` when `data` isn't a record or has no `result` key at all —
 * distinct from a legitimate `null`/other value AT `result`, which passes
 * through unchanged for the caller's own parser to judge. */
function extractEnvelopeResult(data: unknown): unknown {
  return isRecord(data) && "result" in data ? data.result : undefined;
}

const UNITY_PLAY_MODES: ReadonlySet<string> = new Set<UnityPlayMode>([
  "stopped",
  "playing",
  "paused",
]);

/** One instance's worth of `unity pipeline list --json`'s own
 * `data.instances[]` entries. VERIFIED against a real captured sample
 * (2026-08-04, `Mafia Game`, a live Editor with no Pipeline package
 * installed — see docs/workbench/plan-setup-integration.md §1 and this
 * module's own doc comment): `isRunning` / `hasPipelinePackage` /
 * `pipelineServer.isReachable` / `pipelineVersion` / `updateAvailable` /
 * `safeMode`, plus `projectPath`/`pid` for matching and liveness. Two
 * corrections that sample made against the earlier, prose-reconstructed
 * version of this interface: `data` has no nested `result` wrapper for this
 * subcommand (see `parseUnityCliEnvelope`'s doc comment), and
 * `latestVersion` is NOT one of these per-instance fields — it lives
 * alongside `instances` in `data` itself (a CLI-wide fact, not an
 * instance-specific one), so it's returned separately by
 * `parsePipelineListResult` below rather than on this type.
 *
 * `parsePipelineListInstance` still fails safe on a shape mismatch — an
 * unrecognized entry is DROPPED, not silently coerced — but as of the real
 * E2E round trip against `Mafia Game` (2026-08-04, presence-authz), a
 * single bad entry among several no longer takes the whole list down with
 * it (see `parsePipelineListResult`'s doc comment). `pipeline list` is
 * machine-wide (no `--project-path` filter — see `list`'s own doc comment
 * below), so ANY other stray or malformed instance the CLI happens to
 * report — on any user's machine — used to be able to poison a probe for a
 * project that was itself perfectly healthy. One captured sample from one
 * CLI version is not a contract; a future field this module doesn't
 * recognize on ONE entry now costs that one entry, not the whole answer. */
export interface UnityPipelineListInstance {
  readonly projectPath: string;
  readonly pid: number | null;
  readonly isRunning: boolean;
  readonly hasPipelinePackage: boolean;
  readonly isReachable: boolean;
  readonly pipelineVersion: string | null;
  readonly updateAvailable: boolean | null;
  readonly safeMode: boolean | null;
}

/** `unity pipeline list --json`'s full parsed result: every instance PLUS
 * the CLI-wide `latestVersion` fact that sits alongside `instances` in
 * `data`, not inside any one instance. */
export interface UnityPipelineListResult {
  readonly instances: ReadonlyArray<UnityPipelineListInstance>;
  readonly latestVersion: string | null;
  /** How many entries of `data.instances` this parse DROPPED because they
   * didn't match `UnityPipelineListInstance`'s shape — 0 on the common
   * path. Exists so a dropped entry is a visible, honest fact
   * (`UnitySetupFacts.pipelineList` on the wire carries it too), never a
   * silent truncation: `instances.length` alone can't distinguish "the CLI
   * genuinely reported N instances" from "the CLI reported N+k and this
   * parser threw k of them away." See `parsePipelineListResult`'s doc
   * comment for why dropping (not failing the whole parse) is correct
   * here. */
  readonly unparseableInstanceCount: number;
}

/** `unity pipeline install --project-path <root> --json --non-interactive`'s
 * parsed `data`. VERIFIED against a real captured sample (2026-08-04,
 * presence-authz, plan §8-1's experiment — a disposable scratch project,
 * never `~/Projects/Mafia Game` or any other real project): `{ packageId,
 * version, projectPath, alreadyInstalled }`. `projectPath` is deliberately
 * NOT carried on this type — the caller already supplied it (it's the same
 * `workspaceRoot` this call was made with), same reasoning
 * `UnityPipelineListInstance` gives for not re-deriving already-known
 * facts. §8-1 ALSO settled (real numbers, not inference) that this command
 * succeeds with no Editor open at all, and that with no Editor open it
 * writes exactly one line to `manifest.json` and does NOT touch
 * `packages-lock.json` or download the package — resolution happens later,
 * asynchronously, whenever Unity's Editor next processes the manifest
 * change. See plan §3's consent-model section for why the client-side
 * consent copy promises the manifest line and nothing about the lockfile. */
export interface UnityPipelineInstallResult {
  readonly packageId: string;
  readonly version: string;
  readonly alreadyInstalled: boolean;
}

function isNullOr<A>(value: unknown, check: (value: unknown) => value is A): value is A | null {
  return value === null || check(value);
}
const isString = (value: unknown): value is string => typeof value === "string";
const isNumber = (value: unknown): value is number => typeof value === "number";
const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";

/** Parses one entry of `pipeline list`'s `instances` array. `null` on
 * anything that doesn't have every field this module reads — same
 * "don't guess" posture as `parseEditorStatusResult` above. Deliberately
 * does NOT read `latestVersion` — see `UnityPipelineListInstance`'s doc
 * comment for why that field isn't per-instance at all. */
function parsePipelineListInstance(entry: unknown): UnityPipelineListInstance | null {
  if (!isRecord(entry)) return null;
  const {
    projectPath,
    pid,
    isRunning,
    hasPipelinePackage,
    pipelineServer,
    pipelineVersion,
    updateAvailable,
    safeMode,
  } = entry;
  if (typeof projectPath !== "string") return null;
  if (!isNullOr(pid, isNumber)) return null;
  if (typeof isRunning !== "boolean") return null;
  if (typeof hasPipelinePackage !== "boolean") return null;
  if (!isRecord(pipelineServer) || typeof pipelineServer.isReachable !== "boolean") return null;
  if (!isNullOr(pipelineVersion, isString)) return null;
  if (!isNullOr(updateAvailable, isBoolean)) return null;
  if (!isNullOr(safeMode, isBoolean)) return null;
  return {
    projectPath,
    pid,
    isRunning,
    hasPipelinePackage,
    isReachable: pipelineServer.isReachable,
    pipelineVersion,
    updateAvailable,
    safeMode,
  };
}

/** Parses `pipeline list`'s `data` object as a whole: every entry of
 * `data.instances`, plus the CLI-wide `data.latestVersion` sitting
 * alongside it. `null` (not a value with an empty `instances` array) ONLY
 * when the ENVELOPE shape itself is unrecognized (`data` isn't a record,
 * `instances` isn't an array, or `latestVersion` is present with the wrong
 * type) — an EMPTY `instances` array is a real, valid answer ("no Editor
 * instances running anywhere"), distinct from "couldn't even parse the
 * response," which the caller treats as a CLI error (S12).
 *
 * ONE MALFORMED INSTANCE ENTRY no longer fails this whole parse — it is
 * DROPPED and counted in `unparseableInstanceCount` instead. Found live,
 * not hypothesized (2026-08-04, presence-authz, real E2E round trip against
 * `Mafia Game`): `pipeline list` has no `--project-path` filter (see
 * `list`'s doc comment below) and can report an entry for whatever
 * directory invoked the CLI, even when that directory isn't a Unity
 * project at all and the entry it reports is missing fields (observed:
 * `pid` absent, not `null`) — a machine-wide CLI quirk entirely outside
 * this codebase's control. Under the OLD all-or-nothing parse, that one
 * unrelated phantom entry took down the classification of a perfectly
 * healthy, perfectly well-formed Mafia Game entry sitting right next to it
 * in the same array — S12 instead of the correct S4. `pipeline list` is
 * explicitly documented as machine-wide/multi-instance (this module's own
 * `list` doc comment), so ANY stray or malformed instance on ANY user's
 * machine could trip the old behavior; this is the actual defect, not a
 * one-off. */
function parsePipelineListResult(data: unknown): UnityPipelineListResult | null {
  if (!isRecord(data) || !Array.isArray(data.instances)) return null;
  if (!isNullOr(data.latestVersion, isString)) return null;
  const instances: UnityPipelineListInstance[] = [];
  let unparseableInstanceCount = 0;
  for (const entry of data.instances) {
    const instance = parsePipelineListInstance(entry);
    if (instance === null) {
      unparseableInstanceCount += 1;
      continue;
    }
    instances.push(instance);
  }
  return { instances, latestVersion: data.latestVersion, unparseableInstanceCount };
}

/** Parses `pipeline install`'s `data` object. `null` on anything that
 * doesn't have every field this module reads — same "don't guess at an
 * unfamiliar shape" posture as every other parser in this module. */
function parsePipelineInstallResult(data: unknown): UnityPipelineInstallResult | null {
  if (!isRecord(data)) return null;
  const { packageId, version, alreadyInstalled } = data;
  if (typeof packageId !== "string") return null;
  if (typeof version !== "string") return null;
  if (typeof alreadyInstalled !== "boolean") return null;
  return { packageId, version, alreadyInstalled };
}

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
    /** `unity pipeline list --json` — every running Editor instance
     * Pipeline can currently see, regardless of project. Unlike
     * `status`/`play`/`stop`/`pause`, `pipeline list` has no
     * `--project-path` FILTER at all (confirmed against `unity pipeline
     * list --help` — see docs/workbench/plan-setup-integration.md §1's
     * F14) — matching a returned entry to "this project" is still the
     * CALLER's job (`UnitySetupProbe.ts`, via
     * `@t3tools/shared/workspaceRootPath`'s normalizer), not this client's.
     *
     * `workspaceRoot` IS still taken here, but for a different reason than
     * `--project-path`: it's the CWD this method spawns the `unity`
     * process from, not a CLI argument. Found live (2026-08-04,
     * presence-authz, real E2E round trip against `Mafia Game`): the
     * subprocess's OWN invocation directory affects what `pipeline list`
     * reports — invoked from this server process's own cwd (the repo
     * checkout, not any Unity project) rather than the project being
     * probed, the CLI injected a phantom self-referential instance entry
     * for that non-Unity directory. Pinning `cwd` to the project actually
     * being asked about is what "probe this project's setup" already
     * means, and it also happens to avoid that phantom entry — but even if
     * some future CLI version stops needing this, `parsePipelineListResult`
     * (UnityPipelineClient.ts) is now resilient to a stray/malformed peer
     * entry regardless, so this is belt-and-suspenders, not the only
     * fix. `notReady`/`cliUnavailable` are structurally impossible results
     * here (there is no "wrong project" or "not open" concept for a
     * command that lists every instance), but the return type stays
     * `UnityPipelineResult` for the same reason `status` does: a `cli
     * Unavailable`/`error` outcome IS still possible ( the binary vanished
     * between `isAvailable()` and this call, or the JSON envelope itself
     * doesn't parse), and folding those into a bespoke smaller type here
     * would just require the caller to re-derive the same handling this
     * module's every other method already gives it for free. */
    readonly list: (
      workspaceRoot: string,
    ) => Effect.Effect<UnityPipelineResult<UnityPipelineListResult>>;
    /** `unity pipeline install --project-path <workspaceRoot> --json
     * --non-interactive` — plan §5's increment 4a. Adds `com.unity.pipeline`
     * to `Packages/manifest.json`. §8-1's real experiment (2026-08-04)
     * settled that this works with no Editor running for the target
     * project, and that with no Editor open it writes only that one
     * manifest line — `packages-lock.json` and the actual package download
     * are NOT touched synchronously by this call; Unity's own resolver
     * updates those later, on its own schedule, once its Editor next
     * processes the manifest change. Same `UnityPipelineResult` wrapper as
     * every other method here, for the same reason `list` keeps it despite
     * `notReady` being an unlikely outcome for this specific subcommand —
     * one shape for the caller to handle everywhere. */
    readonly install: (
      workspaceRoot: string,
    ) => Effect.Effect<UnityPipelineResult<UnityPipelineInstallResult>>;
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
    cwd?: string,
  ): Effect.Effect<UnityCliEnvelope | null, ProcessRunner.ProcessRunError> =>
    processRunner
      .run({
        command: UNITY_CLI_COMMAND,
        args: [...args, "--json"],
        timeout: COMMAND_TIMEOUT_SEC,
        ...(cwd !== undefined ? { cwd } : {}),
      })
      .pipe(Effect.map((output) => parseUnityCliEnvelope(output.stdout)));

  /** Runs one `unity command <name> --project-path <root> --json` call and
   * folds it into a `UnityPipelineResult`, WITHOUT parsing the extracted
   * `data.result` yet — callers that need a typed result (status) parse it
   * themselves; callers that only need pass/fail (the action commands,
   * before their own confirming status re-read) use this as-is. */
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
          return { _tag: "ok", value: extractEnvelopeResult(envelope.data) };
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

  /** `unity pipeline list --json` — no `--project-path` (plan §1's F14:
   * the flag doesn't exist for this subcommand), so this is a bare
   * `runUnityCommand` call, not `runEditorCommand` (which always appends
   * one). `workspaceRoot` IS still passed through to `runUnityCommand` as
   * the subprocess `cwd` — see the `list` doc comment on the service
   * interface above for why (the CLI's own output is sensitive to
   * invocation directory, independent of the missing `--project-path`
   * flag). `notReady` is not a real outcome for this subcommand (there is
   * no single project to be "not ready" for), so a `notReady` envelope
   * reply — which should never happen in practice — folds into `error`
   * rather than silently reusing a tag whose meaning doesn't apply here. */
  const list: UnityPipelineClient["Service"]["list"] = (workspaceRoot) =>
    runUnityCommand(["pipeline", "list"], workspaceRoot).pipe(
      Effect.map((envelope): UnityPipelineResult<UnityPipelineListResult> => {
        if (envelope === null) {
          return { _tag: "error", message: "unparseable response from 'unity pipeline list'" };
        }
        if (!envelope.success) {
          const message = envelope.errors[0]?.message ?? "unknown Pipeline error";
          return { _tag: "error", message };
        }
        // No `.result` unwrap here, unlike `runEditorCommand` — `pipeline
        // list`'s `data` IS the result (`{ instances, latestVersion,
        // summary }` directly). See `parseUnityCliEnvelope`'s doc comment.
        const parsed = parsePipelineListResult(envelope.data);
        return parsed === null
          ? {
              _tag: "error",
              message: "'unity pipeline list' returned an unrecognised result shape",
            }
          : { _tag: "ok", value: parsed };
      }),
      Effect.catch(processRunErrorToResult<UnityPipelineListResult>),
      // Honesty check for `parsePipelineListResult`'s resilience above: a
      // dropped entry must never be silent, even when nothing downstream
      // ever reads `UnitySetupFacts.pipelineList.unparseableInstanceCount`
      // off the wire. Logged here, not just carried on the value, so it's
      // visible in server logs for callers/scripts that only look at the
      // classified state.
      Effect.tap((result) =>
        result._tag === "ok" && result.value.unparseableInstanceCount > 0
          ? Effect.logWarning("'unity pipeline list' dropped unparseable instance entries", {
              workspaceRoot,
              unparseableInstanceCount: result.value.unparseableInstanceCount,
              keptInstanceCount: result.value.instances.length,
            })
          : Effect.void,
      ),
    );

  /** `unity pipeline install --project-path <workspaceRoot> --json
   * --non-interactive` — plan §5's increment 4a. Unlike `list`, this DOES
   * take `--project-path` (confirmed against `unity pipeline install
   * --help`); `workspaceRoot` is passed through to `runUnityCommand` as
   * the subprocess `cwd` too, same defensive posture `list` uses, even
   * though `--project-path` already scopes the target explicitly here.
   * `--non-interactive` is passed explicitly (not left to the global flag
   * alone) so this call can never block the server process on a prompt it
   * has no terminal to answer. No `isNotReadyMessage` folding — that
   * pattern exists for editor-command dispatch (`runEditorCommand`), whose
   * "not ready" strings are specific to a live Editor connection; §8-1
   * settled that install doesn't need one at all, so a real failure here
   * (bad path, CLI error) is just an `error`, not a `notReady`. */
  const install: UnityPipelineClient["Service"]["install"] = (workspaceRoot) =>
    runUnityCommand(
      ["pipeline", "install", "--project-path", workspaceRoot, "--non-interactive"],
      workspaceRoot,
    ).pipe(
      Effect.map((envelope): UnityPipelineResult<UnityPipelineInstallResult> => {
        if (envelope === null) {
          return { _tag: "error", message: "unparseable response from 'unity pipeline install'" };
        }
        if (!envelope.success) {
          const message = envelope.errors[0]?.message ?? "unknown Pipeline error";
          return { _tag: "error", message };
        }
        // No `.result` unwrap here, same reason as `list` — `pipeline
        // install`'s `data` IS the result directly (verified live,
        // §8-1's own captured sample).
        const parsed = parsePipelineInstallResult(envelope.data);
        return parsed === null
          ? {
              _tag: "error",
              message: "'unity pipeline install' returned an unrecognised result shape",
            }
          : { _tag: "ok", value: parsed };
      }),
      Effect.catch(processRunErrorToResult<UnityPipelineInstallResult>),
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
    list,
    install,
  });
});

export const layer = Layer.effect(UnityPipelineClient, make);
