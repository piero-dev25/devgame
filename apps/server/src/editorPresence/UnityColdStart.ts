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
 * - WARM: an Editor is already open (lockfile present) — a `command` frame
 *   over the existing Editor Presence connection, exactly like every other
 *   engine. See `EditorPresenceRegistry.ts`'s `sendCommand` /
 *   `EditorPresenceRoute.ts`'s `dispatchEditorCommand`.
 * - COLD: no Editor is open (lockfile absent) — launch one with
 *   `-projectPath <path> -executeMethod <Class.Method>`, where the invoked
 *   method enters Play Mode once the project finishes loading. The Unity
 *   side of that entry point is
 *   `unity/com.ironmind.editor-presence/Editor/EditorPresenceColdStartEntryPoint.cs`
 *   (`EnterPlaymodeOnLaunch`).
 *
 * The cold path is launch-time ONLY — per the spec's own warning, it cannot
 * drive an Editor that is already running (the lockfile rejects the second
 * instance). This module's whole job is choosing correctly BY PROBING THE
 * LOCKFILE, never by remembering what was launched last — see the spec's
 * "Choose by probing the lockfile, not by remembering what we launched."
 *
 * SCOPE: this module builds the decision and the launch plan (argv) only —
 * it does not itself spawn a process. No caller wires either path to a real
 * process-spawn or an RPC/toolbar trigger yet, mirroring
 * `EditorPresenceRoute.ts`'s `dispatchEditorCommand`, which shipped in task
 * #47 with zero RPC callers for the identical reason ("build the capability,
 * the caller comes later"). A future caller (the toolbar's dispatch, task
 * #52, or a CLI command) composes `resolveUnityLaunchPlan` with its own
 * process-spawn mechanism.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/** Relative to a Unity project's root — present iff an Editor instance
 * already has that project open. See the module doc above. */
export const UNITY_LOCKFILE_RELATIVE_PATH = "Temp/UnityLockfile";

/** The Unity-side static method a cold-launched Editor calls once the
 * project has finished loading, via Unity's own `-executeMethod` contract —
 * see `EditorPresenceColdStartEntryPoint.cs`. Exported so a future caller
 * building the actual launch and this module's own tests share one source
 * of truth rather than two copies of the fully-qualified name drifting
 * apart. */
export const UNITY_COLD_START_EXECUTE_METHOD =
  "Ironmind.EditorPresence.EditorPresenceColdStartEntryPoint.EnterPlaymodeOnLaunch";

export type UnityLaunchPlan =
  | { readonly kind: "warm" }
  | { readonly kind: "cold"; readonly args: ReadonlyArray<string> };

/**
 * Pure: the exact argv a cold launch would pass to the Unity Editor binary.
 * Deliberately NO `-batchmode` / `-quit` — the point of the cold path is a
 * normal, VISIBLE Editor the user can keep working in once Play is entered,
 * not a headless job that runs the method and exits. `unityEditorPath` is
 * `argv[0]`, matching how every other spawn site in this repo builds an
 * argv (the executable is part of the array, not a separate parameter the
 * caller has to remember to prepend).
 */
export function buildUnityColdStartArgs(
  unityEditorPath: string,
  projectRoot: string,
): ReadonlyArray<string> {
  return [
    unityEditorPath,
    "-projectPath",
    projectRoot,
    "-executeMethod",
    UNITY_COLD_START_EXECUTE_METHOD,
  ];
}

/**
 * Pure: given whether the lockfile is present, decides warm vs cold. Kept
 * separate from `probeUnityLockfilePresent` below so the DECISION itself —
 * the spec's own test-bar bullet, "cold path chooses correctly when the
 * lockfile is present vs absent" — is testable with a plain boolean, no
 * Effect/FileSystem plumbing required.
 */
export function resolveUnityLaunchPlan(
  unityEditorPath: string,
  projectRoot: string,
  lockfilePresent: boolean,
): UnityLaunchPlan {
  if (lockfilePresent) return { kind: "warm" };
  return { kind: "cold", args: buildUnityColdStartArgs(unityEditorPath, projectRoot) };
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
 * so a caller that already knows presence (e.g. a test, or a future
 * `EditorPresenceRegistry`-aware caller that checks the WARM path's own
 * registry first and only probes the filesystem as a fallback) is not
 * forced through a filesystem effect it doesn't need.
 */
export const resolveUnityLaunchPlanForProject = (
  unityEditorPath: string,
  projectRoot: string,
): Effect.Effect<UnityLaunchPlan, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const lockfilePresent = yield* probeUnityLockfilePresent(projectRoot);
    return resolveUnityLaunchPlan(unityEditorPath, projectRoot, lockfilePresent);
  });
