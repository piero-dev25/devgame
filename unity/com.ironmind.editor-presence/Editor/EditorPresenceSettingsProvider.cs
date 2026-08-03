// Preferences UI: "Preferences > T3 Editor Presence".
//
// One-time pairing per the resolved auth blocker: paste what `t3 pair`
// printed, click Pair, done. IMGUI (EditorGUILayout) rather than UI Toolkit
// for this window specifically, since a Preferences page is exactly the kind
// of infrequently-open, form-shaped UI IMGUI was built for, and it keeps
// this file simple to review without a UXML/USS side-file.
using UnityEditor;
using UnityEngine;

namespace Ironmind.EditorPresence
{
    internal static class EditorPresenceSettingsProvider
    {
        private static string _pastedInput = "";
        private static string _statusMessage = "";
        private static MessageType _statusMessageType = MessageType.None;
        private static bool _isPairing;

        [SettingsProvider]
        public static SettingsProvider CreateSettingsProvider()
        {
            return new SettingsProvider("Preferences/T3 Editor Presence", SettingsScope.User)
            {
                label = "T3 Editor Presence",
                guiHandler = _ => DrawGui(),
                keywords = new[] { "t3", "presence", "editor presence", "pairing", "epp" },
            };
        }

        private static void DrawGui()
        {
            EditorGUILayout.Space();
            EditorGUILayout.LabelField("Connection", EditorStyles.boldLabel);
            DrawConnectionStatusRow();
            EditorGUILayout.Space();

            EditorGUILayout.LabelField("Server", EditorStyles.boldLabel);
            EditorPresenceSettings.ServerUrl = EditorGUILayout.TextField(
                "Server URL",
                EditorPresenceSettings.ServerUrl);
            EditorGUILayout.HelpBox(
                "The T3 Code server's HTTP address, e.g. http://127.0.0.1:3777. "
                    + "Unity must run on the same machine as this server (see the spec's "
                    + "\"presence is bound to the server host\" risk).",
                MessageType.None);
            EditorGUILayout.Space();

            EditorGUILayout.LabelField("Pairing", EditorStyles.boldLabel);
            if (EditorPresenceSettings.HasBearerToken)
            {
                EditorGUILayout.HelpBox("Paired. A bearer session token is stored in EditorPrefs.", MessageType.Info);
                if (GUILayout.Button("Forget token", GUILayout.Width(140)))
                {
                    EditorPresenceSettings.ForgetToken();
                    _statusMessage = "Token forgotten. Run `t3 pair` again to reconnect.";
                    _statusMessageType = MessageType.None;
                }
            }
            else
            {
                EditorGUILayout.HelpBox(
                    "Not paired. On the machine running the T3 server, run `t3 pair`, then paste "
                        + "the printed token or pairing URL below.",
                    MessageType.Warning);
                _pastedInput = EditorGUILayout.TextField("Pairing token or URL", _pastedInput);
                using (new EditorGUI.DisabledScope(_isPairing || string.IsNullOrEmpty(_pastedInput)))
                {
                    if (GUILayout.Button(_isPairing ? "Pairing…" : "Pair", GUILayout.Width(140)))
                    {
                        _isPairing = true;
                        _statusMessage = "";
                        EditorPresenceSettings.RedeemPairingCredential(_pastedInput, (success, error) =>
                        {
                            _isPairing = false;
                            if (success)
                            {
                                _pastedInput = "";
                                _statusMessage = "Paired successfully.";
                                _statusMessageType = MessageType.Info;
                            }
                            else
                            {
                                _statusMessage = $"Pairing failed: {error}";
                                _statusMessageType = MessageType.Error;
                            }
                        });
                    }
                }
            }

            if (!string.IsNullOrEmpty(_statusMessage))
            {
                EditorGUILayout.Space();
                EditorGUILayout.HelpBox(_statusMessage, _statusMessageType);
            }
        }

        private static void DrawConnectionStatusRow()
        {
            var state = EditorPresenceConnection.State;
            var (label, messageType) = state switch
            {
                EditorPresenceConnectionState.Connected => ("Connected", MessageType.Info),
                EditorPresenceConnectionState.Connecting => ("Connecting…", MessageType.None),
                _ => ("Disconnected", MessageType.None),
            };
            EditorGUILayout.HelpBox($"Status: {label}", messageType);
        }
    }
}
