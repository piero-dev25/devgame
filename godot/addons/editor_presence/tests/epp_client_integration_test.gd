extends SceneTree

# Integration test for EppClient against a REAL WebSocket connection —
# the addon's actual, unmodified EppClient (not a reimplementation),
# talking to FakeEppServer (also in this tests/ dir), which validates
# every inbound frame against the real wire contract in
# apps/server/src/editorPresence/protocol.ts rather than just recording
# text. Self-contained: starts and stops its own localhost server, never
# touches the shared T3 dev server on 13773.
#
# Run with:
#   godot --headless --path godot --script addons/editor_presence/tests/epp_client_integration_test.gd
#
# Runs over real wall-clock ticks (this exercises actual backoff timing,
# not simulated time), so it takes several real seconds — that is the
# point for the reconnect-policy assertions.

const EppClient = preload("res://addons/editor_presence/epp_client.gd")
const EppSelection = preload("res://addons/editor_presence/epp_selection.gd")
const FakeEppServer = preload("res://addons/editor_presence/tests/fake_epp_server.gd")

const TEST_PORT_A := 39812
const TEST_PORT_B := 39813
const STAGE_TIMEOUT_SEC := 12.0

var _pass_count := 0
var _fail_count := 0

func _check(name: String, condition: bool, detail: String = "") -> void:
	if condition:
		_pass_count += 1
		print("PASS ", name)
	else:
		_fail_count += 1
		print("FAIL ", name, " — ", detail)

enum Stage {
	CONNECT_AND_SEND,
	TRIGGER_APPLICATION_CLOSE,
	CONFIRM_NO_RECONNECT,
	CONNECT_SECOND_CLIENT,
	TRIGGER_TRANSIENT_CLOSE,
	CONFIRM_RECONNECT,
	DONE,
}

var _stage: int = Stage.CONNECT_AND_SEND
var _stage_started_at := 0.0

var _server_a: FakeEppServer
var _client_a: EppClient
var _scene_root: Node
var _node_a: Node
var _node_b: Node

var _server_b: FakeEppServer
var _client_b: EppClient

func _now() -> float:
	return Time.get_ticks_msec() / 1000.0

func _initialize() -> void:
	_server_a = FakeEppServer.new()
	if not _server_a.start(TEST_PORT_A):
		print("FAIL setup — could not bind test server to port ", TEST_PORT_A)
		quit(1)
		return

	_scene_root = Node.new()
	_scene_root.name = "IntegrationTestScene"
	_scene_root.scene_file_path = "res://Scenes/IntegrationTest.tscn"
	_node_a = Node.new()
	_node_a.name = "Alpha"
	_scene_root.add_child(_node_a)
	_node_b = Node.new()
	_node_b.name = "Beta"
	_scene_root.add_child(_node_b)

	_client_a = EppClient.new()
	_client_a.configure("ws://127.0.0.1:%d/editor-presence" % TEST_PORT_A, "dummy-token", "4.7.1-test")
	_client_a.connect_now()

	_stage_started_at = _now()

func _fail_stage_timeout(stage_name: String) -> void:
	_check(stage_name, false, "timed out after %.1fs" % STAGE_TIMEOUT_SEC)
	_finish()

func _finish() -> void:
	print("---")
	print("RESULT pass=", _pass_count, " fail=", _fail_count)
	if _server_a != null:
		_server_a.stop()
	if _server_b != null:
		_server_b.stop()
	quit(1 if _fail_count > 0 else 0)

func _process(_delta: float) -> bool:
	var now := _now()
	if now - _stage_started_at > STAGE_TIMEOUT_SEC:
		_fail_stage_timeout("stage %d timeout" % _stage)
		return true

	_server_a.poll()
	_pump_client(_client_a, now)
	if _server_b != null:
		_server_b.poll()
	_pump_client(_client_b, now)

	match _stage:
		Stage.CONNECT_AND_SEND:
			_tick_connect_and_send(now)
		Stage.TRIGGER_APPLICATION_CLOSE:
			_tick_trigger_application_close()
		Stage.CONFIRM_NO_RECONNECT:
			_tick_confirm_no_reconnect(now)
		Stage.CONNECT_SECOND_CLIENT:
			_tick_connect_second_client(now)
		Stage.TRIGGER_TRANSIENT_CLOSE:
			_tick_trigger_transient_close()
		Stage.CONFIRM_RECONNECT:
			_tick_confirm_reconnect(now)
		Stage.DONE:
			_finish()
			return true

	return false

func _advance(stage: int) -> void:
	_stage = stage
	_stage_started_at = _now()

## EppClient.poll() does NOT call connect_now() itself by design — the
## caller decides when to (re)connect via should_attempt_connect(), exactly
## as plugin.gd's _process does. This test's first version forgot to
## replicate that pump and consequently never observed a reconnect after a
## transient close — not a product bug, a missing line in the test's own
## driving loop. Fixed here so the timing (backoff, jitter) is exercised
## for real rather than short-circuited by the test.
func _pump_client(client, now: float) -> void:
	if client == null:
		return
	if client.should_attempt_connect(now):
		client.connect_now()
	client.poll(now)

