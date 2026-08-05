// The EPP publisher WebSocket connection. Selection-only: this plugin
// sends `hello` and `selection`, and never sends or receives anything else.
// It does not implement the `command` extension at all (see
// docs/workbench/spec-editor-presence-commands.md) — no `commandResult`,
// no `playState`, no inbound dispatch. com.unity.pipeline (Unity's official
// package) owns play/stop/pause/step/status; see unity/README.md for the
// split. This keeps the receive loop below intentionally dumb: it exists
// only to notice a server-initiated close, never to act on frame content.
//
// UNVERIFIED (see UNVERIFIED.md): ClientWebSocket's async handshake/read/
// write behavior inside the Unity Editor's Mono/CoreCLR runtime and
// synchronization context — the shape below (async Task methods kicked off
// from an `async void` entry point, pumped by nothing special — Unity's
// Editor process runs a normal .NET thread pool, and Task continuations are
// dispatched onto it the same way they would be in any console app) is the
// standard, documented pattern. UNVERIFIED.md records exactly what this
// pass did and did not exercise against a real Editor process.
//
// Reload handling: [InitializeOnLoad] static constructors re-run on every
// domain reload, which is what makes reconnect-after-reload work at all —
// the class is simply reconstructed and reconnects from scratch. The
// AssemblyReloadEvents hook below exists only to close the *old* socket
// before that happens, so the server sees a clean disconnect instead of a
// silently-abandoned TCP connection lingering until it times out.
//
// SESSION.ID PERSISTENCE: `SessionId` is backed by UnityEditor.SessionState,
// not a plain `static readonly` field initializer. The protocol's design
// (see docs/workbench/spec-editor-presence.md) explicitly wants session.id
// "stable per editor-process launch," so a reconnect after a domain reload
// replaces the stale server-side entry (last-writer-wins on session.id)
// instead of appearing as a second, briefly-duplicate publisher. A plain
// static field regenerates a fresh GUID on every domain reload — which
// fires on every script compile in this project (EditorSettings.asset) —
// so the OLD behavior minted a brand-new session.id after every single
// reload, producing a transient duplicate chip until the old TCP
// connection's abort was detected server-side. SessionState persists for
// the life of the Editor PROCESS (survives domain reload, resets on Editor
// restart), which is exactly the semantic wanted here. See
// EditorPresenceSelectionWatcher.cs for the paired `_sequence` persistence
// — session.id and seq must both survive reload together, or persisting
// one without the other trades this bug for a different one (a stale seq
// compared against the SAME still-registered session.id can make the
// registry's `seq <= existing.seq` guard silently drop every post-reload
// selection update until the counter catches up).
using System;
using System.IO;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using UnityEditor;
using UnityEngine;

namespace Ironmind.EditorPresence
{
    [InitializeOnLoad]
    internal static class EditorPresenceConnection
    {
        // Fixed retry interval, no backoff/jitter — matching the shape the
        // deleted package shipped with for this non-auth-rejection path;
        // hardening it (exponential backoff + jitter) is out of scope for
        // a selection-only plugin, same as it was flagged out of scope for
        // step 1 of the original design.
        private const double ReconnectIntervalSeconds = 3.0;
        private const int ReceiveBufferSize = 4096;
        private const string SessionIdSessionStateKey = "Ironmind.EditorPresence.SessionId";

        // A close code >= 4000 means the server told us why: the presence
        // route accepts the WebSocket upgrade FIRST, then authenticates,
        // and rejects by closing with an application close code plus a
        // human-readable reason — it never refuses with an HTTP-level
        // error. No close code at all (the connection never completed)
        // means "we never got far enough to be told anything."
        //
        // Only 4400 (missing credential) and 4401 (invalid credential) mean
        // "retrying with the SAME token cannot help" — named explicitly and
        // checked by IsCredentialRejection's membership test below, NOT a
        // numeric threshold. A close code like 4500 (server internal
        // error) is the server saying "my fault," transient by definition —
        // halting on it would let one momentary server fault permanently
        // disconnect every editor on every machine. This is the same named
        // set apps/server/src/editorPresence/protocol.ts's
        // EDITOR_PRESENCE_CLOSE_CODE defines and the Godot addon's
        // CREDENTIAL_CLOSE_CODES matches — do not re-flatten it into a
        // numeric threshold.
        private const int CloseCodeMissingCredential = 4400;
        private const int CloseCodeInvalidCredential = 4401;

