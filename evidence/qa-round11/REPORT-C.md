# QA round 11 — Part C report

## Item 1 — UNITY-INITIATED PLAY + EXTERNAL PAUSE — FAIL

The orchestrator started Unity play mode externally at 17:07:38, kept the
harness idle throughout the reload/reconnect, and paused Unity externally at
17:08:08. Part C issued zero harness transport clicks and performed only
read-only `get_app_state` sampling of `DevGame (Alpha)`.

The Mafia Game thread was open during all three samples:

```text
												104 button New thread in Mafia Game
												105 pop up button Thread actions for Explain Selected Main Camera
													106 heading Explain Selected Main Camera
														107 text Explain Selected Main Camera
```

Expected after the external play and pause commands: the Play/Stop toggle
shows the engaged Stop face (`Description: Stop, Value: 1`) and the pause
toggle is engaged (`Description: Pause, Value: 1`).

Sample 1 did not expose separate `Description:` or `Value:` fields for these
controls; its verbatim accessibility-state excerpt showed the Play face and a
Pause control:

```text
												115 button Bring the Unity Editor to the front
												116 container Unity transport controls
													117 toggle button Play
													118 toggle button Pause
```

Sample 2, after approximately 15 seconds, exposed the fields explicitly. The
pause state had arrived and was engaged, but the Play/Stop toggle still showed
the stopped Play face:

```text
												115 button Bring the Unity Editor to the front
												116 container Unity transport controls
													117 toggle button Description: Play, Value: 0
													118 toggle button Description: Pause, Value: 1
```

Sample 3, after approximately another 15 seconds, was unchanged:

```text
												115 button Bring the Unity Editor to the front
												116 container Unity transport controls
													117 toggle button Description: Play, Value: 0
													118 toggle button Description: Pause, Value: 1
```

The external pause was reflected, but the externally initiated play state
never produced the required engaged Stop face in any of the three allowed
samples. The combined Part C requirement therefore failed.

Part C overall verdict: FAIL

## Part C-bis (corrected) — UNITY-INITIATED PLAY AFTER EXTERNAL UNPAUSE — PASS

The earlier Part C samples were taken while Unity was intentionally paused.
For this corrected item, the orchestrator unpaused Unity externally before
sampling. The harness issued zero transport clicks throughout the sequence;
the Mafia Game thread was already open and focused, so no navigation click was
needed. The playing state therefore had to arrive through presence.

Sample 1 exposed the correct Stop and Pause faces, but this initial
`get_app_state` serialization did not print separate `Description:` or
`Value:` fields for the toggles:

```text
														115 button Bring the Unity Editor to the front
														116 container Unity transport controls
															117 toggle button Stop
															118 toggle button Pause
```

Sample 2, after approximately 15 seconds, exposed the required fields
explicitly:

```text
														115 button Bring the Unity Editor to the front
														116 container Unity transport controls
															117 toggle button Description: Stop, Value: 1
															118 toggle button Description: Pause, Value: 0
```

The Play/Stop toggle showed the engaged Stop face and the pause toggle was not
engaged. Because the explicit passing state was observed on the second sample,
a third sample was not needed.

Part C-bis verdict: PASS
