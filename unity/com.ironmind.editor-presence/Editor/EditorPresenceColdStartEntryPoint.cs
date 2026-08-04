// The `-executeMethod` target for Unity's COLD-START play path — see
// docs/workbench/spec-unity-play-stop.md's "Two paths, because Unity has a
// project lock" section, and the server-side counterpart that builds this
// exact launch invocation, apps/server/src/editorPresence/UnityColdStart.ts
// (UNITY_COLD_START_EXECUTE_METHOD names this method's fully-qualified path
// verbatim — keep the two in sync if this class or method is ever renamed).
//
// Reachable ONLY via a command line of the shape:
//   <UnityEditor> -projectPath <path> -executeMethod
//     Ironmind.EditorPresence.EditorPresenceColdStartEntryPoint.EnterPlaymodeOnLaunch
// invoked from OUTSIDE an already-running Editor — the whole reason the
// cold path exists at all is that `Temp/UnityLockfile` blocks a second
// Editor instance from opening the SAME project, so nothing already running
// can service a cold-start request; only a freshly launched instance can.
//
// Deliberately NOT [InitializeOnLoad]: this must run only when Unity was
// launched specifically to run it (per `-executeMethod`'s own documented
// contract, which invokes the named static method once the project has
// finished loading), never on every ordinary Editor open — that would
// silently force every warm-path launch into Play Mode too, which is not
// what "cold start" means.
//
// No `using UnityEditor;` here deliberately: this file never references a
// UnityEditor-namespaced type directly (Dispatch's actual EditorApplication
// calls live in EditorPresencePlayModeController, same
// Ironmind.EditorPresence namespace, so no qualification is needed) — an
// unused using this package doesn't otherwise carry would be pure noise.

namespace Ironmind.EditorPresence
{
    internal static class EditorPresenceColdStartEntryPoint
    {
        /// Called by Unity itself, once, after the project has finished
        /// loading — see the module doc's `-executeMethod` contract.
        /// Delegates to EditorPresencePlayModeController.Dispatch("play")
        /// rather than calling EditorApplication.EnterPlaymode() a second,
        /// independent time, so a future change to what "play" means (e.g.
        /// the resume-from-paused behavior documented on Dispatch) only has
        /// one call site to stay correct at — a cold-launched process is
        /// never paused at this point, but there is no reason for this
        /// entry point to duplicate that logic rather than reuse it.
        public static void EnterPlaymodeOnLaunch()
        {
            EditorPresencePlayModeController.Dispatch("play");
        }
    }
}
