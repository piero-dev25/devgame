extends Node2D

## Evidence emitter for Play/Stop verification (task #48).
##
## Deliberately prints rather than draws. A window appearing on screen only
## proves a window appeared — it does not prove the game entered the running
## state, and a stuck/blank window looks identical to a successful launch in a
## screenshot. This line is what distinguishes "Play actually worked" from
## "something opened".
##
## Keep this scene trivial. It is a test fixture for the editor-presence
## command channel, not a sample game; anything more here is one more thing
## that can fail for reasons unrelated to what we are verifying.
##
## NO "STOPPED" MARKER, DELIBERATELY — there used to be one, printed from
## _notification() on NOTIFICATION_WM_CLOSE_REQUEST / NOTIFICATION_PREDELETE.
## Measured live (task #48 verification, two independent runs): it never
## printed. EditorInterface.stop_playing_scene() TERMINATES the running
## child process directly rather than requesting a graceful close, so this
## scene's own notification handler never gets the chance to run — there is
## no clean-shutdown path here to observe. A marker that can never fire is
## worse than no marker: the next person to run this would see RUNNING with
## no STOPPED, conclude Stop is broken, and go debug a non-bug.
##
## Stop is verified the way it actually was during that verification run:
## by confirming the child process is GONE (`ps -p <pid>` after dispatching
## a "stop" command — the pid this scene prints via RUNNING above). Absence
## of process is the stronger check anyway; it is what actually happened.

const MARKER := "[epp-fixture]"


func _ready() -> void:
	print("%s RUNNING pid=%d" % [MARKER, OS.get_process_id()])
