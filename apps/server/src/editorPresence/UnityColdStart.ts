/**
 * Unity's cold-start play path — see docs/workbench/spec-unity-play-stop.md's
 * "Two paths, because Unity has a project lock" section (frozen, task #49).
 *
 * `Temp/UnityLockfile` under a Unity project's root exists exactly while an
 * Editor instance already has that project open — Unity's own mechanism,
 * not EPP's. A second Editor instance refuses to open the same project
 * while the lockfile is held. That single fact splits "make Unity play" in
 * half:
 *
 * - WARM: an Editor is already open (lockfile present) — `../unity/
 *   UnityPipelineClient.ts`'s `play`/`stop`/`pause`/`status`, which shell
 *   out to Unity's official `unity` CLI / `com.unity.pipeline` package.
 * - COLD: no Editor is open (lockfile absent) — launch one.
 *
 * REVISED BY OWNER DIRECTION (superseding this module's original design):
 * the cold launch is `unity open <projectRoot>` — the `unity` CLI's own
 * command, VERIFIED live (see `UnityColdStart.test.ts` and the session this
 * shipped in) to auto-detect the correct Editor version from the project's
 * own `ProjectVersion.txt` and return once the launch itself is confirmed
 * (not once the Editor finishes loading — a caller polls
 * `UnityPipelineClient.status` afterward for that, per that module's own
 * "No Pipeline instance found for project" -> `notReady` handling). This
 * REPLACES the original design of invoking the raw Unity Editor binary
 * directly with `-projectPath <path> -executeMethod <Class.Method>`, whose
 * target — `com.ironmind.editor-presence`'s
 * `EditorPresenceColdStartEntryPoint.EnterPlaymodeOnLaunch` — no longer
 * exists: that whole package was DELETED (see "Delete our Unity plugin —
 * Unity is served by com.unity.pipeline"). It was never installed in the
 * one project that matters (`~/Projects/Deepmind` carries
 * `com.unity.pipeline`, not ours) and never compiled, and Pipeline already
 * covers what it existed for. Unity is now the one engine of the three
 * (Godot, Unreal, Unity) with NO Editor Presence publisher — the WebSocket
 * path this comment previously described as "kept for NAT/remote" does not
 * exist for Unity anymore either. `docs/workbench/unity-integration-architecture.md`
 * records the study; task #68 tracks the one open gap that deletion left
 * (selection chips), which is not this module's concern.
 *
 * The cold path is launch-time ONLY — per the spec's own warning, it cannot
 * drive an Editor that is already running (the lockfile rejects the second
 * instance). This module's whole job is choosing correctly BY PROBING THE
 * LOCKFILE, never by remembering what was launched last — see the spec's
 * "Choose by probing the lockfile, not by remembering what we launched."
 *
 * SCOPE: this module builds the decision and the launch plan (argv) only —
 * it does not itself spawn a process. For roughly a day after task #49
 * shipped, `resolveUnityLaunchPlan`/`buildUnityColdStartArgs` had zero
 * callers anywhere in the codebase despite being tested and VERIFIED live
 * — found live by task #92's own cost analysis of the Unity setup flow's
 * "open Unity" not-ready states (S5/S6), which turned out to already have
 * a built, unwired fix rather than needing new engineering.
 *
 * `UnityPipelineClient.ts`'s `open` method is the first real caller: it
 * imports `buildUnityColdStartArgs` directly (this module stays the sole
 * source of truth for the argv) and spawns it via `ProcessRunner`
 * (`../processRunner.ts`) with `detached: true` — see that method's own
 * doc comment. `resolveUnityLaunchPlan`/`resolveUnityLaunchPlanForProject`'s
 * warm/cold BRANCHING decision is not what gates that caller, though —
 * `UnityColdStartRoute.ts` (this directory) uses `unity pipeline list
 * --json`'s live instance state for that instead (the same authoritative
 * signal `UnitySetupClassifier.ts` trusts, not this module's cheaper but
 * staleness-prone lockfile probe — a crashed Editor can leave
 * `Temp/UnityLockfile` behind with nothing actually running). This
 * module's exports remain available for a future caller that specifically
 * wants the cheap pre-flight lockfile check (e.g. the toolbar's own
 * Play/Stop dispatch, task #52, still unwired to either path as of this
 * writing) rather than paying for a `pipeline list` round trip up front.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/** Relative to a Unity project's root — present iff an Editor instance
 * already has that project open. See the module doc above. */
export const UNITY_LOCKFILE_RELATIVE_PATH = "Temp/UnityLockfile";

