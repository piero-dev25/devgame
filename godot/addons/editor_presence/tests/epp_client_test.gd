extends SceneTree

# Headless test for EppClient's PURE helpers — close-code interpretation,
# backoff timing, and session id shape. Does not open a real socket; the
# live connection is exercised separately (see the addon README and the
# team-level Godot verifier) since sockets need an actual server on the
# other end. Run with:
#   godot --headless --path godot --script addons/editor_presence/tests/epp_client_test.gd

const EppClient = preload("res://addons/editor_presence/epp_client.gd")

var _pass_count := 0
var _fail_count := 0

func _check(name: String, condition: bool, detail: String = "") -> void:
	if condition:
		_pass_count += 1
		print("PASS ", name)
	else:
		_fail_count += 1
		print("FAIL ", name, " — ", detail)

func _initialize() -> void:
	_test_describe_close_application_code()
	_test_describe_close_no_reason_fallback()
	_test_describe_close_minus_one()
	_test_backoff_grows_and_caps()
	_test_backoff_jitter_bounded()
	_test_session_id_shape_and_uniqueness()
	_test_capabilities_advertise_only_what_is_implemented()
	_test_command_frame_dispatches_with_correct_fields()
	_test_command_frame_carries_an_open_ended_action_string()
	_test_command_frame_defaults_missing_params_to_empty_dict()
	_test_command_frame_missing_id_is_dropped_silently()
	_test_pong_only_clears_on_a_real_pong_type_not_a_substring_match()
	_test_real_pong_still_clears_awaiting_pong()

	print("---")
	print("RESULT pass=", _pass_count, " fail=", _fail_count)
	quit(1 if _fail_count > 0 else 0)

func _test_describe_close_application_code() -> void:
	# The exact scenario from docs/workbench/godot-probe-findings.md:
	# server closes with 4401 and a human-readable reason.
	var message := EppClient.describe_close(4401, "invalid or expired token", "ws://127.0.0.1:3777/editor-presence")
	_check(
		"close >= 4000: shows the server's reason verbatim",
		message == "invalid or expired token",
		message,
	)

func _test_describe_close_no_reason_fallback() -> void:
	var message := EppClient.describe_close(4500, "", "ws://127.0.0.1:3777/editor-presence")
	_check(
		"close >= 4000 with empty reason: falls back to a message naming the code",
		message.find("4500") != -1,
		message,
	)

func _test_describe_close_minus_one() -> void:
	# The measured, ambiguous case: HTTP 401 refusal and "nothing
	# listening" are BOTH close_code=-1, close_reason="" on this engine.
	var url := "ws://127.0.0.1:3777/editor-presence"
	var message := EppClient.describe_close(-1, "", url)
	_check(
		"close -1 (no session ever established): names the url, not a guess about cause",
		message == "cannot reach Workbench at %s" % url,
		message,
	)

func _test_backoff_grows_and_caps() -> void:
	var rng := RandomNumberGenerator.new()
	rng.seed = 1  # deterministic for the growth assertions; jitter is checked separately
	var delays: Array[float] = []
	var attempt := 0
	for i in 10:
		var result := EppClient.compute_backoff_sec(attempt, rng)
		attempt = result["attempt"]
		delays.append(result["delay_sec"])

	_check("backoff: first delay is near the 0.5s*2^1 base", delays[0] > 0.5 and delays[0] < 1.5, str(delays[0]))
	_check("backoff: caps at <= 30s * 1.2 jitter headroom", delays[-1] <= 36.0, str(delays[-1]))
	_check("backoff: attempt counter increments monotonically", attempt == 10, str(attempt))