        private static bool IsCredentialRejection(int closeCode) =>
            closeCode == CloseCodeMissingCredential || closeCode == CloseCodeInvalidCredential;

        private static readonly string SessionId = ResolveSessionId();

        private static ClientWebSocket _socket;
        private static CancellationTokenSource _cts;
        private static double _nextConnectAttemptAt;
        private static bool _connectInFlight;

        // Set when the server rejected our credential specifically — close
        // code 4400 (missing) or 4401 (invalid), per IsCredentialRejection.
        // NOT set for any other close code, including an unrecognized one
        // >= 4000 (e.g. 4500) — those keep retrying normally. HandleEditorUpdate
        // refuses to auto-retry while this is set — retrying with the SAME
        // rejected token cannot fix a credential problem, it can only
        // hammer the server and spam the Output Log every
        // ReconnectIntervalSeconds. Cleared by Retry() (wired to a "Retry
        // now" button — see EditorPresenceSettingsProvider.cs) or by a
        // successful re-pair
        // (EditorPresenceSettings.RedeemPairingCredential's caller clears
        // it — see that file).
        private static bool _credentialRejected;

        public static event Action<EditorPresenceConnectionState> StateChanged;

        public static EditorPresenceConnectionState State { get; private set; } =
            EditorPresenceConnectionState.Disconnected;

        // The human-readable reason for the current Disconnected state —
        // "" while Connected/Connecting, or after a clean shutdown with
        // nothing to report. Read alongside a StateChanged(Disconnected)
        // event (set BEFORE that event fires, so subscribers always see the
        // fresh value), or directly for the settings/overlay UI's own
        // polling redraw.
        public static string LastErrorMessage { get; private set; } = "";

        public static bool CredentialRejected => _credentialRejected;

        static EditorPresenceConnection()
        {
            AssemblyReloadEvents.beforeAssemblyReload += HandleBeforeAssemblyReload;
            EditorApplication.quitting += HandleEditorQuitting;
            EditorApplication.update += HandleEditorUpdate;
        }

        // Plain method (not a pattern-matching expression) deliberately —
        // reads the same regardless of the project's effective C#
        // LangVersion.
        private static string ResolveSessionId()
        {
            var existing = SessionState.GetString(SessionIdSessionStateKey, "");
            if (!string.IsNullOrEmpty(existing)) return existing;
            var id = Guid.NewGuid().ToString("N");
            SessionState.SetString(SessionIdSessionStateKey, id);
            return id;
        }

        /// Clears a credential-rejection halt and forces an immediate
        /// reconnect attempt, bypassing both the halt and the normal
        /// ReconnectIntervalSeconds wait. Called from a "Retry now" button
        /// (EditorPresenceSettingsProvider.cs) and automatically after a
        /// successful re-pair (EditorPresenceSettings.cs) — a fresh token
        /// makes a prior rejection stale, so re-pairing should not require
        /// a second, separate "now click retry" step.
        public static void Retry()
        {
            _credentialRejected = false;
            LastErrorMessage = "";
            _nextConnectAttemptAt = EditorApplication.timeSinceStartup;
        }

        private static void HandleEditorUpdate()
        {
            if (_connectInFlight) return;
            if (State != EditorPresenceConnectionState.Disconnected) return;
            EditorPresenceSettings.TryRedeemPairingHandoff();
            if (_credentialRejected) return;
            if (!EditorPresenceSettings.HasBearerToken) return;
            if (EditorApplication.timeSinceStartup < _nextConnectAttemptAt) return;

            _nextConnectAttemptAt = EditorApplication.timeSinceStartup + ReconnectIntervalSeconds;
            RunConnectAsync();
        }

