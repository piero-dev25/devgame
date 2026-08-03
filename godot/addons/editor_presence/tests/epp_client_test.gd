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
	_test_backoff_escalation_floor()
	_test_backoff_jitter_bounded()
	_test_session_id_shape_and_uniqueness()

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
		var result := EppClient.compute_backoff_sec(attempt, false, rng)
		attempt = result["attempt"]
		delays.append(result["delay_sec"])

	_check("backoff: first delay is near the 0.5s*2^1 base", delays[0] > 0.5 and delays[0] < 1.5, str(delays[0]))
	_check("backoff: caps at <= 30s * 1.2 jitter headroom", delays[-1] <= 36.0, str(delays[-1]))
	_check("backoff: attempt counter increments monotonically", attempt == 10, str(attempt))

func _test_backoff_escalation_floor() -> void:
	var rng := RandomNumberGenerator.new()
	rng.seed = 2
	# An application close (escalate=true) from attempt 0 must jump straight
	# toward the floor rather than retry at the fast base delay — this is
	# the "don't hammer-reconnect on an auth rejection" rule.
	var result := EppClient.compute_backoff_sec(0, true, rng)
	_check(
		"backoff: application close escalates attempt to the floor",
		result["attempt"] >= 3,
		str(result["attempt"]),
	)
	_check(
		"backoff: escalated delay is meaningfully larger than the base 0.5s",
		result["delay_sec"] > 2.0,
		str(result["delay_sec"]),
	)

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
		var result := EppClient.compute_backoff_sec(attempt, false, rng)
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