func _tick_connect_and_send(now: float) -> void:
	if _client_a.get_state() != EppClient.State.CONNECTED:
		return
	# Connected — send hello was automatic on open; now send a selection
	# built through the SAME EppSelection the real plugin uses.
	if _server_a.received_frames.is_empty() or _server_a.received_frames.size() < 2:
		var items: Array[Dictionary] = EppSelection.build_items([_node_a, _node_b], _scene_root, PackedStringArray())
		_client_a.send_selection(items)

	# Wait for the server to have validated BOTH the hello and the
	# selection before asserting on them.
	if _server_a.received_frames.size() < 2:
		return

	_check("no frames were rejected by wire-contract validation", _server_a.rejected_frames.is_empty(),
		str(_server_a.rejected_frames))

	var hello_frame: Dictionary = {}
	var selection_frame: Dictionary = {}
	for frame in _server_a.received_frames:
		if frame["type"] == "hello":
			hello_frame = frame
		elif frame["type"] == "selection":
			selection_frame = frame

	_check("server validated a hello frame", hello_frame.has("type"), str(_server_a.received_frames))
	if hello_frame.has("editor"):
		_check("hello.editor.id is 'godot'", hello_frame["editor"].get("id") == "godot", str(hello_frame))

	_check("server validated a selection frame (flat, not nested)", selection_frame.has("type"), str(_server_a.received_frames))
	if selection_frame.has("items"):
		var items: Array = selection_frame["items"]
		_check("selection carries both selected nodes", items.size() == 2, str(items))
		if items.size() == 2:
			_check("items sorted deterministically (Alpha before Beta)",
				items[0]["label"] == "Alpha" and items[1]["label"] == "Beta",
				"%s, %s" % [items[0].get("label"), items[1].get("label")])

	_advance(Stage.TRIGGER_APPLICATION_CLOSE)

func _tick_trigger_application_close() -> void:
	_server_a.close_current_connection(4401, "invalid or expired token")
	_advance(Stage.CONFIRM_NO_RECONNECT)

var _reason_checked := false

func _tick_confirm_no_reconnect(now: float) -> void:
	# First wait for the client to actually observe the close.
	if _client_a.get_state() != EppClient.State.DISCONNECTED:
		return
	if now - _stage_started_at < 0.2:
		return  # let the close land before asserting on it

	if not _reason_checked:
		_reason_checked = true
		_check(
			"close 4401 surfaces the server's reason verbatim",
			_client_a.get_last_message() == "invalid or expired token",
			_client_a.get_last_message(),
		)

	# Give it a window comfortably longer than the normal backoff's first
	# retry (RECONNECT_BASE_SEC=0.5s -> first retry ~1s) before asserting
	# no reconnect happened — this is the actual behavior under test, not
	# just the state right after the close.
	if now - _stage_started_at < 4.0:
		return

	_check(
		"application close (>= 4000) does NOT auto-reconnect: still exactly 1 connection after 4s",
		_server_a.connection_count == 1,
		"connection_count=%d" % _server_a.connection_count,
	)
	_check(
		"should_attempt_connect() stays false after an application close",
		not _client_a.should_attempt_connect(now),
	)

	_advance(Stage.CONNECT_SECOND_CLIENT)

func _tick_connect_second_client(now: float) -> void:
	if _server_b == null:
		_server_b = FakeEppServer.new()
		if not _server_b.start(TEST_PORT_B):
			_check("setup: second test server binds", false, "port %d" % TEST_PORT_B)
			_advance(Stage.DONE)
			return
		_client_b = EppClient.new()
		_client_b.configure("ws://127.0.0.1:%d/editor-presence" % TEST_PORT_B, "dummy-token", "4.7.1-test")
		_client_b.connect_now()
		return

	if _client_b.get_state() == EppClient.State.CONNECTED:
		_advance(Stage.TRIGGER_TRANSIENT_CLOSE)

func _tick_trigger_transient_close() -> void:
	# A NON-application close code — the ordinary "connection dropped"
	# case, e.g. a normal closure or a network blip. This must keep
	# retrying, unlike the 4401 case above.
	_server_b.close_current_connection(1000, "normal closure")
	_advance(Stage.CONFIRM_RECONNECT)

func _tick_confirm_reconnect(now: float) -> void:
	# Wait up to the stage timeout for a second connection to land at the
	# fake server — that IS the reconnect, observed from the outside
	# rather than by inspecting the client's private state.
	if _server_b.connection_count < 2:
		return
	_check(
		"non-application close (< 4000) DOES auto-reconnect: a second connection arrived",
		_server_b.connection_count >= 2,
		"connection_count=%d" % _server_b.connection_count,
	)
	_advance(Stage.DONE)