/** Same binary `UnityPipelineClient.ts` shells out to for the warm path —
 * kept as its own constant here (not imported from that module) so this
 * file has no dependency on it; both independently name the same `unity`
 * CLI on PATH. */
const UNITY_CLI_COMMAND = "unity";

export type UnityLaunchPlan =
  | { readonly kind: "warm" }
  | { readonly kind: "cold"; readonly args: ReadonlyArray<string> };

/**
 * Pure: the exact argv a cold launch would pass to spawn the `unity` CLI.
 * `args[0]` is the command itself (`"unity"`), matching how every other
 * spawn site in this repo builds an argv. Deliberately NO `-batchmode` /
 * `-quit` — the point of the cold path is a normal, VISIBLE Editor the user
 * can keep working in once Play is entered, not a headless job that runs
 * and exits. `--json` is included so a caller gets the same machine-
 * readable envelope `UnityPipelineClient.ts` parses elsewhere, rather than
 * the human-formatted default.
 *
 * VERIFIED live: `unity open <projectRoot>` takes the project path as a
 * POSITIONAL argument, not a `--project-path` flag — that flag is only
 * accepted by `unity command`/`unity pipeline`, not `unity open`, and
 * errors with "unknown option" if used here. `unity open` auto-detects and
 * launches the correct installed Editor version from the project's own
 * `ProjectVersion.txt`, so there is no separate Editor-path parameter to
 * thread through here at all (a real simplification over the previous
 * design, which needed the caller to know where the Editor binary lived).
 */
export function buildUnityColdStartArgs(projectRoot: string): ReadonlyArray<string> {
  return [UNITY_CLI_COMMAND, "open", projectRoot, "--json"];
}

/**
 * Pure: given whether the lockfile is present, decides warm vs cold. Kept
 * separate from `probeUnityLockfilePresent` below so the DECISION itself —
 * the spec's own test-bar bullet, "cold path chooses correctly when the
 * lockfile is present vs absent" — is testable with a plain boolean, no
 * Effect/FileSystem plumbing required.
 */
export function resolveUnityLaunchPlan(
  projectRoot: string,
  lockfilePresent: boolean,
): UnityLaunchPlan {
  if (lockfilePresent) return { kind: "warm" };
  return { kind: "cold", args: buildUnityColdStartArgs(projectRoot) };
}

/**
 * Probes whether `projectRoot` currently has an Editor instance holding it
 * open. Best-effort, mirroring `EngineTypeResolver.ts`'s own marker checks
 * and `ResourceMonitorBinary.ts`'s `fileSystem.exists(...).pipe(Effect.orElseSucceed(() => false))`
 * idiom: a missing file is "no lockfile" (cold), and any OTHER I/O failure
 * (permission denied, an unreadable `Temp` directory) degrades to the SAME
 * "cold" answer rather than failing the caller. That direction is
 * deliberate — a launch attempt that turns out to be unnecessary (an Editor
 * really was open) fails safely at the OS's own already-running-instance
 * refusal; a launch silently never offered because of a transient stat
 * error is the worse failure mode, since nothing distinguishes it from
 * "the user never asked."
 *
 * This is a zero-round-trip, purely local pre-flight check — cheaper than
 * asking `UnityPipelineClient.status` (a real subprocess spawn + a local
 * HTTP round trip to a possibly-nonexistent server) just to learn "is
 * anyone even listening." `UnityPipelineClient`'s own `notReady` outcome is
 * the authoritative live signal once a command is actually attempted; this
 * probe exists to decide WHETHER to attempt one before paying that cost.
 */
export const probeUnityLockfilePresent = (
  projectRoot: string,
): Effect.Effect<boolean, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const lockfilePath = path.join(projectRoot, UNITY_LOCKFILE_RELATIVE_PATH);
    return yield* fileSystem.exists(lockfilePath).pipe(Effect.orElseSucceed(() => false));
  });

/**
 * Combines the probe and the decision — the end-to-end "choose by probing
 * the lockfile" the spec asks for. Separate from `resolveUnityLaunchPlan`
 * so a caller that already knows presence (e.g. a test, or a future caller
 * that checks `UnityPipelineClient.status` first and only probes the
 * filesystem as a fallback) is not forced through a filesystem effect it
 * doesn't need.
 */
export const resolveUnityLaunchPlanForProject = (
  projectRoot: string,
): Effect.Effect<UnityLaunchPlan, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const lockfilePresent = yield* probeUnityLockfilePresent(projectRoot);
    return resolveUnityLaunchPlan(projectRoot, lockfilePresent);
  });