func _test_backoff_jitter_bounded() -> void:
	var rng := RandomNumberGenerator.new()
	rng.seed = 3
	# Jitter is +/-20% of the base delay — run many samples at a fixed
	# attempt and confirm none fall outside that band.
	var attempt := 5
	var base: float = minf(EppClient.RECONNECT_BASE_SEC * pow(2.0, float(attempt + 1)), EppClient.RECONNECT_MAX_SEC)
	var low: float = base * (1.0 - EppClient.RECONNECT_JITTER_FRACTION) - 0.001
	var high: float = base * (1.0 + EppClient.RECONNECT_JITTER_FRACTION) + 0.001
	var all_in_band := true
	for i in 50:
		var result := EppClient.compute_backoff_sec(attempt, rng)
		var delay: float = result["delay_sec"]
		if delay < low or delay > high:
			all_in_band = false
			print("  jitter sample out of band: ", delay, " expected [", low, ", ", high, "]")
	_check("backoff: jitter stays within +/-20% of base across 50 samples", all_in_band)

func _test_session_id_shape_and_uniqueness() -> void:
	var rng := RandomNumberGenerator.new()
	rng.randomize()
	var id_a := EppClient.mint_session_id(rng)
	var id_b := EppClient.mint_session_id(rng)
	_check("session id: starts with godot-<pid>-", id_a.begins_with("godot-%d-" % OS.get_process_id()), id_a)
	_check("session id: 8 hex chars after the last dash", id_a.split("-")[-1].length() == 8, id_a)
	_check("session id: two mints in the same process differ (random suffix)", id_a != id_b, "%s vs %s" % [id_a, id_b])

# ============================================================================
# Task #48 — command frames (server -> engine). These call `_handle_inbound`
# / `_handle_command_frame` directly on a bare EppClient instance rather
# than through a real socket: GDScript's underscore prefix is a NAMING
# convention, not enforced privacy (confirmed empirically before writing
# these), and this is exactly the "PURE helper" category this file already
# tests — feeding raw text in and reading the resulting signal/state back
# out involves no network. The one thing this CANNOT prove — that
# EditorInterface.play_main_scene()/stop_playing_scene() actually get
# called — is plugin.gd's job and is deliberately NOT testable headlessly;
# see plugin.gd's own module doc and the addon README's "what is not
# proven" section. A real socket round trip (the fake server sending real
# bytes, a real EppClient replying with real bytes) is covered separately
# in epp_client_integration_test.gd.
# ============================================================================

func _test_capabilities_advertise_only_what_is_implemented() -> void:
	# Godot has no scriptable frame-step API, and this addon does not
	# implement pause — advertising either would be exactly the lie
	# spec-editor-presence-commands.md's capability rule forbids.
	_check(
		"capabilities: exactly play+stop, nothing this addon cannot honour",
		EppClient.CAPABILITIES == ["play", "stop"],
		str(EppClient.CAPABILITIES),
	)

func _test_command_frame_dispatches_with_correct_fields() -> void:
	var client := EppClient.new()
	var received: Array = []
	client.command_received.connect(func(id: String, action: String, params: Dictionary) -> void:
		received.append({"id": id, "action": action, "params": params})
	)
	client._handle_inbound(JSON.stringify({
		"v": 1, "type": "command", "id": "cmd-1", "at": "2026-08-04T00:00:00.000Z",
		"action": "play", "params": {"scene": "res://main.tscn"},
	}))
	_check("command: emits command_received exactly once", received.size() == 1, str(received))
	if received.size() == 1:
		_check("command: id is carried through verbatim", received[0]["id"] == "cmd-1", str(received[0]))
		_check("command: action is carried through verbatim", received[0]["action"] == "play", str(received[0]))
		_check(
			"command: params dictionary is carried through verbatim",
			received[0]["params"] == {"scene": "res://main.tscn"},
			str(received[0]),
		)

func _test_command_frame_carries_an_open_ended_action_string() -> void:
	# action is an open string here too (protocol.ts never validates it
	# server-side either) — EppClient's job is to hand it off unmodified,
	# not to pre-judge which actions are real. Whether "pause" gets a
	# reply — and what that reply is — is plugin.gd's decision, made only
	# where EditorInterface is reachable; see the addon README for why
	# that half of the contract is proven live, not here.
	var client := EppClient.new()
	var received_actions: Array[String] = []
	client.command_received.connect(func(_id: String, action: String, _params: Dictionary) -> void:
		received_actions.append(action)
	)
	client._handle_inbound(JSON.stringify({
		"v": 1, "type": "command", "id": "cmd-2", "at": "t", "action": "an.action.this.build.does.not.recognise",
	}))
	_check(
		"command: an unrecognised action still reaches the listener (never silently dropped)",
		received_actions == ["an.action.this.build.does.not.recognise"],
		str(received_actions),
	)

