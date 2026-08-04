// Owns the actual play-mode mutations (EnterPlaymode/ExitPlaymode/Step/
// pause) and the play-state TRUTH this plugin reports through presence —
// see docs/workbench/spec-unity-play-stop.md's ruling ("acceptance is an
// edge, play state is a level"). `EditorApplication.playModeStateChanged` /
// `pauseStateChanged` are the ONLY sources read here for CurrentPlayState;
// play state is NEVER inferred from having sent or accepted a command — a
// command that is accepted but silently fails to change anything (e.g.
// Unity refuses because it's mid-compile) is truthfully reported as
// "nothing changed" the next time presence goes out, not as a lie carried
// over from the command that requested it.
//
// MAIN THREAD ONLY: every EditorApplication.* call in this file must run on
// Unity's main thread. The only caller is
// EditorPresenceCommandDispatcher.HandleEditorUpdate, itself driven by
// EditorApplication.update — the SAME main-thread pump every other file in
// this package already uses (EditorPresenceConnection's reconnect timer,
// EditorPresenceSelectionWatcher's debounce), not a second one. Do not call
// Dispatch() from the background receive loop.
//
// [InitializeOnLoad]: this class is reconstructed on every domain reload —
// exactly like EditorPresenceConnection and EditorPresenceSelectionWatcher
// — which is WHY CurrentPlayState is computed fresh from
// EditorApplication.isPlaying/isPaused on every read rather than cached in
// a field: a cached value would not survive the very reload a play/stop
// command in this project routinely triggers (see the frozen spec's
// EditorSettings.asset measurement), and would report a stale answer for
// however long it took the field to catch back up.
using System;
using UnityEditor;

namespace Ironmind.EditorPresence
{
    [InitializeOnLoad]
    internal static class EditorPresencePlayModeController
    {
        /// Fired with the freshly computed CurrentPlayState whenever
        /// EditorApplication reports a play-mode or pause-state
        /// transition. The sole subscriber is
        /// EditorPresenceConnection.HandlePlayStateChanged, which forwards
        /// it over the wire — this file has no WebSocket/JSON knowledge of
        /// its own, matching how EditorPresenceSelectionWatcher stays pure
        /// selection-logic and lets EditorPresenceConnection own transport.
        public static event Action<string> PlayStateChanged;

        static EditorPresencePlayModeController()
        {
            EditorApplication.playModeStateChanged += HandlePlayModeStateChanged;
            EditorApplication.pauseStateChanged += HandlePauseStateChanged;
        }

        /// The truth source for what this publisher reports through
        /// presence — see the module doc above. Computed fresh on every
        /// read, never cached.
        public static string CurrentPlayState
        {
            get
            {
                if (!EditorApplication.isPlaying) return "stopped";
                return EditorApplication.isPaused ? "paused" : "playing";
            }
        }

        /// Dispatches ONE recognised action's actual Unity API call. MUST
        /// be called on the main thread — see the module doc. Returns
        /// false for an action this method doesn't recognise; in normal
        /// operation this is unreachable, because
        /// EditorPresenceCommandDispatcher already answered
        /// unsupported_action and never enqueues anything for an action
        /// that isn't one of the four below — the check here exists so
        /// this method can never silently do nothing without saying so,
        /// per the spec's "assert the effect" test-bar rule.
        ///
        /// DESIGN DECISION (not specified by the frozen spec, made here):
        /// the spec's capability table lists four discrete actions —
        /// play/stop/pause/step — with no separate "resume" verb. "play"
        /// therefore does double duty: entering Play Mode from Stopped, OR
        /// unpausing when already Playing-but-Paused. A "play" received
        /// while already playing and NOT paused is a no-op (matches
        /// Godot's plugin.gd: "play" while already playing does nothing).
        /// "pause" while not playing has nothing to pause and is also a
        /// no-op, not an error — the caller already replied ok:true;
        /// presence will simply keep reporting "stopped".
        public static bool Dispatch(string action)
        {
            switch (action)
            {
                case "play":
                    if (!EditorApplication.isPlaying)
                    {
                        EditorApplication.EnterPlaymode();
                    }
                    else if (EditorApplication.isPaused)
                    {
                        EditorApplication.isPaused = false;
                    }
                    return true;

                case "stop":
                    if (EditorApplication.isPlaying)
                    {
                        EditorApplication.ExitPlaymode();
                    }
                    return true;

                case "pause":
                    if (EditorApplication.isPlaying && !EditorApplication.isPaused)
                    {
                        EditorApplication.isPaused = true;
                    }
                    return true;

                case "step":
                    // EditorApplication.Step() is Unity's own no-op if the
                    // Editor isn't in a state that can step (see the
                    // frozen spec's "Unity API notes" — Unity is the only
                    // one of the three engines with a scriptable frame
                    // step at all). This call is unconditional; Unity
                    // itself owns the precondition.
                    EditorApplication.Step();
                    return true;

                default:
                    return false;
            }
        }

        private static void HandlePlayModeStateChanged(PlayModeStateChange change)
        {
            PlayStateChanged?.Invoke(CurrentPlayState);
        }

        private static void HandlePauseStateChanged(PauseState state)
        {
            PlayStateChanged?.Invoke(CurrentPlayState);
        }
    }
}
