// Subscribes to UnityEditor.Selection.selectionChanged and publishes a
// debounced `selection` frame. 100ms debounce per the frozen spec's step-1
// bullet — selection-change cadence under Hierarchy drag-select is
// explicitly flagged as unmeasured there, so this errs toward the spec's
// stated number rather than guessing a different one.
//
// SEQ PERSISTENCE (added during the cross-engine contract audit): `_sequence`
// is backed by UnityEditor.SessionState, not a plain static field. A plain
// static int resets to 0 on every domain reload (script recompile, every
// Play press per the frozen spec's own finding that domain reload fires
// constantly in this project) while EditorPresenceConnection.SessionId
// — ALSO now SessionState-backed, see that file — stays the same across the
// reload. If seq resets to 1 while the server still holds a stale
// high-water-mark seq (say 50) for that unchanged session.id, the
// registry's `existing.selection.seq <= existing.selection.seq` guard
// (EditorPresenceRegistry.ts's updatePublisherSelection) silently drops
// every post-reload selection frame until the counter climbs back past the
// old value — a real, if eventually self-healing, "selection changes are
// ignored" bug. SessionState is a Unity Editor API that persists for the
// life of the Editor PROCESS (survives domain reload, resets on Editor
// restart) — exactly the "stable per editor-process launch" semantic both
// session.id and seq need. UNVERIFIED against a real Unity project (this
// repo's C# cannot be compiled here) but SessionState's reload-survival
// behavior for exactly this purpose is a standard, well-documented Editor
// pattern — see EditorPresenceConnection.cs for the paired session.id fix
// and UNVERIFIED.md for both.
using System.Collections.Generic;
using UnityEditor;

namespace Ironmind.EditorPresence
{
    [InitializeOnLoad]
    internal static class EditorPresenceSelectionWatcher
    {
        private const double DebounceSeconds = 0.1;
        private const string SequenceSessionStateKey = "Ironmind.EditorPresence.Sequence";

        private static bool _publishPending;
        private static double _pendingSinceTime;
        private static int _sequence = SessionState.GetInt(SequenceSessionStateKey, 0);

        static EditorPresenceSelectionWatcher()
        {
            Selection.selectionChanged += HandleSelectionChanged;
            EditorApplication.update += HandleEditorUpdate;
        }

        private static void HandleSelectionChanged()
        {
            _publishPending = true;
            _pendingSinceTime = EditorApplication.timeSinceStartup;
        }

        private static void HandleEditorUpdate()
        {
            if (!_publishPending) return;
            if (EditorApplication.timeSinceStartup - _pendingSinceTime < DebounceSeconds) return;

            _publishPending = false;
            PublishCurrentSelection();
        }

        private static void PublishCurrentSelection()
        {
            var objects = Selection.objects;
            var nonNullCount = 0;
            var items = new List<SelectionItemDto>(objects.Length);
            foreach (var obj in objects)
            {
                if (obj == null) continue;
                nonNullCount += 1;
                if (items.Count >= EditorPresenceProtocol.MaxItems) continue;
                items.Add(EditorPresenceItemBuilder.Build(obj));
            }

            // EPP v1 has no wire field to say "there were more than this"
            // (apps/server/src/editorPresence/protocol.ts caps items[] at
            // 64 server-side too, with the same silent-truncation
            // contract) — a local log is the only signal available, same
            // choice made on the Unreal side (epp/sampler.py's "truncated"
            // status event). Logged once per truncated publish, not once
            // per dropped item.
            if (nonNullCount > EditorPresenceProtocol.MaxItems)
            {
                UnityEngine.Debug.LogWarning(
                    $"[T3 Editor Presence] selection has {nonNullCount} items, more than the " +
                    $"{EditorPresenceProtocol.MaxItems}-item cap; publishing the first " +
                    $"{EditorPresenceProtocol.MaxItems} only.");
            }

            _sequence += 1;
            SessionState.SetInt(SequenceSessionStateKey, _sequence);
            var frame = new SelectionFrameDto
            {
                seq = _sequence,
                at = System.DateTime.UtcNow.ToString("o"),
                items = items.ToArray(),
            };

            _ = EditorPresenceConnection.SendSelectionAsync(frame);
        }
    }
}
