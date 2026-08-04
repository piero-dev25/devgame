// Editor Presence Protocol (EPP) v1 — publisher-side wire DTOs.
//
// See docs/workbench/spec-editor-presence.md in the t3code repo for the full
// protocol. This plugin is a *publisher* only (Unity never subscribes to its
// own selection), so these types cover `hello` / `selection` outbound, and —
// as of task #49 (docs/workbench/spec-unity-play-stop.md) — the command
// extension's `command` inbound plus `commandResult` / `playState` outbound.
// The `presence` fan-out frame remains the web subscriber's concern, not
// this package's; Unity never receives one.
//
// Serialized with UnityEngine.JsonUtility (built-in, no external dependency).
// JsonUtility's handling of a `null` string field is not something we can
// verify without running this in the Editor, so every optional field below
// is deliberately set to "" rather than left null when absent — the server
// parser (apps/server/src/editorPresence/protocol.ts) already treats an
// empty string identically to a missing/null field for exactly this reason.
using System;

namespace Ironmind.EditorPresence
{
    [Serializable]
    internal sealed class EditorIdentityDto
    {
        public string id;
        public string name;
        public string version;
    }

    [Serializable]
    internal sealed class SessionIdentityDto
    {
        public string id;
    }

    [Serializable]
    internal sealed class WorkspaceDto
    {
        public string root;
    }

    [Serializable]
    internal sealed class SelectionItemDto
    {
        /// Opaque durable id (GlobalObjectId.ToString()), or "" when the
        /// selected object has no durable identity (e.g. an unsaved,
        /// never-serialized scene GameObject — GlobalObjectId's
        /// identifierType is 0/Null for those).
        public string id = "";
        public string kind = "unknown";
        public string label = "";
        /// Workspace-relative asset path, or "" for a scene object.
        public string path = "";
        /// Short secondary line (hierarchy path), or "".
        public string detail = "";
    }

    [Serializable]
    internal sealed class HelloFrameDto
    {
        public int v = 1;
        public string type = "hello";
        public EditorIdentityDto editor;
        public SessionIdentityDto session;
        public WorkspaceDto workspace;
        /// Task #49: what this build can actually honour, so the toolbar
        /// (task #52) never offers a control this plugin cannot honour —
        /// see EditorPresenceProtocol.Capabilities and
        /// docs/workbench/spec-editor-presence-commands.md's "Capability
        /// advertisement". Always assigned explicitly in
        /// EditorPresenceConnection.SendHelloAsync (never left as this
        /// field's `null` default) — JsonUtility's serialization of a null
        /// array is not something worth relying on when the server-side
        /// contract for "no capabilities" is specifically an ABSENT key,
        /// not a null one (see protocol.ts's parseCapabilities).
        public string[] capabilities;
    }

    [Serializable]
    internal sealed class SelectionFrameDto
    {
        public int v = 1;
        public string type = "selection";
        public int seq;
        public string at;
        public SelectionItemDto[] items;
    }

    /// Server -> engine `command` frame, inbound side — see
    /// docs/workbench/spec-editor-presence-commands.md's "Wire shape".
    /// `params` is deliberately NOT a field here: none of the four actions
    /// this build implements (play/stop/pause/step) read it, and
    /// JsonUtility has no Dictionary support, so a `params` object in the
    /// incoming JSON is simply left unbound — JsonUtility silently ignores
    /// JSON keys with no matching C# field, which is exactly the "drop
    /// what we don't understand, don't crash the frame" behavior the
    /// server side's own parser already documents for itself.
    [Serializable]
    internal sealed class CommandFrameDto
    {
        public int v;
        public string type;
        public string id;
        public string at;
        public string action;
    }

    /// Engine -> server reply to ONE command — see the spec's "Wire shape".
    /// `error` is always serialized (JsonUtility cannot omit a field
    /// conditionally), including as `""` on an `ok:true` reply; the server
    /// parser (protocol.ts's parseCommandResult) only reads `error` when
    /// `ok === false`, so the extra empty key on success is inert.
    [Serializable]
    internal sealed class CommandResultFrameDto
    {
        public int v = 1;
        public string type = "commandResult";
        public string id;
        public bool ok;
        public string error = "";
    }

    /// Engine's own report of its play/pause state — see
    /// docs/workbench/spec-unity-play-stop.md's ruling ("acceptance is an
    /// edge, play state is a level"). `playState` is one of "stopped" /
    /// "playing" / "paused" — see EditorPresencePlayModeController's
    /// CurrentPlayState, the sole place this string is computed.
    [Serializable]
    internal sealed class PlayStateFrameDto
    {
        public int v = 1;
        public string type = "playState";
        public string playState;
    }

    internal static class EditorPresenceProtocol
    {
        /// Defensive cap matching apps/server/src/editorPresence/protocol.ts
        /// (EDITOR_PRESENCE_MAX_ITEMS) — GetGlobalObjectIdSlow is named for
        /// its cost, so a huge drag-select shouldn't walk an unbounded set.
        public const int MaxItems = 64;

        public const string EditorId = "unity";
        public const string EditorName = "Unity Editor";

        /// Task #49: on completion, Unity advertises exactly these four —
        /// see the frozen spec's "Capabilities" section and its capability
        /// table ("Frame-step is Unity-only through supported APIs" — the
        /// one entry that differs from Godot's `["play","stop"]`). Advertise
        /// only what EditorPresenceCommandDispatcher/EditorPresencePlayModeController
        /// actually implement — a capability claimed but not honoured is
        /// exactly the enabled-button-then-timeout experience the
        /// capability table exists to prevent.
        public static readonly string[] Capabilities = { "play", "stop", "pause", "step" };
    }
}
