// Preferences UI: "Preferences > T3 Editor Presence".
//
// One-time pairing: paste a device pairing token minted from an
// already-paired T3 app, click Pair, done. IMGUI (EditorGUILayout) rather
// than UI Toolkit for this window specifically, since a Preferences page is
// exactly the kind of infrequently-open, form-shaped UI IMGUI was built
// for, and it keeps this file simple to review without a UXML/USS
// side-file.
//
// The help text below points at minting a device pairing token from an
// already-paired app — NOT the server's own startup pairing code, which
// cannot be redeemed by this plugin (see EditorPresenceSettings.cs's header
// comment and docs/workbench/engine-credential-flow.md).
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
                    _statusMessage = "Token forgotten. Mint a new device pairing token to reconnect (see below).";
                    _statusMessageType = MessageType.None;
                }
            }
            else
            {
                EditorGUILayout.HelpBox(
                    "Not paired. This is NOT the code the server prints at its own startup — that one "
                        + "cannot be redeemed here. From an already-paired T3 app: Settings > Connections > "
                        + "Pairing links > Create link. Paste what that gives you below.",
                    MessageType.Warning);
                _pastedInput = EditorGUILayout.TextField("Device pairing token or URL", _pastedInput);
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
            var lastError = EditorPresenceConnection.LastErrorMessage;

            // Auth rejection gets its own message + a Retry button instead
            // of the normal "Disconnected" row, so it's visually distinct
            // from "still trying, backing off" — retrying automatically
            // cannot fix a bad credential (see EditorPresenceConnection.cs).
            if (EditorPresenceConnection.CredentialRejected)
            {
                EditorGUILayout.HelpBox(
                    string.IsNullOrEmpty(lastError)
                        ? "Status: credential rejected. Not retrying automatically."
                        : $"Status: credential rejected — {lastError}",
                    MessageType.Error);
                if (GUILayout.Button("Retry now", GUILayout.Width(140)))
                {
                    EditorPresenceConnection.Retry();
                }
                return;
            }

            var (label, messageType) = state switch
            {
                EditorPresenceConnectionState.Connected => ("Connected", MessageType.Info),
                EditorPresenceConnectionState.Connecting => ("Connecting…", MessageType.None),
                _ => ("Disconnected", MessageType.None),
            };
            var statusText = state == EditorPresenceConnectionState.Disconnected && !string.IsNullOrEmpty(lastError)
                ? $"Status: {label} — {lastError}"
                : $"Status: {label}";
            EditorGUILayout.HelpBox(statusText, messageType);
        }
    }
}
