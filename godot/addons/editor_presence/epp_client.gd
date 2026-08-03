@tool
extends RefCounted
class_name EppClient

## WebSocket publisher connection for the Editor Presence Protocol.
##
## Owns: connect/reconnect with exponential backoff + jitter, hello /
## selection / ping framing, seq bookkeeping, close-code interpretation,
## and a circuit breaker against a runaway poll loop. Frame *content* comes
## from EppSelection (pure, injectable); this file owns transport only.
##
## SESSION/SEQ DESIGN (spec-godot-publisher.md step 4) — do not "simplify"
## this later, it is load-bearing: `session_id` is minted ONCE per
## EppClient instance with a random suffix, and `seq` is monotonic for the
## life of that instance and NEVER resets on reconnect. The server does
## last-writer-wins on `session.id` and the subscriber drops any frame with
## `seq <= last seen`. A deterministic session_id (e.g. just the process
## id) combined with a seq reset on reconnect would make every
## post-reconnect frame silently invisible while every layer reports
## healthy — a bug that survives a demo and ruins a work day.
##
## CLOSE-CODE RULE (docs/workbench/godot-probe-findings.md, verified against
## a real running server): code >= 4000 means the server told us why via a
## deliberate application close — show the reason verbatim. Code -1 means no
## WebSocket session was ever established (bad token AND server-down are
## indistinguishable at this layer on a plain HTTP 401 refusal) — the
## presence route is designed to always accept the upgrade and reject with
## an application close instead, specifically so engine clients get a real
## reason here. This message rule is unchanged and applies to every
## code >= 4000, not just the credential-class ones below.
##
## RECONNECT POLICY — CREDENTIAL-CLASS vs EVERYTHING ELSE, not a numeric
## threshold. The first version of this rule stopped retrying on ANY
## close >= 4000, which conflated two different situations: a bad/missing
## token (retrying cannot help, so stop) and a server-side fault like
## internal_error (transient by definition — a momentary server hiccup
## should not permanently disconnect every editor on every machine until
## someone notices and clicks retry). See is_credential_close() below:
## only THOSE specific codes stop auto-reconnecting. Every other close —
## including other >= 4000 codes this client doesn't recognise, and
## anything below 4000 or -1 — keeps retrying with normal backoff, because
## the server said "my fault, not yours" (or said nothing at all).
## Recovery from a stopped state is the toolbar indicator's click-to-retry
## (force_reconnect_now), once the user has actually fixed the problem.
## Do NOT re-flatten this back into a numeric threshold — that is the
## exact bug this replaced.

signal state_changed(state: int, message: String)

enum State { DISCONNECTED, CONNECTING, CONNECTED, UNSUPPORTED }

const APPLICATION_CLOSE_THRESHOLD := 4000
## The named, closed set — see the RECONNECT POLICY doc above. 4400
## missing_credential and 4401 invalid_credential are the only codes that
## stop auto-reconnecting; everything else (including other >= 4000 codes
## like 4500 internal_error) keeps retrying.
const CREDENTIAL_CLOSE_CODES: Array[int] = [4400, 4401]
const RECONNECT_BASE_SEC := 0.5
const RECONNECT_MAX_SEC := 30.0
const RECONNECT_JITTER_FRACTION := 0.2
const CIRCUIT_BREAKER_LIMIT := 3
const PING_INTERVAL_SEC := 20.0
const PONG_TIMEOUT_SEC := 10.0

var editor_id := "godot"
var editor_name := "Godot Editor"
var editor_version := "unknown"

var _peer: WebSocketPeer
var _url := ""
var _token := ""
var _session_id: String
var _seq := 0
var _state: int = State.DISCONNECTED
var _last_message := ""
var _reconnect_attempt := 0
var _next_connect_at_sec := 0.0
var _consecutive_errors := 0
var _last_ping_at_sec := 0.0
var _awaiting_pong := false
var _rng := RandomNumberGenerator.new()

func _init(session_id: String = "") -> void:
	_rng.randomize()
	_session_id = session_id if session_id != "" else mint_session_id(_rng)

