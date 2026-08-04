// EditorPrefs-backed settings + the one-time pairing flow.
//
// Unity is just another bearer-paired client, exactly like T3's mobile app.
// This class redeems a pasted credential (or the full pairing URL — either
// is accepted, see ExtractCredential) via the server's existing OAuth
// token-exchange endpoint (POST {serverUrl}/oauth/token,
// grant_type=token-exchange — see packages/contracts/src/auth.ts
// AuthTokenExchangeRequest / packages/client-runtime/src/authorization/remote.ts
// bootstrapRemoteBearerSession, which this mirrors) for a long-lived bearer
// session token, stored in EditorPrefs. That token is then set as the
// `Authorization: Bearer` header on the EPP WebSocket handshake —
// ClientWebSocket can set that header where browser JS cannot, which is
// exactly why this bearer path exists for non-browser clients.
//
// The credential pasted here is NOT the code the server prints at its own
// startup (`issueStartupPairingUrl` — that one is `purpose: "startup"` and
// cannot be redeemed by a headless client, per
// docs/workbench/engine-credential-flow.md). It is a device pairing token
// minted from an ALREADY-PAIRED T3 app (Settings ▸ Connections ▸ Pairing
// links ▸ Create link, i.e. `POST /api/auth/pairing-token`, an
// authenticated request) — see EditorPresenceSettingsProvider.cs for the
// user-facing copy.
//
// EditorPrefs is per-machine, not per-project (Unity's own storage, shared
// across every project open with this Editor install) — acceptable here
// since the token authorizes a specific *server*, not a specific project;
// `workspace.root` in the `hello` frame is what tells the server which
// project this connection belongs to.
using System;
using System.Text.RegularExpressions;
using UnityEditor;
using UnityEngine;
using UnityEngine.Networking;

namespace Ironmind.EditorPresence
{
    internal static class EditorPresenceSettings
    {
        private const string ServerUrlKey = "Ironmind.EditorPresence.ServerUrl";
        private const string BearerTokenKey = "Ironmind.EditorPresence.BearerToken";
        private const string DefaultServerUrl = "http://127.0.0.1:3777";

        private static readonly Regex TokenFragmentPattern = new Regex(
            "token=([^&#\\s]+)",
            RegexOptions.Compiled);

        public static string ServerUrl
        {
            get => EditorPrefs.GetString(ServerUrlKey, DefaultServerUrl);
            set => EditorPrefs.SetString(ServerUrlKey, value);
        }

        public static string BearerToken
        {
            get => EditorPrefs.GetString(BearerTokenKey, "");
            set => EditorPrefs.SetString(BearerTokenKey, value);
        }

        public static bool HasBearerToken => !string.IsNullOrEmpty(BearerToken);

        public static void ForgetToken()
        {
            EditorPrefs.DeleteKey(BearerTokenKey);
        }

        /// Builds the EPP WebSocket URL from the configured HTTP server URL.
        public static string BuildPublisherWebSocketUrl()
        {
            var httpUrl = ServerUrl.TrimEnd('/');
            var wsUrl = httpUrl.StartsWith("https://", StringComparison.OrdinalIgnoreCase)
                ? "wss://" + httpUrl.Substring("https://".Length)
                : httpUrl.StartsWith("http://", StringComparison.OrdinalIgnoreCase)
                    ? "ws://" + httpUrl.Substring("http://".Length)
                    : "ws://" + httpUrl;
            return wsUrl + "/editor-presence?role=publisher";
        }

        /// Accepts either a bare pairing credential or a full pairing URL
        /// with the credential in a `#token=` fragment (a device pairing
        /// token minted from an already-paired T3 app — see this file's
        /// header comment; NOT the server's own startup pairing URL, which
        /// is a different, non-redeemable-here credential despite having
        /// the same `#token=` shape). Whichever form the user pastes,
        /// extract just the credential.
        internal static string ExtractCredential(string pastedInput)
        {
            if (string.IsNullOrEmpty(pastedInput)) return "";
            var trimmed = pastedInput.Trim();
            var match = TokenFragmentPattern.Match(trimmed);
            return match.Success ? Uri.UnescapeDataString(match.Groups[1].Value) : trimmed;
        }

        /// Redeems a pasted pairing credential for a long-lived bearer
        /// session token and stores it. Calls back on the main thread via
        /// UnityWebRequestAsyncOperation.completed, which Unity's own Editor
        /// update loop pumps regardless of Play/Edit mode — no coroutine
        /// host (e.g. an EditorWindow) is required.
        public static void RedeemPairingCredential(string pastedInput, Action<bool, string> onComplete)
        {
            var credential = ExtractCredential(pastedInput);
            if (string.IsNullOrEmpty(credential))
            {
                onComplete(false, "Could not find a pairing token in the pasted text.");
                return;
            }

            var form = new WWWForm();
            form.AddField("grant_type", "urn:ietf:params:oauth:grant-type:token-exchange");
            form.AddField("subject_token", credential);
            form.AddField("subject_token_type", "urn:t3:params:oauth:token-type:environment-bootstrap");
            form.AddField("requested_token_type", "urn:ietf:params:oauth:token-type:access_token");
            // docs/workbench/engine-credential-flow.md — "the body must
            // also carry scope and client_label; the real client sends
            // both." Matches AuthStandardClientScopes in
            // packages/contracts/src/auth.ts. `scope` is optional
            // server-side (an omitted scope silently falls back to the
            // pairing credential's own granted scopes), so this was not a
            // hard failure — but it leaves the actually-granted scope set
            // implicit rather than a stated fact of this specific request.
            form.AddField("scope", "orchestration:read orchestration:operate terminal:operate review:write relay:read");
            form.AddField("client_label", "Unity Editor");

            var url = ServerUrl.TrimEnd('/') + "/oauth/token";
            var request = UnityWebRequest.Post(url, form);
            var operation = request.SendWebRequest();
            operation.completed += _ =>
            {
                try
                {
                    if (request.result != UnityWebRequest.Result.Success)
                    {
                        onComplete(false, $"{request.error} (HTTP {request.responseCode})");
                        return;
                    }

                    TokenExchangeResponseDto response;
                    try
                    {
                        response = JsonUtility.FromJson<TokenExchangeResponseDto>(request.downloadHandler.text);
                    }
                    catch (Exception e)
                    {
                        onComplete(false, $"Could not parse the server's response: {e.Message}");
                        return;
                    }

                    if (response == null || string.IsNullOrEmpty(response.access_token))
                    {
                        onComplete(false, "Server response did not include an access token.");
                        return;
                    }

                    BearerToken = response.access_token;
                    // A fresh token makes any prior credential-rejection
                    // halt stale — clear it and kick an immediate reconnect
                    // attempt rather than requiring a separate manual
                    // "Retry now" click right after pairing succeeds.
                    EditorPresenceConnection.Retry();
                    onComplete(true, null);
                }
                finally
                {
                    request.Dispose();
                }
            };
        }

        [Serializable]
        private sealed class TokenExchangeResponseDto
        {
            public string access_token;
            public string issued_token_type;
            public string token_type;
            public double expires_in;
            public string scope;
        }
    }
}
