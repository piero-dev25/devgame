@tool
extends HBoxContainer
class_name EppIndicator

## Toolbar status indicator: a colored dot + label, built entirely in code
## (no .tscn, no icon assets) so the addon stays pure text files that zip
## and diff cleanly. Added to EditorPlugin.CONTAINER_TOOLBAR by plugin.gd.
##
## States mirror EppClient.State plus two indicator-only states
## (`no-token`, `unsupported`) that exist before a connection is ever
## attempted.

enum DisplayState { NO_TOKEN, CONNECTING, CONNECTED, DISCONNECTED, UNSUPPORTED }

const COLOR_NO_TOKEN := Color(0.55, 0.55, 0.55)
const COLOR_CONNECTING := Color(0.85, 0.70, 0.20)
const COLOR_CONNECTED := Color(0.30, 0.75, 0.35)
const COLOR_DISCONNECTED := Color(0.75, 0.30, 0.30)
const COLOR_UNSUPPORTED := Color(0.55, 0.55, 0.55)

var _dot: ColorRect
var _label: Label

signal retry_requested

func _init() -> void:
	_dot = ColorRect.new()
	_dot.custom_minimum_size = Vector2(8, 8)
	_dot.color = COLOR_NO_TOKEN

	_label = Label.new()
	_label.text = "T3 presence: no token"

	add_theme_constant_override("separation", 5)
	add_child(_dot)
	add_child(_label)

	mouse_filter = Control.MOUSE_FILTER_STOP
	gui_input.connect(_on_gui_input)

func set_state(state: DisplayState, detail: String = "") -> void:
	match state:
		DisplayState.NO_TOKEN:
			_dot.color = COLOR_NO_TOKEN
			_label.text = "T3 presence: no token"
		DisplayState.CONNECTING:
			_dot.color = COLOR_CONNECTING
			_label.text = "T3 presence: connecting…"
		DisplayState.CONNECTED:
			_dot.color = COLOR_CONNECTED
			_label.text = "T3 presence: connected"
		DisplayState.DISCONNECTED:
			_dot.color = COLOR_DISCONNECTED
			_label.text = "T3 presence: disconnected"
		DisplayState.UNSUPPORTED:
			_dot.color = COLOR_UNSUPPORTED
			_label.text = "T3 presence: unsupported Godot version"

	tooltip_text = _build_tooltip(state, detail)

func set_details(seq: int, item_count: int, session_id: String) -> void:
	_last_seq = seq
	_last_item_count = item_count
	_last_session_id = session_id

var _last_seq := 0
var _last_item_count := 0
var _last_session_id := ""

func _build_tooltip(state: DisplayState, detail: String) -> String:
	var lines := PackedStringArray()
	lines.append("T3 Editor Presence")
	if _last_session_id != "":
		lines.append("session: %s" % _last_session_id)
	lines.append("seq: %d, items: %d" % [_last_seq, _last_item_count])
	if detail != "":
		lines.append(detail)
	if state == DisplayState.DISCONNECTED:
		lines.append("Click to retry now.")
	return "\n".join(lines)

func _on_gui_input(event: InputEvent) -> void:
	if event is InputEventMouseButton and event.pressed and event.button_index == MOUSE_BUTTON_LEFT:
		retry_requested.emit()