static func mint_session_id(rng: RandomNumberGenerator) -> String:
	var chars := "0123456789abcdef"
	var suffix := ""
	for i in 8:
		suffix += chars[rng.randi() % chars.length()]
	return "godot-%d-%s" % [OS.get_process_id(), suffix]

## Pure: whether this close code is credential-class (retrying cannot
## help — stop) as opposed to everything else, including other
## application-level codes like 4500 internal_error (the server's fault,
## transient by definition — keep retrying). A named, closed set on
## purpose, not `code >= 4000` — see the RECONNECT POLICY doc above for
## why that flattening was wrong.
static func is_credential_close(code: int) -> bool:
	return CREDENTIAL_CLOSE_CODES.has(code)

## Pure: given a close code/reason, returns the message to surface. code
## >= 4000 -> the server's own reason, verbatim; -1 (or any non-application
## code) -> a generic unreachable message naming the URL, since the cause
## cannot be distinguished from here (see the module doc above).
static func describe_close(code: int, reason: String, url: String) -> String:
	if code >= APPLICATION_CLOSE_THRESHOLD:
		return reason if reason != "" else "rejected by server (code %d)" % code
	return "cannot reach Workbench at %s" % url

## Pure: exponential backoff with jitter, matching
## spec-godot-publisher.md step 4 (0.5s base, 30s cap, +/-20% jitter). Only
## reached for non-application closes now — an application close (>= 4000)
## does not call this at all, see _stop_retrying().
static func compute_backoff_sec(attempt: int, rng: RandomNumberGenerator) -> Dictionary:
	var next_attempt := attempt + 1
	var base_delay: float = minf(RECONNECT_BASE_SEC * pow(2.0, float(next_attempt)), RECONNECT_MAX_SEC)
	var jitter_span: float = base_delay * RECONNECT_JITTER_FRACTION
	var jitter: float = rng.randf_range(-jitter_span, jitter_span)
	var delay: float = maxf(0.05, base_delay + jitter)
	return {"attempt": next_attempt, "delay_sec": delay}

func configure(url: String, token: String, editor_ver: String) -> void:
	_url = url
	_token = token
	editor_version = editor_ver

func get_state() -> int:
	return _state

func get_last_message() -> String:
	return _last_message

func get_session_id() -> String:
	return _session_id

func get_seq() -> int:
	return _seq

## Resets backoff and retries immediately — the toolbar indicator's
## click-to-retry gesture. The user just started the server; don't make
## them wait out a 30s window.
func force_reconnect_now() -> void:
	_reconnect_attempt = 0
	_next_connect_at_sec = 0.0
	if _peer != null:
		_peer = null
	_set_state(State.DISCONNECTED, "")

func should_attempt_connect(now_sec: float) -> bool:
	if _state == State.CONNECTING or _state == State.CONNECTED:
		return false
	if _state == State.UNSUPPORTED:
		return false
	if _url == "" or _token == "":
		return false
	return now_sec >= _next_connect_at_sec

func connect_now() -> void:
	_peer = WebSocketPeer.new()
	if _token != "":
		_peer.handshake_headers = PackedStringArray(["Authorization: Bearer " + _token])
	var connect_url := _url + "?role=publisher"
	var err := _peer.connect_to_url(connect_url)
	if err != OK:
		_peer = null
		_schedule_retry(0.0)
		_set_state(State.DISCONNECTED, "connect_to_url failed (error %d)" % err)
		return
	_set_state(State.CONNECTING, "")

