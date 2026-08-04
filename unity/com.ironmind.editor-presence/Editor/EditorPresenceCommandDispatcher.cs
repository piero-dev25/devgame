// Dispatches inbound `command` frames — see
// docs/workbench/spec-editor-presence-commands.md (the protocol) and
// docs/workbench/spec-unity-play-stop.md (the Unity-specific hazard this
// file is built around).
//
// THE HAZARD THIS FILE ROUTES AROUND: EditorApplication.EnterPlaymode() /
// ExitPlaymode() trigger a domain reload in the Deepmind project (per the
// frozen spec's own measurement of its EditorSettings.asset), which
// destroys every managed object — INCLUDING THE WEBSOCKET — during the very
// call that's supposed to answer the command. So the RULING (frozen spec,
// "acceptance is an edge, play state is a level") is: send `commandResult`
// FIRST, from the background receive loop, over the still-alive socket,
// BEFORE any Unity API is touched. Only THEN is the actual mutation
// (EnterPlaymode/ExitPlaymode/Step/pause) queued for the next main-thread
// tick. By the time that tick runs — and possibly tears the whole process
// down via a domain reload — the reply has already left. What happens
// after is EditorPresencePlayModeController.cs's concern: play state is
// reported through presence, a LEVEL, never inferred from having sent a
// command.
//
// MAIN THREAD ONLY (for the ACTUAL Unity API calls, not for this file's own
// parsing/reply): `EditorPresenceConnection.ReceiveUntilClosedAsync` calls
// HandleInboundText below from a background thread-pool continuation, not
// Unity's main thread. HandleInboundText itself never calls a UnityEditor.*
// API — it only parses JSON and (at most) writes to the socket, both safe
// off the main thread. The actual mutation is queued into
// `_pendingActions` and drained by HandleEditorUpdate, which runs on
// EditorApplication.update — the SAME main-thread pump every other file in
// this package already subscribes to (EditorPresenceConnection's reconnect
// timer, EditorPresenceSelectionWatcher's debounce). This is deliberately
// NOT a second, different threading/polling mechanism — see the frozen
// spec's "Route through the plugin's existing main-thread pump... do not
// add a second one."
using System;
using System.Collections.Concurrent;
using UnityEditor;
using UnityEngine;

namespace Ironmind.EditorPresence
{
    [InitializeOnLoad]
    internal static class EditorPresenceCommandDispatcher
    {
        // Mirrors EditorPresenceProtocol.Capabilities exactly — this is the
        // ACCEPT decision, which has to happen (and reply) before any
        // EditorApplication call, so it is a membership check against a
        // known set rather than "try Dispatch and see what happens".
        private static readonly string[] SupportedActions = { "play", "stop", "pause", "step" };

        private static readonly ConcurrentQueue<string> _pendingActions = new ConcurrentQueue<string>();

        static EditorPresenceCommandDispatcher()
        {
            EditorApplication.update += HandleEditorUpdate;
        }

        /// Called from EditorPresenceConnection's background receive loop
        /// with one inbound text frame's raw JSON. Safe to call off the
        /// main thread — see the module doc above. Never throws: JSON
        /// parse failures and anything not shaped like a recognised
        /// `command` frame are logged/dropped, matching this package's
        /// existing "malformed or unrecognised inbound content never
        /// crashes the connection" posture (this plugin never had strict
        /// inbound validation for anything but its own outbound DTOs).
        public static void HandleInboundText(string json)
        {
            CommandFrameDto frame;
            try
            {
                frame = JsonUtility.FromJson<CommandFrameDto>(json);
            }
            catch (Exception e)
            {
                Debug.LogWarning($"[T3 Editor Presence] could not parse inbound frame: {e.Message}");
                return;
            }

            if (frame == null || frame.type != "command") return;

            // No id: nothing to correlate a reply against, so there is
            // nothing sensible to do with this frame — same defensive drop
            // as the Godot client's EppClient._handle_command_frame (see
            // that file's own comment on the identical case).
            if (string.IsNullOrEmpty(frame.id)) return;

            var action = frame.action ?? "";
            if (!IsSupportedAction(action))
            {
                // Never drop silently — spec's own rule: "a dropped
                // command is indistinguishable from a hung editor."
                _ = EditorPresenceConnection.SendCommandResultAsync(frame.id, false, "unsupported_action");
                return;
            }

            // ACCEPTED, not "done" — see the module doc's hazard section.
            // Sent BEFORE the mutation is even queued, let alone attempted,
            // while the socket that received this command is still (by
            // construction — we are inside its own receive loop) alive.
            _ = EditorPresenceConnection.SendCommandResultAsync(frame.id, true, "");
            _pendingActions.Enqueue(action);
        }

        private static bool IsSupportedAction(string action)
        {
            for (var i = 0; i < SupportedActions.Length; i++)
            {
                if (SupportedActions[i] == action) return true;
            }
            return false;
        }

        private static void HandleEditorUpdate()
        {
            // Drain everything queued since the last tick. Commands are
            // rare and human-triggered (a Play/Stop button press), so no
            // additional bound is applied here beyond
            // EditorPresenceRegistry.ts's own per-session rate limit,
            // which already caps how fast the server will forward them.
            while (_pendingActions.TryDequeue(out var action))
            {
                try
                {
                    EditorPresencePlayModeController.Dispatch(action);
                }
                catch (Exception e)
                {
                    // The commandResult for this action already went out
                    // as ok:true — per the module doc's ruling, there is
                    // no second reply to send. This can only surface as a
                    // log plus whatever CurrentPlayState presence reports
                    // next (i.e. "nothing changed" if the mutation truly
                    // failed).
                    Debug.LogWarning(
                        $"[T3 Editor Presence] command '{action}' failed after being accepted: {e.Message}");
                }
            }
        }
    }
}
