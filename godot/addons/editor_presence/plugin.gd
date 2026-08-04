@tool
extends EditorPlugin

## Lifecycle + wiring only — frame content lives in EppSelection (pure),
## transport lives in EppClient. This file's job is connecting Godot's
## editor signals to those two, plus the toolbar indicator.
##
## Uses `const X = preload(...)` rather than the global class_name types
## directly: bare global-class references only resolve once the project's
## global script class cache has been built by an editor/project scan, and
## this addon's own compile-check (run via `godot --headless --script`,
## with no such scan) proved that by failing on every bare reference —
## the preload form works in both contexts. `_client`/`_indicator` are
## left untyped for the same reason: a `var _client: EppClient` typed
## against the bare global name hit the identical resolution failure.
##
## UNVERIFIED (cannot open the Godot editor in this environment — see
## godot/addons/editor_presence/README.md): whether EditorPlugin._process
## ticks with no game running and the editor window backgrounded, whether
## EditorSelection.selection_changed actually fires, and what
## get_selected_nodes() contains. The probe in
## docs/workbench/godot-probe-findings.md confirmed WebSocketPeer,
## handshake headers, and the close-code behavior against a real server —
## but that ran as a plain SceneTree script, which exercises none of the
## EditorPlugin-specific API this file depends on. If `_process` does not
## tick in the idle editor, the documented fallback (spec-godot-publisher.md
## step 0(a)) is a Timer child with PROCESS_MODE_ALWAYS in place of
## set_process(true) below — everything downstream is identical either way.
##
## COMMANDS (task #48): this is the ONLY file with EditorInterface access,
## so it is the only file that dispatches a `command` — EppClient parses
## the frame and emits `command_received`, this file's `_on_command_received`
## calls `EditorInterface.play_main_scene()` / `stop_playing_scene()` and
## replies via `_client.send_command_result()`. `is_playing_scene()` is used
## ONLY to avoid a redundant re-launch of an already-running scene — it is
## NOT used to distinguish "stopped" from "paused", because it does not:
## `is_playing_scene()` stays true while the running session is merely
## paused via the editor's own debugger pause, so a false return means
## "truly stopped" but a true return does not mean "definitely unpaused."
## This addon does not implement pause/step at all (Godot has no scriptable
## frame-step, and pause is out of this task's scope), so that distinction
## does not need resolving here — noted so a future pause implementation
## does not reach for this same boolean and get it wrong.

const EppClientScript = preload("res://addons/editor_presence/epp_client.gd")
const EppSelectionScript = preload("res://addons/editor_presence/epp_selection.gd")
const EppSettingsScript = preload("res://addons/editor_presence/epp_settings.gd")
const EppIndicatorScript = preload("res://addons/editor_presence/epp_indicator.gd")

# Godot 4 is a hard floor: WebSocketPeer.handshake_headers and
# ResourceLoader.get_resource_uid are both used unconditionally and are
# only confirmed present on 4.7 (docs/workbench/godot-probe-findings.md).
# Below this, refuse cleanly rather than let the poll loop hit runtime
# errors on missing API.
const MIN_ENGINE_MAJOR := 4

const SELECTION_DEBOUNCE_SEC := 0.1
const FILESYSTEM_POLL_SEC := 0.25

var _client
var _indicator
var _selection_dirty := false
var _selection_deadline_sec := 0.0
var _next_fs_poll_sec := 0.0
var _last_fs_paths := PackedStringArray()
var _editor_settings: EditorSettings
var _supported := true

func _enter_tree() -> void:
	_editor_settings = EditorInterface.get_editor_settings()
	EppSettingsScript.register_defaults(_editor_settings)

	_indicator = EppIndicatorScript.new()
	add_control_to_container(EditorPlugin.CONTAINER_TOOLBAR, _indicator)
	_indicator.retry_requested.connect(_on_retry_requested)

	var version_info := Engine.get_version_info()
	var major: int = version_info.get("major", 0)
	if major < MIN_ENGINE_MAJOR:
		_supported = false
		_indicator.set_state(EppIndicatorScript.DisplayState.UNSUPPORTED)
		push_warning("[T3 Editor Presence] unsupported Godot version (%s) — need >= %d" % [
			str(version_info.get("string", "unknown")), MIN_ENGINE_MAJOR,
		])
		return

	_client = EppClientScript.new()
	var version_string: String = version_info.get("string", "unknown")
	_client.configure(
		EppSettingsScript.get_url(_editor_settings),
		EppSettingsScript.get_token(_editor_settings),
		version_string,
	)
	_client.state_changed.connect(_on_client_state_changed)
	_client.command_received.connect(_on_command_received)

	EditorInterface.get_selection().selection_changed.connect(_on_selection_dirty)
	scene_changed.connect(_on_scene_changed)
	if _editor_settings.has_signal("settings_changed"):
		_editor_settings.settings_changed.connect(_on_editor_settings_changed)

	var enabled_now: bool = EppSettingsScript.get_enabled(_editor_settings)
	var token_now: String = EppSettingsScript.get_token(_editor_settings)
	if enabled_now and token_now != "":
		set_process(true)
		_mark_selection_dirty()
	else:
		_indicator.set_state(EppIndicatorScript.DisplayState.NO_TOKEN)

