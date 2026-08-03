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
#
# Three independent close-code scenarios, each with its own client/server
# pair so one scenario's reconnect can never pollute another's connection
# count: credential-class (4401, must STOP), internal-error-class (4500,
# must KEEP RETRYING — this is the distinction the owner corrected after
# the first version of this test only covered the credential case), and
# a plain transient close (1000, must KEEP RETRYING) to cover the
# below-4000 path too.

const EppClient = preload("res://addons/editor_presence/epp_client.gd")
const EppSelection = preload("res://addons/editor_presence/epp_selection.gd")
const FakeEppServer = preload("res://addons/editor_presence/tests/fake_epp_server.gd")

const PORT_HAPPY_PATH := 39812
const PORT_CREDENTIAL := 39813
const PORT_INTERNAL_ERROR := 39814
const PORT_TRANSIENT := 39815
const STAGE_TIMEOUT_SEC := 12.0
const NO_RECONNECT_WINDOW_SEC := 4.0
const RECONNECT_EXPECT_WINDOW_SEC := 8.0

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
	SCENARIO_CREDENTIAL,
	SCENARIO_INTERNAL_ERROR,
	SCENARIO_TRANSIENT,
	DONE,
}

# A "close scenario" bundles everything one reconnect-policy check needs:
# its own server+client pair (so its connection_count can't be polluted by
# another scenario), the code/reason to close with, whether a reconnect is
# EXPECTED, and a latch so the "just closed" assertion runs exactly once
# while the final wait/assert runs on a wall-clock deadline, not on
# re-reading current state every tick. Re-reading state was the first
# version's bug: once a client legitimately reconnects, its state stops
# being DISCONNECTED, which made a top-of-function state check abort
# before the real assertion ever ran — surfacing as an uninformative stage
# timeout instead of a named FAIL. Fixed per the owner's correction on
# mutation 1.
class CloseScenario:
	var scenario_name: String
	var port: int
	var close_code: int
	var close_reason: String
	## What EppClient.describe_close() should surface for this code — the
	## reason verbatim for >= 4000 (per describe_close's own, unchanged
	## rule), but the generic "cannot reach Workbench" message below 4000,
	## since a plain closure code carries no server-authored explanation.
	## Set per-scenario below rather than assumed equal to close_reason —
	## that wrong assumption was caught by actually running this test
	## against the transient (1000) scenario.
	var expected_message: String
	var expect_reconnect: bool
	var server: FakeEppServer
	var client: EppClient
	var latched_at: float = -1.0
	var close_triggered := false

var _scenarios: Array[CloseScenario] = []

var _stage: int = Stage.CONNECT_AND_SEND
var _stage_started_at := 0.0

var _server_happy: FakeEppServer
var _client_happy: EppClient
var _scene_root: Node
var _node_a: Node
var _node_b: Node

func _now() -> float:
	return Time.get_ticks_msec() / 1000.0

func _initialize() -> void:
	_server_happy = FakeEppServer.new()
	if not _server_happy.start(PORT_HAPPY_PATH):
		print("FAIL setup — could not bind test server to port ", PORT_HAPPY_PATH)
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

	_client_happy = EppClient.new()
	_client_happy.configure("ws://127.0.0.1:%d/editor-presence" % PORT_HAPPY_PATH, "dummy-token", "4.7.1-test")
	_client_happy.connect_now()

	var credential := CloseScenario.new()
	credential.scenario_name = "credential-class (4401)"
	credential.port = PORT_CREDENTIAL
	credential.close_code = 4401
	credential.close_reason = "invalid or expired token"
	credential.expect_reconnect = false
	_scenarios.append(credential)

	var internal_error := CloseScenario.new()
	internal_error.scenario_name = "internal-error-class (4500)"
	internal_error.port = PORT_INTERNAL_ERROR
	internal_error.close_code = 4500
	internal_error.close_reason = "internal_error"
	internal_error.expect_reconnect = true
	_scenarios.append(internal_error)

	var transient := CloseScenario.new()
	transient.scenario_name = "transient (1000, < 4000)"
	transient.port = PORT_TRANSIENT
	transient.close_code = 1000
	transient.close_reason = "normal closure"
	transient.expect_reconnect = true
	_scenarios.append(transient)

	# expected_message is derived from the SAME pure describe_close()
	# already unit-tested in epp_client_test.gd — this test's job is
	# proving that value actually reaches get_last_message() through a
	# real close, not re-testing describe_close's own formatting.
	for scenario in _scenarios:
		var url := "ws://127.0.0.1:%d/editor-presence" % scenario.port
		scenario.expected_message = EppClient.describe_close(scenario.close_code, scenario.close_reason, url)

	_stage_started_at = _now()

func _fail_stage_timeout(stage_name: String) -> void:
	_check(stage_name, false, "timed out after %.1fs" % STAGE_TIMEOUT_SEC)
	_finish()

func _finish() -> void:
	print("---")
	print("RESULT pass=", _pass_count, " fail=", _fail_count)
	if _server_happy != null:
		_server_happy.stop()
	for scenario in _scenarios:
		if scenario.server != null:
			scenario.server.stop()
	# Node is not reference-counted like the RefCounted client/server
	# objects above — free the tree explicitly or it leaks at exit
	# (previous run: "3 ObjectDB instances were leaked", exactly this tree).
	if _scene_root != null:
		_scene_root.free()
	quit(1 if _fail_count > 0 else 0)

