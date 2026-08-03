// The EPP publisher WebSocket connection.
//
// UNVERIFIED (see the step-1 report and the frozen spec's own risk section):
// ClientWebSocket's async handshake/read/write behavior inside the Unity
// Editor's Mono/CoreCLR runtime and synchronization context has not been
// exercised here — I cannot open the Unity Editor in this environment. The
// shape below (async Task methods kicked off from an `async void` entry
// point, pumped by nothing special — Unity's Editor process runs a normal
// .NET thread pool, and Task continuations are dispatched onto it the same
// way they would be in any console app) is the standard, documented pattern;
// it is not confirmed against this specific project's Editor process.
//
// Reload handling: [InitializeOnLoad] static constructors re-run on every
// domain reload, which is what makes reconnect-after-reload work at all —
// the class is simply reconstructed and reconnects from scratch. The
// AssemblyReloadEvents hook below exists only to close the *old* socket
// before that happens, so the server sees a clean disconnect instead of a
// silently-abandoned TCP connection lingering until it times out.
using System;
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
        // Fixed retry interval, no backoff/jitter — that hardening is
        // explicitly step 5 ("Reconnect hardening against the reload
        // storm") in the frozen spec, not step 1.
        private const double ReconnectIntervalSeconds = 3.0;
        private const int ReceiveBufferSize = 4096;

        private static readonly string SessionId = Guid.NewGuid().ToString("N");

        private static ClientWebSocket _socket;
        private static CancellationTokenSource _cts;
        private static double _nextConnectAttemptAt;
        private static bool _connectInFlight;

        public static event Action<EditorPresenceConnectionState> StateChanged;

        public static EditorPresenceConnectionState State { get; private set; } =
            EditorPresenceConnectionState.Disconnected;

        static EditorPresenceConnection()
        {
            AssemblyReloadEvents.beforeAssemblyReload += HandleBeforeAssemblyReload;
            EditorApplication.quitting += HandleEditorQuitting;
            EditorApplication.update += HandleEditorUpdate;
        }

        private static void HandleEditorUpdate()
        {
            if (_connectInFlight) return;
            if (State != EditorPresenceConnectionState.Disconnected) return;
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

        // We never need to act on inbound frame content (Unity is a
        // publisher only — it doesn't render the `presence` fan-out), so
        // this just drains frames to detect a server-initiated close.
        private static async Task ReceiveUntilClosedAsync(CancellationToken cancellationToken)
        {
            var buffer = new byte[ReceiveBufferSize];
            while (_socket.State == WebSocketState.Open && !cancellationToken.IsCancellationRequested)
            {
                var result = await _socket.ReceiveAsync(new ArraySegment<byte>(buffer), cancellationToken);
                if (result.MessageType == WebSocketMessageType.Close)
                {
                    await _socket.CloseAsync(
                        WebSocketCloseStatus.NormalClosure,
                        "",
                        CancellationToken.None);
                    break;
                }
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
