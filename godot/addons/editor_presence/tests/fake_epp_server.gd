@tool
extends RefCounted
class_name FakeEppServer

## A minimal, dependency-free EPP server for testing EppClient against a
## REAL WebSocket connection, entirely in GDScript — TCPServer +
## WebSocketPeer.accept_stream(), both confirmed present in this engine
## (godot-probe2/probe_wsserver.gd). No Node, no external process, no
## network dependency beyond localhost: the test starts this, drives it,
## and stops it, so it never depends on — and can never disturb — the
## shared T3 dev server on 127.0.0.1:13773.
##
## CRITICAL PROPERTY, per the owner's explicit instruction: this validates
## every inbound frame against the REAL wire contract
## (apps/server/src/editorPresence/protocol.ts), not just recorded text.
## The Unreal plugin's loopback test recorded raw text and so never noticed
## it was sending `selection` frames with seq/at/items nested under a
## "selection" key instead of flat at the top level — every one of those
## frames would have been silently discarded by the real server. A fake
## that accepts anything proves nothing; this one only records a frame if
## it would have parsed on the real server too.
##
## Single connection at a time — this test doesn't need concurrent
## publishers, and a second connection while one is open is rejected by
## simply not calling take_connection() again until the first drops.

var _tcp := TCPServer.new()
var _peer: WebSocketPeer
var port: int = -1

## Every frame the wire contract accepted, in arrival order, as parsed
## Dictionaries (not raw text) — e.g. {"type": "hello", "editor": {...}, ...}.
var received_frames: Array[Dictionary] = []
## Raw text of any frame that FAILED validation — should be empty in a
## passing run; non-empty means either the client or this fake disagrees
## with the real server's protocol.ts.
var rejected_frames: Array[String] = []
## Incremented each time a NEW TCP connection is accepted (i.e. each
## (re)connect) — how the reconnect-behavior tests observe whether the
## client tried again without needing to inspect its private state.
var connection_count: int = 0

func start(preferred_port: int) -> bool:
	var err := _tcp.listen(preferred_port)
	if err != OK:
		return false
	port = preferred_port
	return true

func stop() -> void:
	if _peer != null:
		_peer.close(1000, "test server stopping")
		_peer = null
	_tcp.stop()

## Closes the current connection (if any) with a specific code/reason —
## how the tests simulate the server's own 4401-on-bad-token behavior
## without needing real auth.
func close_current_connection(code: int, reason: String) -> bool:
	if _peer == null:
		return false
	_peer.close(code, reason)
	return true

func has_active_connection() -> bool:
	return _peer != null and _peer.get_ready_state() == WebSocketPeer.STATE_OPEN

func poll() -> void:
	if _peer == null and _tcp.is_connection_available():
		var stream: StreamPeerTCP = _tcp.take_connection()
		var ws := WebSocketPeer.new()
		if ws.accept_stream(stream) == OK:
			_peer = ws
			connection_count += 1

	if _peer == null:
		return

	_peer.poll()
	var state := _peer.get_ready_state()
	if state == WebSocketPeer.STATE_OPEN:
		while _peer.get_available_packet_count() > 0:
			_handle_inbound(_peer.get_packet().get_string_from_utf8())
	elif state == WebSocketPeer.STATE_CLOSED:
		_peer = null

func _handle_inbound(text: String) -> void:
	var frame = validate_frame(text)
	if frame == null:
		rejected_frames.append(text)
		return
	received_frames.append(frame)
	if frame["type"] == "ping" and _peer != null:
		_peer.send_text(JSON.stringify({"v": 1, "type": "pong"}))

static func _is_nonempty_string(value) -> bool:
	return typeof(value) == TYPE_STRING and value.strip_edges() != ""

static func _is_number(value) -> bool:
	return typeof(value) == TYPE_INT or typeof(value) == TYPE_FLOAT

## Mirrors apps/server/src/editorPresence/protocol.ts's
## parseEditorPresenceInboundFrame — kept in sync by hand, since this route
## deliberately has no packages/contracts schema to share. Returns null
## for anything that would not have parsed on the real server.
static func validate_frame(text: String):
	var json := JSON.new()
	if json.parse(text) != OK:
		return null
	var data = json.get_data()
	if typeof(data) != TYPE_DICTIONARY:
		return null
	if data.get("v") != 1:
		return null
	var frame_type = data.get("type")
	if typeof(frame_type) != TYPE_STRING:
		return null
	match frame_type:
		"hello":
			return _validate_hello(data)
		"selection":
			return _validate_selection(data)
		"ping":
			return {"type": "ping"}
		_:
			return null

static func _validate_hello(data: Dictionary):
	var editor = data.get("editor")
	var session = data.get("session")
	var workspace = data.get("workspace")
	if typeof(editor) != TYPE_DICTIONARY:
		return null
	if not _is_nonempty_string(editor.get("id")):
		return null
	if not _is_nonempty_string(editor.get("name")):
		return null
	if not _is_nonempty_string(editor.get("version")):
		return null
	if typeof(session) != TYPE_DICTIONARY or not _is_nonempty_string(session.get("id")):
		return null
	if typeof(workspace) != TYPE_DICTIONARY or not _is_nonempty_string(workspace.get("root")):
		return null
	return {"type": "hello", "editor": editor, "session": session, "workspace": workspace}

## THE CHECK THAT CATCHES THE UNREAL-CLASS BUG: seq/at/items must be at the
## TOP LEVEL of the frame, exactly as apps/server/src/editorPresence/
## protocol.ts's parseSelection reads them — not nested under a
## "selection" key. A frame shaped
## {"type":"selection","selection":{"seq":1,"at":"...","items":[...]}}
## has data.get("seq") == null here and is correctly rejected.
static func _validate_selection(data: Dictionary):
	if not _is_number(data.get("seq")):
		return null
	if not _is_nonempty_string(data.get("at")):
		return null
	var items = data.get("items")
	if typeof(items) != TYPE_ARRAY:
		return null
	return {"type": "selection", "seq": data.get("seq"), "at": data.get("at"), "items": items}