func _process(_delta: float) -> bool:
	var now := _now()
	if now - _stage_started_at > STAGE_TIMEOUT_SEC:
		_fail_stage_timeout("stage %d timeout" % _stage)
		return true

	_server_happy.poll()
	_pump_client(_client_happy, now)
	for scenario in _scenarios:
		if scenario.server != null:
			scenario.server.poll()
		_pump_client(scenario.client, now)

	match _stage:
		Stage.CONNECT_AND_SEND:
			_tick_connect_and_send(now)
		Stage.SCENARIO_CREDENTIAL:
			_tick_scenario(now, _scenarios[0], Stage.SCENARIO_INTERNAL_ERROR)
		Stage.SCENARIO_INTERNAL_ERROR:
			_tick_scenario(now, _scenarios[1], Stage.SCENARIO_TRANSIENT)
		Stage.SCENARIO_TRANSIENT:
			_tick_scenario(now, _scenarios[2], Stage.DONE)
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
	if _client_happy.get_state() != EppClient.State.CONNECTED:
		return
	if _server_happy.received_frames.size() < 2:
		var items: Array[Dictionary] = EppSelection.build_items([_node_a, _node_b], _scene_root, PackedStringArray())
		_client_happy.send_selection(items)
		return

	_check("no frames were rejected by wire-contract validation", _server_happy.rejected_frames.is_empty(),
		str(_server_happy.rejected_frames))

	var hello_frame: Dictionary = {}
	var selection_frame: Dictionary = {}
	for frame in _server_happy.received_frames:
		if frame["type"] == "hello":
			hello_frame = frame
		elif frame["type"] == "selection":
			selection_frame = frame

	_check("server validated a hello frame", hello_frame.has("type"), str(_server_happy.received_frames))
	if hello_frame.has("editor"):
		_check("hello.editor.id is 'godot'", hello_frame["editor"].get("id") == "godot", str(hello_frame))

	_check("server validated a selection frame (flat, not nested)", selection_frame.has("type"), str(_server_happy.received_frames))
	if selection_frame.has("items"):
		var items: Array = selection_frame["items"]
		_check("selection carries both selected nodes", items.size() == 2, str(items))
		if items.size() == 2:
			_check("items sorted deterministically (Alpha before Beta)",
				items[0]["label"] == "Alpha" and items[1]["label"] == "Beta",
				"%s, %s" % [items[0].get("label"), items[1].get("label")])

	_advance(Stage.SCENARIO_CREDENTIAL)

func _tick_scenario(now: float, scenario: CloseScenario, next_stage: int) -> void:
	# Step 1: bring up this scenario's own server+client pair.
	if scenario.server == null:
		scenario.server = FakeEppServer.new()
		if not scenario.server.start(scenario.port):
			_check("setup: %s test server binds" % scenario.scenario_name, false, "port %d" % scenario.port)
			_advance(Stage.DONE)
			return
		scenario.client = EppClient.new()
		scenario.client.configure("ws://127.0.0.1:%d/editor-presence" % scenario.port, "dummy-token", "4.7.1-test")
		scenario.client.connect_now()
		return

	# Step 2: wait for it to connect, then trigger the close under test.
	if not scenario.close_triggered:
		if scenario.client.get_state() != EppClient.State.CONNECTED:
			return
		scenario.server.close_current_connection(scenario.close_code, scenario.close_reason)
		scenario.close_triggered = true
		return

	# Step 3: latch the moment the client observes the close, exactly
	# once, and check the surfaced message then — but do the final
	# reconnect-or-not assertion on a wall-clock deadline regardless of
	# what the client's state has done since, so a later reconnect (or a
	# later failure to reconnect) cannot make this exit early without
	# ever running the named assertion.
	if scenario.latched_at < 0.0:
		if scenario.client.get_state() != EppClient.State.DISCONNECTED:
			return
		scenario.latched_at = now
		_check(
			"%s: surfaced message matches describe_close()" % scenario.scenario_name,
			scenario.client.get_last_message() == scenario.expected_message,
			"got %s, expected %s" % [scenario.client.get_last_message(), scenario.expected_message],
		)
		return

	if scenario.expect_reconnect:
		# Same reasoning as the no-reconnect branch above, applied in the
		# other direction: don't just silently wait forever for
		# connection_count to reach 2 and let a broken run fall through to
		# the generic stage timeout (weak evidence — proves SOMETHING
		# broke, not that THIS guard caught THIS regression). Give it a
		# bounded window and assert by name either way.
		if scenario.server.connection_count >= 2:
			_check(
				"%s: DOES auto-reconnect (a second connection arrived)" % scenario.scenario_name,
				true,
			)
		elif now - scenario.latched_at < RECONNECT_EXPECT_WINDOW_SEC:
			return  # keep waiting, bounded by this window
		else:
			_check(
				"%s: DOES auto-reconnect (a second connection arrived)" % scenario.scenario_name,
				false,
				"connection_count=%d after %.0fs" % [scenario.server.connection_count, RECONNECT_EXPECT_WINDOW_SEC],
			)
	else:
		if now - scenario.latched_at < NO_RECONNECT_WINDOW_SEC:
			return  # keep waiting out the window, bounded by the stage timeout
		_check(
			"%s: does NOT auto-reconnect (still exactly 1 connection after %.0fs)" % [scenario.scenario_name, NO_RECONNECT_WINDOW_SEC],
			scenario.server.connection_count == 1,
			"connection_count=%d" % scenario.server.connection_count,
		)
		_check(
			"%s: should_attempt_connect() stays false" % scenario.scenario_name,
			not scenario.client.should_attempt_connect(now),
		)

	_advance(next_stage)
