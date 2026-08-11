# QA round 11 — Part D report

## Item 1 — PRESENCE OUTAGE OBSERVATION

No PASS/FAIL verdict is assigned to this documented honest-bound observation.
The orchestrator quit the Unity editor entirely at 17:13:36 while Unity was
playing and the harness was idle. Part D issued no UI action and took one
read-only `get_app_state` sample of `DevGame (Alpha)`.

The Mafia Game thread was open in the sample:

```text
			3 HTML content DevGame (Alpha), URL: devgame://app/#/e8123456-0e70-4708-a552-dd4ca66259bb/3fab92de-4666-4bf5-8d6c-95bc0e779bb1
												104 button New thread in Mafia Game
												105 pop up button Thread actions for Explain Selected Main Camera
													106 heading Explain Selected Main Camera
```

With editor presence gone, the transport rendered the Stop face, consistent
with falling back to the last harness command echo (`playing`). The current
accessibility-state serialization exposed the controls' accessible names
inline and did not print separate `Description:` or `Value:` fields; none are
inferred here.

```text
												115 button Bring the Unity Editor to the front
												116 container Unity transport controls
													117 toggle button Stop
													118 toggle button Pause
```

The `Directional Light` composer chip did **not** disappear in this sample; it
remained present immediately before the composer text entry:

```text
											155 container
												156 container
													157 toggle button Directional Light
													158 container
														159 text entry area (settable, string) Placeholder: Ask for follow-up changes or attach images, Value:
```

Part D overall note: After Unity quit, DevGame rendered the stale playing Stop face and retained the Directional Light chip.
