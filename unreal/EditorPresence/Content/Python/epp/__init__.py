"""
Editor Presence Protocol (EPP) v1 — Unreal Editor publisher, implementation
package.

This package is deliberately split so the boundary between "pure logic,
testable with `python3 -m unittest` on any machine" and "talks to the
running Unreal Editor, unverifiable outside the editor" is a file boundary,
not a convention someone has to remember:

  Pure, no `unreal` import, covered by unreal/tests/:
    model.py       - plain data shapes (SelectionItem)
    protocol.py    - EPP v1 frame construction, matching
                     apps/server/src/editorPresence/protocol.ts exactly
    mapping.py     - engine-concept -> protocol-item field derivation rules
    sampler.py     - tick-driven poll + digest + emit policy
    wire.py        - RFC 6455 framing + the reconnecting publisher thread
    config.py      - token/endpoint resolution + the pairing-token redeem
                     HTTP call

  Touches `unreal`, cannot be exercised outside a running editor, kept
  deliberately thin and defensive (see ../../../UNVERIFIED.md):
    unreal_bridge.py - real selection source, tick registration, PIE
                       detection, paths, engine version, commandlet guard
    indicator.py     - ToolMenus status entry, token-folder/pairing actions
    publisher.py     - wires the above into one running publisher

See ../../../README.md for what a user does to install this, and
../../../UNVERIFIED.md for every Unreal Python API name used here that
could not be checked against a running editor (Unreal Engine is not
installed on the machine this was written on).
"""
