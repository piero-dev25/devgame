// A small connected/connecting/disconnected status dot docked in the Scene
// view's overlay toolbar.
//
// Per the frozen spec's finding #3: domain reload fires on every script
// compile AND every Play press in this project, so the socket dies
// constantly — reconnect is the dominant runtime path, not an edge case,
// which is why a visible connection indicator is required in step 1 rather
// than deferred. EditorPresenceConnection.SetState also logs every
// transition to the Console as a zero-risk fallback in case this overlay
// doesn't render the way I expect — see the step-1 report for exactly why
// that hedge exists: UnityEditor.Overlays is the one file in this package I
// have the least confidence I got byte-perfect without being able to open
// the Editor and look at it.
using UnityEditor;
using UnityEditor.Overlays;
using UnityEngine;
using UnityEngine.UIElements;

namespace Ironmind.EditorPresence
{
    [Overlay(typeof(SceneView), OverlayId, "T3 Editor Presence")]
    internal sealed class EditorPresenceStatusOverlay : Overlay
    {
        private const string OverlayId = "com.ironmind.editor-presence.status";

        private VisualElement _dot;
        private Label _label;

        public override VisualElement CreatePanelContent()
        {
            var root = new VisualElement
            {
                style =
                {
                    flexDirection = FlexDirection.Row,
                    alignItems = Align.Center,
                    paddingLeft = 6,
                    paddingRight = 6,
                    paddingTop = 3,
                    paddingBottom = 3,
                },
            };

            _dot = new VisualElement
            {
                style =
                {
                    width = 8,
                    height = 8,
                    marginRight = 5,
                    borderTopLeftRadius = 4,
                    borderTopRightRadius = 4,
                    borderBottomLeftRadius = 4,
                    borderBottomRightRadius = 4,
                },
            };
            _label = new Label();

            ApplyState(EditorPresenceConnection.State);

            root.Add(_dot);
            root.Add(_label);

            EditorPresenceConnection.StateChanged += ApplyState;
            root.RegisterCallback<DetachFromPanelEvent>(_ =>
                EditorPresenceConnection.StateChanged -= ApplyState);

            return root;
        }

        private void ApplyState(EditorPresenceConnectionState state)
        {
            if (_dot == null || _label == null) return;
            // Credential-rejected is visually distinct from an ordinary
            // disconnect (same red dot, different label + tooltip) — see
            // EditorPresenceConnection.cs's module comment: retrying
            // automatically cannot fix a rejected credential, so this
            // state deliberately does not look like "still trying."
            if (EditorPresenceConnection.CredentialRejected)
            {
                _dot.style.backgroundColor = new StyleColor(ColorForState(EditorPresenceConnectionState.Disconnected));
                _label.text = "T3 presence: rejected";
                _label.tooltip = string.IsNullOrEmpty(EditorPresenceConnection.LastErrorMessage)
                    ? "Credential rejected. Not retrying automatically — see Preferences > T3 Editor Presence."
                    : $"Credential rejected: {EditorPresenceConnection.LastErrorMessage}";
                return;
            }

            _dot.style.backgroundColor = new StyleColor(ColorForState(state));
            _label.text = LabelForState(state);
            _label.tooltip = state == EditorPresenceConnectionState.Disconnected
                ? EditorPresenceConnection.LastErrorMessage
                : "";
        }

        private static Color ColorForState(EditorPresenceConnectionState state)
        {
            switch (state)
            {
                case EditorPresenceConnectionState.Connected:
                    return new Color(0.30f, 0.75f, 0.35f);
                case EditorPresenceConnectionState.Connecting:
                    return new Color(0.85f, 0.70f, 0.20f);
                default:
                    return new Color(0.60f, 0.25f, 0.25f);
            }
        }

        private static string LabelForState(EditorPresenceConnectionState state)
        {
            switch (state)
            {
                case EditorPresenceConnectionState.Connected:
                    return "T3 presence: connected";
                case EditorPresenceConnectionState.Connecting:
                    return "T3 presence: connecting…";
                default:
                    return "T3 presence: disconnected";
            }
        }
    }
}
