"""
init_unreal.py — auto-run entrypoint for the T3 Editor Presence plugin.

Any file named `init_unreal.py` directly under an enabled plugin's
`Content/Python/` folder is auto-executed by the PythonScriptPlugin at
editor startup. UNVERIFIED: whether that is true for a PLUGIN's
Content/Python specifically, as opposed to only the project's own
Content/Python — see ../../../../UNVERIFIED.md. The whole drop-in
distribution shape rests on this being true; if it turns out to be
project-only, installing this plugin gains a manual `sys.path` step and the
README's install instructions need a step 4.5.

Does exactly four things, per the frozen spec's step 2, and nothing else:
  1. Commandlet guard — refuse to start under a cook/build commandlet.
  2. Singleton guard — a second run (someone re-executes this file by hand,
     or the plugin gets toggled) is a no-op, not a second socket.
  3. (No vendored dependency to `sys.path`-insert — see epp/wire.py's
     module docstring for why this plugin hand-rolls its WebSocket client
     instead of vendoring one; step 2's spec text assumed vendoring, this
     is the one deliberate simplification that falls out of not doing
     that.)
  4. Start the publisher.
"""

from epp import unreal_bridge
from epp.publisher import Publisher

try:
    import unreal
except ImportError:  # pragma: no cover - exercised only inside the editor
    unreal = None


def _main() -> None:
    if unreal is None:
        return

    if unreal_bridge.is_commandlet_context():
        return

    existing = unreal_bridge.get_running_publisher()
    if existing is not None:
        unreal.log("[T3 Editor Presence] already running (singleton guard) — not starting a second instance")
        return

    publisher = Publisher()
    unreal_bridge.set_running_publisher(publisher)
    publisher.start()


_main()
