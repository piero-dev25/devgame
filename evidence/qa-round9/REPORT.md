# QA round 9 — the selection-chip loop, closed live

Build: one-click pairing (`6981739d7` + review fixes `34b3e38ce`), packaged,
fresh backend verified. Owner-authorised write on Mafia Game.

## The proven chain, with evidence per hop

| Hop                                 | Evidence                                                                                                                                                                                                                                                            |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One click installs both packages    | Toast verbatim: "com.unity.pipeline@0.4.0-exp.1 was already installed. Replaced the embedded com.ironmind.editor-presence@0.3.0 package under Packages/. A fresh pairing credential was handed off; pairing will finish automatically in Unity." Disk: 0.2.0→0.3.0. |
| Credential minted + handoff written | `Library/com.ironmind.editor-presence/pairing.json` appeared (0600, 24h, single-use, revocable in Connections).                                                                                                                                                     |
| Unity redeemed automatically        | `pairing.json` DELETED 9 seconds after Unity resolved the package — no human touched anything.                                                                                                                                                                      |
| Publisher registered                | The Setup CTA withdrew itself between driver samples (probe saw the paired state).                                                                                                                                                                                  |
| Selection → chip                    | Selection set to Directional Light; the **"Directional Light" chip appeared in the composer** within 30s (driver, verbatim, two samples).                                                                                                                           |

## The one wrinkle, and its named fix

Unity's auto-refresh did NOT fire when the Editor was merely activated — the
0.3.0 package sat unloaded until `unity command package_resolve` was invoked
externally (which then triggered reimport → recompile → redemption in 9s, and
notably **works while Unity is unfocused**). On editors with auto-refresh on
(the default), the click alone suffices; on this machine it did not.

THE DURABLE FIX (filed as the next task): the install route already shells
out to the Unity CLI — after replacing the embedded package it should itself
invoke `package_resolve` when a live editor for the project exists. That
removes the auto-refresh dependence entirely and makes the click zero-touch
on every configuration.

## Round-9 driver-run learnings

- Unity's `Editor.log` is readable without any grant and answers "did Unity
  even notice" definitively (its mtime predating the click was the tell).
- The Pipeline CLI's `eval` command can drive Editor state (used here for
  `Selection.activeGameObject`) — positional-arg parsing for array
  parameters (`set_selection`) silently no-ops; prefer `eval` for one-offs.
- A healthy presence connection with no selection items shows NOTHING in the
  chip row by design — "no chip" right after pairing is not a failure;
  the first selection change lights it up.
