// Editor Presence Protocol (EPP) v1 — publisher-side wire DTOs.
//
// See docs/workbench/spec-editor-presence.md in the t3code repo for the full
// protocol. This plugin is a *publisher* only (Unity never subscribes to its
// own selection), and — unlike the deleted 1,633-line package this was
// mined from (git show 33d6cc4d8^:unity/com.ironmind.editor-presence/ —
// see unity/README.md for why it was deleted and why this thinner one
// exists) — it is selection-only. It covers `hello` / `selection` outbound
// only. No `command` frame is ever parsed, no `commandResult` or
// `playState` frame is ever sent, and no play/stop/pause/step capability is
// ever advertised: com.unity.pipeline (Unity's official package) owns all
// of that. The `presence` fan-out frame remains the web subscriber's
// concern, not this package's; Unity never receives one.
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
        /// Always EditorPresenceProtocol.Capabilities — an empty array, not
        /// null. See that field's own comment for why this plugin
        /// advertises nothing: com.unity.pipeline owns every command-shaped
        /// capability (play/stop/pause/step). Assigned explicitly (never
        /// left as this field's `null` default) for the same reason the
        /// original package always did — JsonUtility's serialization of a
        /// null array is not something worth relying on when the server
        /// side's contract for "no capabilities" is specifically an ABSENT
        /// or empty-array key, not a null one (see protocol.ts's
        /// parseCapabilities and DEFAULT_EDITOR_PRESENCE_CAPABILITIES).
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

    internal static class EditorPresenceProtocol
    {
        /// Defensive cap matching apps/server/src/editorPresence/protocol.ts
        /// (EDITOR_PRESENCE_MAX_ITEMS) — GetGlobalObjectIdSlow is named for
        /// its cost, so a huge drag-select shouldn't walk an unbounded set.
        public const int MaxItems = 64;

        public const string EditorId = "unity";
        public const string EditorName = "Unity Editor";

        /// Deliberately EMPTY. This plugin's one job is selection push;
        /// play/stop/pause/step/status/console/tests/screenshots all go
        /// through Unity's official com.unity.pipeline package instead (see
        /// unity/README.md for the split). Advertising a capability this
        /// plugin does not implement produces exactly the failure mode
        /// docs/workbench/spec-editor-presence-commands.md's capability
        /// table warns about: an enabled button in the toolbar (task #52)
        /// that times out, because nothing here ever answers a `command`
        /// frame — this plugin doesn't even parse one. Matches
        /// apps/server/src/editorPresence/protocol.ts's own
        /// DEFAULT_EDITOR_PRESENCE_CAPABILITIES, which is `[]` for exactly
        /// this reason: "a default that claims a capability is a lie
        /// whenever it's wrong; a default that claims none is merely
        /// conservative."
        public static readonly string[] Capabilities = new string[0];
    }
}
