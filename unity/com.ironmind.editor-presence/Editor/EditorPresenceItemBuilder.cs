// Builds one EPP `selection.items[]` entry from a Unity Object.
//
// UNVERIFIED (owner should confirm this against a real project — see the
// package README / step-1 report): GlobalObjectId.GetGlobalObjectIdSlow has
// never been exercised anywhere in Deepmind's Assets or Packages per the
// frozen spec's grep, so its stability across nested prefabs and its cost on
// a real multi-select are both unmeasured here. This is intentionally the
// documented "slow" API, called at most MaxItems times per debounced
// selection change, not per frame.
using System.Collections.Generic;
using System.Text;
using UnityEditor;
using UnityEngine;

namespace Ironmind.EditorPresence
{
    internal static class EditorPresenceItemBuilder
    {
        // Placeholder used when an object's name is empty. `label` is the
        // ONLY field apps/server/src/editorPresence/protocol.ts's parseItem
        // requires to be non-empty — an item with a blank label is dropped
        // from the wire frame entirely. Unity permits an empty-string
        // GameObject/Object name (unlike Unreal's Outliner, which always
        // shows *something*), so without this fallback an unnamed object
        // silently vanishes from the chip set with no error anywhere. Found
        // during the cross-engine contract audit, not at original build
        // time — UNVERIFIED against a real Unity project; the C# side of
        // this repo cannot be compiled here (see UNVERIFIED.md).
        private const string UnnamedLabelFallback = "(unnamed)";

        public static SelectionItemDto Build(Object obj)
        {
            var rawName = obj != null ? obj.name : "";
            var dto = new SelectionItemDto
            {
                label = string.IsNullOrEmpty(rawName) ? UnnamedLabelFallback : rawName,
                kind = ResolveKind(obj),
                id = ResolveId(obj),
                path = ResolvePath(obj),
                detail = ResolveDetail(obj),
            };
            return dto;
        }

        private static string ResolveKind(Object obj)
        {
            if (obj is GameObject) return "gameobject";
            if (obj == null) return "unknown";
            // Open string per protocol — the client renders it, never
            // switches on it, so any lowercase slug is a legal value.
            return obj.GetType().Name.ToLowerInvariant();
        }

        private static string ResolveId(Object obj)
        {
            if (obj == null) return "";
            try
            {
                var globalId = GlobalObjectId.GetGlobalObjectIdSlow(obj);
                // identifierType 0 == kIDNull: an unsaved, never-serialized
                // object has no GUID-backed identity at all. Per the spec's
                // risk section, we carry "" (-> null on the wire) for it
                // rather than fabricating something durable-looking.
                return globalId.identifierType == 0 ? "" : globalId.ToString();
            }
            catch
            {
                return "";
            }
        }

        private static string ResolvePath(Object obj)
        {
            if (obj == null) return "";
            var path = AssetDatabase.GetAssetPath(obj);
            return string.IsNullOrEmpty(path) ? "" : path;
        }

        private static string ResolveDetail(Object obj)
        {
            if (obj is GameObject go) return BuildHierarchyPath(go);
            return "";
        }

        private static string BuildHierarchyPath(GameObject go)
        {
            var segments = new List<string>();
            var transform = go.transform;
            while (transform != null)
            {
                segments.Insert(0, transform.name);
                transform = transform.parent;
            }

            var sceneName = go.scene.IsValid() && !string.IsNullOrEmpty(go.scene.name)
                ? go.scene.name
                : "(unsaved scene)";

            var builder = new StringBuilder(sceneName);
            foreach (var segment in segments)
            {
                builder.Append(" / ").Append(segment);
            }
            return builder.ToString();
        }
    }
}