        // async void is intentional and scoped to exactly this one entry
        // point: it is the only way to kick off async work from a
        // non-async callback (EditorApplication.update), and every await
        // below is inside a try/catch so an exception here can't become an
        // unobserved crash.
        private static async void RunConnectAsync()
        {
            _connectInFlight = true;
            try
            {
                await ConnectAndRunAsync();
            }
            catch (Exception e)
            {
                // ConnectAsync itself throwing (refused, DNS failure, no
                // response) means no WebSocket session was ever
                // established — the "cannot reach Workbench" case, not an
                // auth rejection (which can only happen AFTER the upgrade
                // succeeds — see ReceiveUntilClosedAsync). Only set
                // LastErrorMessage here if ReceiveUntilClosedAsync hasn't
                // already set a more specific one for this attempt.
                if (string.IsNullOrEmpty(LastErrorMessage))
                {
                    var url = EditorPresenceSettings.BuildPublisherWebSocketUrl();
                    LastErrorMessage = $"cannot reach Workbench at {url}";
                }
                Debug.LogWarning($"[T3 Editor Presence] connection attempt failed: {e.Message}");
            }
            finally
            {
                _connectInFlight = false;
                SetState(EditorPresenceConnectionState.Disconnected);
            }
        }

        private static async Task ConnectAndRunAsync()
        {
            var token = EditorPresenceSettings.BearerToken;
            if (string.IsNullOrEmpty(token)) return;

            LastErrorMessage = "";
            SetState(EditorPresenceConnectionState.Connecting);

            _cts = new CancellationTokenSource();
            _socket = new ClientWebSocket();
            _socket.Options.SetRequestHeader("Authorization", "Bearer " + token);

            var uri = new Uri(EditorPresenceSettings.BuildPublisherWebSocketUrl());
            await _socket.ConnectAsync(uri, _cts.Token);

            SetState(EditorPresenceConnectionState.Connected);
            await SendHelloAsync();

            await ReceiveUntilClosedAsync(_cts.Token);
        }

        private static async Task SendHelloAsync()
        {
            var hello = new HelloFrameDto
            {
                editor = new EditorIdentityDto
                {
                    id = EditorPresenceProtocol.EditorId,
                    name = EditorPresenceProtocol.EditorName,
                    version = Application.unityVersion,
                },
                session = new SessionIdentityDto { id = SessionId },
                workspace = new WorkspaceDto { root = ResolveWorkspaceRoot() },
                capabilities = EditorPresenceProtocol.Capabilities,
            };
            await SendJsonAsync(JsonUtility.ToJson(hello));
        }

        public static Task SendSelectionAsync(SelectionFrameDto frame)
        {
            return SendJsonAsync(JsonUtility.ToJson(frame));
        }

        private static async Task SendJsonAsync(string json)
        {
            var socket = _socket;
            var cts = _cts;
            if (socket == null || cts == null || socket.State != WebSocketState.Open) return;

            try
            {
                var bytes = Encoding.UTF8.GetBytes(json);
                await socket.SendAsync(
                    new ArraySegment<byte>(bytes),
                    WebSocketMessageType.Text,
                    true,
                    cts.Token);
            }
            catch (Exception e)
            {
                Debug.LogWarning($"[T3 Editor Presence] send failed: {e.Message}");
            }
        }

        // This plugin sends selection frames only and never expects
        // anything actionable back — there is no `command` frame to
        // dispatch (no capability is ever advertised — see
        // EditorPresenceProtocol.Capabilities). This loop's ONLY job is to
        // keep draining the socket so a server-initiated Close is actually
        // observed (a WebSocket close handshake requires the client to
        // keep reading); every non-Close frame's payload is read and
        // discarded, never parsed for content, structurally or otherwise —
        // there is nothing here that could repeat the Godot addon's old
        // substring-"pong"-match bug, because nothing here matches on
        // frame content at all.
        //
        // MULTI-FRAGMENT ACCUMULATION: a single logical WebSocket message
        // can arrive as more than one `ReceiveAsync` result
        // (`EndOfMessage == false` until the last fragment). Buffered into
        // a MemoryStream so a fragment boundary can't split a multi-byte
        // UTF-8 character, even though the decoded text is discarded right
        // after — this matters for the CLOSE case below, where the
        // close reason string genuinely is read.
        //
        // CLOSE-CODE DIAGNOSIS: `ClientWebSocket.CloseStatus` /
        // `CloseStatusDescription` are populated once a Close message has
        // been received, before the handshake finishes — read here, BEFORE
        // calling CloseAsync. `WebSocketCloseStatus` only has named members
        // for the standard 1000–1015 codes; a server-sent 4401 has no
        // matching name but casting `(int)closeStatus.Value` still recovers
        // the raw code — .NET enums are plain typed integers and are not
        // validated against their declared members at runtime. UNVERIFIED
        // against a real ClientWebSocket instance — see UNVERIFIED.md.
        private static async Task ReceiveUntilClosedAsync(CancellationToken cancellationToken)
        {
            var buffer = new byte[ReceiveBufferSize];
            while (_socket.State == WebSocketState.Open && !cancellationToken.IsCancellationRequested)
            {
                using (var messageStream = new MemoryStream())
                {
                    WebSocketReceiveResult result;
                    do
                    {
                        result = await _socket.ReceiveAsync(new ArraySegment<byte>(buffer), cancellationToken);
                        if (result.MessageType == WebSocketMessageType.Close)
                        {
                            var closeCode = _socket.CloseStatus.HasValue ? (int)_socket.CloseStatus.Value : -1;
                            var closeDescription = _socket.CloseStatusDescription ?? "";

                            await _socket.CloseAsync(
                                WebSocketCloseStatus.NormalClosure,
                                "",
                                CancellationToken.None);

                            HandleServerClose(closeCode, closeDescription);
                            return;
                        }
                        messageStream.Write(buffer, 0, result.Count);
                    } while (!result.EndOfMessage);

                    // Text and binary frames alike: read and discarded.
                    // This plugin has nothing inbound to act on.
                }
            }
        }