func _exit_tree() -> void:
	set_process(false)
	if _client != null:
		_client.force_reconnect_now()  # drops any live socket via a fresh state
		_client = null
	if _indicator != null:
		remove_control_from_container(EditorPlugin.CONTAINER_TOOLBAR, _indicator)
		_indicator.queue_free()
		_indicator = null
	if EditorInterface.get_selection().selection_changed.is_connected(_on_selection_dirty):
		EditorInterface.get_selection().selection_changed.disconnect(_on_selection_dirty)
	if scene_changed.is_connected(_on_scene_changed):
		scene_changed.disconnect(_on_scene_changed)
	if _editor_settings != null and _editor_settings.settings_changed.is_connected(_on_editor_settings_changed):
		_editor_settings.settings_changed.disconnect(_on_editor_settings_changed)

func _process(_delta: float) -> void:
	if not _supported or _client == null:
		return

	var now_sec: float = Time.get_ticks_msec() / 1000.0

	var include_fs: bool = EppSettingsScript.get_include_filesystem(_editor_settings)
	if include_fs and now_sec >= _next_fs_poll_sec:
		_next_fs_poll_sec = now_sec + FILESYSTEM_POLL_SEC
		var current_paths := EditorInterface.get_selected_paths()
		if current_paths != _last_fs_paths:
			_last_fs_paths = current_paths
			_mark_selection_dirty()

	var should_connect: bool = _client.should_attempt_connect(now_sec)
	if should_connect:
		_client.connect_now()

	var just_opened: bool = _client.poll(now_sec)
	if just_opened:
		_send_current_selection()
	elif _selection_dirty and now_sec >= _selection_deadline_sec:
		_selection_dirty = false
		_send_current_selection()

func _on_selection_dirty() -> void:
	_mark_selection_dirty()

func _on_scene_changed(_scene_root: Node) -> void:
	# Switching scene tabs changes the anchor root, so every item's id and
	# path change even if selection_changed does not fire for a tab switch.
	_mark_selection_dirty()

func _mark_selection_dirty() -> void:
	_selection_dirty = true
	_selection_deadline_sec = (Time.get_ticks_msec() / 1000.0) + SELECTION_DEBOUNCE_SEC

func _send_current_selection() -> void:
	var state: int = _client.get_state()
	if state != EppClientScript.State.CONNECTED:
		return
	var scene_root := EditorInterface.get_edited_scene_root()
	if scene_root == null:
		_client.send_selection([])
		return
	var nodes: Array = EditorInterface.get_selection().get_selected_nodes()
	var paths := PackedStringArray()
	var include_fs: bool = EppSettingsScript.get_include_filesystem(_editor_settings)
	if include_fs:
		paths = _last_fs_paths
	var items: Array[Dictionary] = EppSelectionScript.build_items(nodes, scene_root, paths)
	_client.send_selection(items)
	var seq: int = _client.get_seq()
	var session_id: String = _client.get_session_id()
	_indicator.set_details(seq, items.size(), session_id)

func _on_client_state_changed(state: int, message: String) -> void:
	match state:
		EppClientScript.State.CONNECTING:
			_indicator.set_state(EppIndicatorScript.DisplayState.CONNECTING, message)
		EppClientScript.State.CONNECTED:
			_indicator.set_state(EppIndicatorScript.DisplayState.CONNECTED, message)
		EppClientScript.State.DISCONNECTED:
			_indicator.set_state(EppIndicatorScript.DisplayState.DISCONNECTED, message)
		EppClientScript.State.UNSUPPORTED:
			_indicator.set_state(EppIndicatorScript.DisplayState.UNSUPPORTED, message)

func _on_retry_requested() -> void:
	if _client != null:
		_client.force_reconnect_now()

## The only place in this addon that touches EditorInterface's play/stop
## API — see the module doc's COMMANDS note. `action` is an open string
## (protocol.ts never validates it either), so anything other than "play"
## or "stop" answers `unsupported_action` rather than being dropped —
## exactly the spec's rule for engine-side handling of an action this
## build does not (yet) implement.
func _on_command_received(id: String, action: String, _params: Dictionary) -> void:
	if _client == null:
		return
	match action:
		"play":
			if not EditorInterface.is_playing_scene():
				EditorInterface.play_main_scene()
			_client.send_command_result(id, true)
		"stop":
			if EditorInterface.is_playing_scene():
				EditorInterface.stop_playing_scene()
			_client.send_command_result(id, true)
		_:
			_client.send_command_result(id, false, "unsupported_action")

func _on_editor_settings_changed() -> void:
	if _client == null:
		return
	var token: String = EppSettingsScript.get_token(_editor_settings)
	var url: String = EppSettingsScript.get_url(_editor_settings)
	var enabled: bool = EppSettingsScript.get_enabled(_editor_settings)
	var editor_version: String = _client.editor_version
	_client.configure(url, token, editor_version)
	if enabled and token != "":
		if not is_processing():
			set_process(true)
		_client.force_reconnect_now()
	else:
		set_process(false)
		_indicator.set_state(EppIndicatorScript.DisplayState.NO_TOKEN)
