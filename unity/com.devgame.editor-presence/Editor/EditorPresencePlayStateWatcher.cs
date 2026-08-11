// Subscribes to UnityEditor.EditorApplication.playModeStateChanged AND
// pauseStateChanged and publishes a debounced `playState` frame — mirrors
// EditorPresenceSelectionWatcher.cs's structure exactly (dirty flag set in
// the event handler, no work done there; an EditorApplication.update pump
// checks the debounce and does the actual build+send). See
// unity-playstate-presence.md for the frozen design this implements.
//
// TWO EVENTS, ONE DIRTY FLAG: playModeStateChanged and pauseStateChanged are
// orthogonal — pausing fires no playModeStateChanged (Unity doesn't reload
// the domain to pause) and entering/exiting play mode fires no
// pauseStateChanged. Both handlers do the same thing (set the flag), so
// either one covers both classes of change with no per-event branching here.
//
// COMPUTED LIVE, NEVER INFERRED FROM WHICH ENUM VALUE FIRED: the actual
// frame content is read from EditorApplication.isPlaying/isPaused at
// PUBLISH time, in ComputeCurrentPlayState below — never from the
// PlayModeStateChange/PauseState value the triggering event carried. This
// matters because ConnectAndRunAsync (EditorPresenceConnection.cs) calls
// ComputeCurrentPlayState directly, with no event to read a value from at
// all, for the mandated post-hello send; a single shared computation is
// what keeps that call and this watcher's own debounced publish from ever
// disagreeing about the current state. Transitional phases
// (ExitingEditMode/ExitingPlayMode) need no special casing: entering or
// exiting play mode reloads the domain, which drops the socket outright —
// the reconnect that follows re-runs this class's static constructor from
// scratch and republishes the SETTLED state via ConnectAndRunAsync's own
// post-hello send, so a transitional value published here would only ever
// be overwritten a moment later regardless.
//
// NO SEQ, UNLIKE SELECTION: playState carries no `seq` field and this class
// has no SessionState-backed counter — EditorPresenceRegistry.ts's
// updatePublisherPlayState has nothing to compare against (a single
// WebSocket connection already orders frames via TCP), so there is no
// monotonic-guard hazard here the way EditorPresenceSelectionWatcher.cs's
// header comment describes for `_sequence`. The dirty flag and debounce
// timer below are plain, non-persisted static fields for exactly that
// reason — resetting them on every domain reload is correct, not a gap.
using UnityEditor;

namespace DevGame.EditorPresence
{
    [InitializeOnLoad]
    internal static class EditorPresencePlayStateWatcher
    {
        // Same 100ms debounce magnitude as EditorPresenceSelectionWatcher's
        // own DebounceSeconds — a private constant here too, not a shared
        // one, mirroring that class's structure of owning its own copy
        // rather than centralizing it (see this file's header: unlike
        // `_sequence`, nothing here needs cross-class state anyway).
        private const double DebounceSeconds = 0.1;

        private static bool _publishPending;
        private static double _pendingSinceTime;

        static EditorPresencePlayStateWatcher()
        {
            EditorApplication.playModeStateChanged += HandlePlayModeStateChanged;
            EditorApplication.pauseStateChanged += HandlePauseStateChanged;
            EditorApplication.update += HandleEditorUpdate;
        }

        private static void HandlePlayModeStateChanged(PlayModeStateChange change)
        {
            _publishPending = true;
            _pendingSinceTime = EditorApplication.timeSinceStartup;
        }

        private static void HandlePauseStateChanged(PauseState state)
        {
            _publishPending = true;
            _pendingSinceTime = EditorApplication.timeSinceStartup;
        }

        private static void HandleEditorUpdate()
        {
            if (!_publishPending) return;
            if (EditorApplication.timeSinceStartup - _pendingSinceTime < DebounceSeconds) return;

            _publishPending = false;
            PublishCurrentPlayState();
        }

        private static void PublishCurrentPlayState()
        {
            var frame = new PlayStateFrameDto { playState = ComputeCurrentPlayState() };
            _ = EditorPresenceConnection.SendPlayStateAsync(frame);
        }

        /// Reads EditorApplication's live state — never cached, never
        /// derived from an event argument. Shared by this watcher's own
        /// debounced publish above AND EditorPresenceConnection.cs's
        /// mandated post-hello send, which has no event to read a value
        /// from and calls this directly instead.
        internal static string ComputeCurrentPlayState()
        {
            return EditorApplication.isPlaying
                ? (EditorApplication.isPaused ? "paused" : "playing")
                : "stopped";
        }
    }
}
