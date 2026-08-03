// Subscribes to UnityEditor.Selection.selectionChanged and publishes a
// debounced `selection` frame. 100ms debounce per the frozen spec's step-1
// bullet — selection-change cadence under Hierarchy drag-select is
// explicitly flagged as unmeasured there, so this errs toward the spec's
// stated number rather than guessing a different one.
using System.Collections.Generic;
using UnityEditor;

namespace Ironmind.EditorPresence
{
    [InitializeOnLoad]
    internal static class EditorPresenceSelectionWatcher
    {
        private const double DebounceSeconds = 0.1;

        private static bool _publishPending;
        private static double _pendingSinceTime;
        private static int _sequence;

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
            var items = new List<SelectionItemDto>(objects.Length);
            foreach (var obj in objects)
            {
                if (obj == null) continue;
                if (items.Count >= EditorPresenceProtocol.MaxItems) break;
                items.Add(EditorPresenceItemBuilder.Build(obj));
            }

            _sequence += 1;
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