## Advances the connection: polls the socket, drains inbound packets,
## sends a due ping, and returns true if a `selection` frame should be
## (re)sent this tick because the connection just opened.
func poll(now_sec: float) -> bool:
	if _peer == null:
		return false
	_peer.poll()
	var ready_state := _peer.get_ready_state()
	var just_opened := false

	if ready_state == WebSocketPeer.STATE_OPEN and _state != State.CONNECTED:
		_reconnect_attempt = 0
		_consecutive_errors = 0
		_last_ping_at_sec = now_sec
		_awaiting_pong = false
		_set_state(State.CONNECTED, "")
		_send_hello()
		just_opened = true

	if ready_state == WebSocketPeer.STATE_OPEN:
		while _peer.get_available_packet_count() > 0:
			var text := _peer.get_packet().get_string_from_utf8()
			_handle_inbound(text)
		if now_sec - _last_ping_at_sec >= PING_INTERVAL_SEC:
			if _awaiting_pong:
				# No pong within the deadline — treat as a dead half-open
				# socket (the laptop-sleep case) and force a reconnect.
				_peer = null
				_schedule_retry(now_sec)
				_set_state(State.DISCONNECTED, "no response to ping — connection presumed dead")
				return just_opened
			_send_json({"v": 1, "type": "ping"})
			_last_ping_at_sec = now_sec
			_awaiting_pong = true

	if ready_state == WebSocketPeer.STATE_CLOSED:
		var code := _peer.get_close_code()
		var reason := _peer.get_close_reason()
		_peer = null
		if is_credential_close(code):
			_stop_retrying()
		else:
			_schedule_retry(now_sec)
		_set_state(State.DISCONNECTED, describe_close(code, reason, _url))

	return just_opened

func send_selection(items: Array[Dictionary]) -> void:
	_seq += 1
	_send_json({
		"v": 1,
		"type": "selection",
		"seq": _seq,
		"at": _iso8601_now(),
		"items": items,
	})

func _send_hello() -> void:
	_send_json({
		"v": 1,
		"type": "hello",
		"editor": {"id": editor_id, "name": editor_name, "version": editor_version},
		"session": {"id": _session_id},
		"workspace": {"root": ProjectSettings.globalize_path("res://").trim_suffix("/")},
	})

func _handle_inbound(text: String) -> void:
	if text.find("\"pong\"") != -1:
		_awaiting_pong = false

## Circuit breaker note: GDScript has no exception handling, so this can
## only react to CHECKABLE failures (a non-OK return from send_text) — it
## cannot catch an arbitrary runtime crash in item-building. That is why
## EppSelection.build_items leans so hard on is_instance_valid() checks
## instead: the mitigation for "no try/catch" is not crashing in the first
## place, not catching after. This breaker exists for the one failure mode
## that IS a checkable return code.
func _send_json(obj: Dictionary) -> void:
	if _peer == null or _peer.get_ready_state() != WebSocketPeer.STATE_OPEN:
		return
	var err := _peer.send_text(JSON.stringify(obj))
	if err != OK:
		_consecutive_errors += 1
		if _consecutive_errors >= CIRCUIT_BREAKER_LIMIT:
			push_error("[T3 Editor Presence] %d consecutive send failures, disconnecting" % _consecutive_errors)
			_peer = null
			_schedule_retry(Time.get_ticks_msec() / 1000.0)
			_set_state(State.DISCONNECTED, "repeated send failures — check the connection")
	else:
		_consecutive_errors = 0

func _schedule_retry(now_sec: float) -> void:
	var result := compute_backoff_sec(_reconnect_attempt, _rng)
	_reconnect_attempt = result["attempt"]
	_next_connect_at_sec = now_sec + result["delay_sec"]

## An application close (>= 4000) does not get a retry scheduled at all —
## should_attempt_connect() stays false forever until force_reconnect_now()
## resets it. See the RECONNECT POLICY note in this file's header comment.
func _stop_retrying() -> void:
	_next_connect_at_sec = INF

func _set_state(state: int, message: String) -> void:
	_state = state
	_last_message = message
	state_changed.emit(state, message)

## ISO-8601 with an explicit "Z" and milliseconds. Godot's
## Time.get_datetime_string_from_unix_time gives neither by default
## (verified — docs/workbench/godot-probe-findings.md:
## "2025-08-03T00:00:00", no Z, no ms) so both are appended by hand rather
## than assumed. The second parameter is `use_space`, NOT a UTC flag — it
## swaps the "T" separator for a literal space when true. That was gotten
## wrong once already (own live-integration test caught a frame arriving
## as "2026-08-03 09:06:58.208Z", space instead of T) so it is called out
## here explicitly: leave it false/omitted to keep "T".
static func _iso8601_now() -> String:
	var t := Time.get_unix_time_from_system()
	var base := Time.get_datetime_string_from_unix_time(int(t))
	var ms := int(fmod(t, 1.0) * 1000.0)
	return "%s.%03dZ" % [base, ms]