func _test_command_frame_defaults_missing_params_to_empty_dict() -> void:
	var client := EppClient.new()
	var received_params: Array = []
	client.command_received.connect(func(_id: String, _action: String, params: Dictionary) -> void:
		received_params.append(params)
	)
	client._handle_inbound(JSON.stringify({"v": 1, "type": "command", "id": "cmd-3", "at": "t", "action": "stop"}))
	_check(
		"command: absent params defaults to an empty Dictionary, not null",
		received_params == [{}],
		str(received_params),
	)

func _test_command_frame_missing_id_is_dropped_silently() -> void:
	# No id means nothing to correlate a commandResult reply against — see
	# _handle_command_frame's own doc comment. The real server always
	# includes one; this only guards against a malformed/adversarial peer.
	var client := EppClient.new()
	var emit_count := 0
	client.command_received.connect(func(_id: String, _action: String, _params: Dictionary) -> void:
		emit_count += 1
	)
	client._handle_inbound(JSON.stringify({"v": 1, "type": "command", "at": "t", "action": "play"}))
	_check("command: missing id never emits command_received", emit_count == 0, str(emit_count))

func _test_pong_only_clears_on_a_real_pong_type_not_a_substring_match() -> void:
	# THE regression this task's review flagged, reproduced with the
	# EXACT shape named in the review: `_handle_inbound` used to
	# substring-search the WHOLE raw frame text for the literal `"pong"`
	# (quote-pong-quote) — so a command whose caller-supplied `action` was
	# EXACTLY "pong" (a plausible action name, or an adversarial one) would
	# serialize to `..."action":"pong"...`, which DOES contain that exact
	# substring even though the frame's `type` is "command", not "pong" —
	# and would have silently cleared _awaiting_pong, defeating dead-socket
	# detection. A value merely CONTAINING "pong" as a substring of a
	# longer string (e.g. "pong-shaped-action") does NOT reproduce the old
	# bug — JSON quotes the whole value, not each word — which is exactly
	# why this uses the precise value, not an approximation of one.
	# Precondition set directly (see this section's header comment on why
	# that's fair game here) rather than waiting out a real 20s ping
	# interval — the point under test is the PARSE, not the timer.
	var client := EppClient.new()
	client._awaiting_pong = true
	client._handle_inbound(JSON.stringify({
		"v": 1, "type": "command", "id": "cmd-4", "at": "t", "action": "pong",
	}))
	_check(
		"pong-substring regression: a command whose action is exactly \"pong\" does not clear awaiting_pong",
		client.is_awaiting_pong() == true,
		"is_awaiting_pong()=%s" % client.is_awaiting_pong(),
	)
	client._handle_inbound(JSON.stringify({
		"v": 1, "type": "command", "id": "cmd-5", "at": "t", "action": "play", "params": {"mode": "pong"},
	}))
	_check(
		"pong-substring regression: params containing the exact string \"pong\" does not clear awaiting_pong either",
		client.is_awaiting_pong() == true,
		"is_awaiting_pong()=%s" % client.is_awaiting_pong(),
	)

func _test_real_pong_still_clears_awaiting_pong() -> void:
	# The other half of the same proof: the fix must not have broken the
	# LEGITIMATE case while closing the false-positive one.
	var client := EppClient.new()
	client._awaiting_pong = true
	client._handle_inbound(JSON.stringify({"v": 1, "type": "pong"}))
	_check(
		"a genuine {type:\"pong\"} frame still clears awaiting_pong",
		client.is_awaiting_pong() == false,
		"is_awaiting_pong()=%s" % client.is_awaiting_pong(),
	)
