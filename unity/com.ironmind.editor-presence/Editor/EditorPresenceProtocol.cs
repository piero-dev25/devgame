// Editor Presence Protocol (EPP) v1 — publisher-side wire DTOs.
//
// See docs/workbench/spec-editor-presence.md in the t3code repo for the full
// protocol. This plugin is a *publisher* only (Unity never subscribes to its
// own selection), so these types cover `hello` and `selection` outbound and
// nothing else — the `presence` fan-out frame is the web subscriber's
// concern, not this package's.
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
    }
}