        private static void HandleServerClose(int closeCode, string closeDescription)
        {
            if (IsCredentialRejection(closeCode))
            {
                // 4400/4401 only — the server told us our credential
                // specifically is the problem. Surface it VERBATIM, and
                // stop auto-retrying with the same rejected token (see
                // HandleEditorUpdate's _credentialRejected check). Review
                // found that long-lived backend session expiry (task #113)
                // otherwise left a dead bearer permanently blocking the
                // automatic pairing handoff, so return to the unpaired state
                // before halting retries.
                LastErrorMessage = string.IsNullOrEmpty(closeDescription)
                    ? $"rejected (close code {closeCode})"
                    : closeDescription;
                EditorPresenceSettings.ForgetToken();
                _credentialRejected = true;
                Debug.LogWarning(
                    $"[T3 Editor Presence] credential rejected (close code {closeCode}): {LastErrorMessage}. " +
                    "Not retrying automatically — fix the token, then click Retry now.");
            }
            else if (closeCode >= 4000)
            {
                // The server told us why, but it is NOT a credential
                // problem (e.g. 4500 server internal error) — show the
                // reason verbatim same as above, but do NOT set
                // _credentialRejected: HandleEditorUpdate's normal fixed
                // interval keeps retrying, because an unrecognized server
                // fault is more likely to be transient than to be the
                // user's fault. Deliberately does not stop retrying just
                // because the code happens to be >= 4000.
                LastErrorMessage = string.IsNullOrEmpty(closeDescription)
                    ? $"rejected (close code {closeCode})"
                    : closeDescription;
                Debug.LogWarning(
                    $"[T3 Editor Presence] server closed with code {closeCode}: {LastErrorMessage}. " +
                    "Retrying automatically — this is not a credential problem.");
            }
            else
            {
                var url = EditorPresenceSettings.BuildPublisherWebSocketUrl();
                LastErrorMessage = closeCode == -1
                    ? $"cannot reach Workbench at {url}"
                    : $"connection closed (code {closeCode})";
            }
        }

        private static string ResolveWorkspaceRoot()
        {
            // Application.dataPath is ".../<Project>/Assets"; the workspace
            // root the protocol wants is the project root one level up.
            var dataPath = Application.dataPath.TrimEnd('/');
            var lastSlash = dataPath.LastIndexOf('/');
            return lastSlash > 0 ? dataPath.Substring(0, lastSlash) : dataPath;
        }

        private static void HandleBeforeAssemblyReload()
        {
            CloseImmediately();
        }

        private static void HandleEditorQuitting()
        {
            CloseImmediately();
        }

        private static void CloseImmediately()
        {
            try
            {
                _cts?.Cancel();
                _socket?.Abort();
                _socket?.Dispose();
            }
            catch (Exception e)
            {
                Debug.LogWarning($"[T3 Editor Presence] error closing connection: {e.Message}");
            }
            finally
            {
                _socket = null;
                _cts = null;
            }
        }

        private static void SetState(EditorPresenceConnectionState state)
        {
            if (State == state) return;
            State = state;
            Debug.Log($"[T3 Editor Presence] {state}");
            StateChanged?.Invoke(state);
        }
    }
}
