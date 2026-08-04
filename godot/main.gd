extends Node2D

## Evidence emitter for Play/Stop verification (task #48).
##
## Deliberately prints rather than draws. A window appearing on screen only
## proves a window appeared — it does not prove the game entered the running
## state, and a stuck/blank window looks identical to a successful launch in a
## screenshot. These two lines are what distinguishes "Play actually worked"
## from "something opened".
##
## Keep this scene trivial. It is a test fixture for the editor-presence
## command channel, not a sample game; anything more here is one more thing
## that can fail for reasons unrelated to what we are verifying.

const MARKER := "[epp-fixture]"


func _ready() -> void:
	print("%s RUNNING pid=%d" % [MARKER, OS.get_process_id()])


func _notification(what: int) -> void:
	if what == NOTIFICATION_WM_CLOSE_REQUEST or what == NOTIFICATION_PREDELETE:
		print("%s STOPPED" % MARKER)
