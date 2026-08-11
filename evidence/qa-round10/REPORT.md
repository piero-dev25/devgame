# QA round 10 report

## Item 0 — PREFLIGHT — PASS

`get_app_state` succeeded on the first attempt. The window exposed `Raise`, and the benign `Raise` secondary action succeeded; the follow-up state remained focused on DevGame.

Initial state excerpt:

```text
Window: "DevGame (Alpha)", App: DevGame (Alpha).
0 standard window DevGame (Alpha), Secondary Actions: Raise
	1 container DevGame (Alpha)
		2 container
			3 HTML content DevGame (Alpha), URL: devgame://app/#/e8123456-0e70-4708-a552-dd4ca66259bb/3fab92de-4666-4bf5-8d6c-95bc0e779bb1
```

Post-`Raise` state excerpt:

```text
The focused UI element is 3 HTML content DevGame (Alpha), URL: devgame://app/#/e8123456-0e70-4708-a552-dd4ca66259bb/3fab92de-4666-4bf5-8d6c-95bc0e779bb1
```

## Item 1 — NON-GAME PROJECT (t3code-fork) — PASS

The t3code-fork thread opened. The header contained the ordinary project-action, open, and git controls and no engine badge or toolbar cluster. The secondary screenshot channel showed the first control's visible label as `Add action`; its accessibility name was anomalously exposed as `Project actions`.

Header state excerpt (the surrounding controls anchor the absence of engine UI):

```text
																		71 button New thread in t3code-fork
																		72 pop up button Thread actions for Upstream Merge Completed and Features Reviewed
																			73 heading Upstream Merge Completed and Features Reviewed, Value: 2
																				74 text Upstream Merge Completed and Features Reviewed
																		75 pop up button Project actions
																		76 container Open in editor
																			77 button Open
																			78 pop up button Copy options
																		79 container Git actions
																			80 button Commit, push & PR
																				81 image
																				82 text Commit, push & PR
																			83 pop up button Git action options
```

The composer contained no `Directional Light` selection chip and no editor-presence status text.

Composer state excerpt (the actual composer controls anchor both absences):

```text
																	210 container
																		211 container
																			212 text This thread is settled Sending a message moves it back to Active in the sidebar.
																			213 button Un-settle
																		214 container
																			215 container
																				216 container
																					217 text entry area (settable, string) Placeholder: Ask for follow-up changes or attach images, Value:

																					218 text Ask for follow-up changes or attach images
																				219 pop up button GPT-5.6-Sol
																					220 text GPT-5.6-Sol
																				221 pop up button Low
																				222 combo box (settable, string) Description: Runtime mode, Value: Full access
																					223 text Full access
																				224 pop up button Context window 54% used
																				225 button (disabled) Send message
																			226 container
																				227 text Local checkout
																				228 combo box (settable, string) workbench/upstream-20260806
																					229 text workbench/upstream-20260806
```

## Item 2 — GAME PROJECT (Mafia Game) — PASS

The Mafia Game thread opened. The observed positive control was the `Unity transport controls` variant, with the companion `Bring the Unity Editor to the front` control. The expected selection appeared immediately, so no delayed resample was necessary.

Header state excerpt:

```text
																	194 button New thread in Mafia Game
																	195 pop up button Thread actions for Explain Selected Main Camera
																		196 heading Explain Selected Main Camera, Value: 2
																			197 text Explain Selected Main Camera
																	198 button Add action
																	199 container Open in editor
																		200 button Open
																		201 pop up button Copy options
																	202 container Git actions
																		203 button Commit
																		204 pop up button Git action options
																	205 button Bring the Unity Editor to the front
																	206 container Unity transport controls
																		207 toggle button Description: Play, Value: 0
																		208 toggle button (disabled) Description: Nothing is playing to pause., Value: 0
```

Composer state excerpt:

```text
																245 container
																	246 container
																		247 toggle button Description: Directional Light, Value: 0
																		248 container
																			249 text entry area (settable, string) Placeholder: Ask for follow-up changes or attach images, Value:

																			250 text Ask for follow-up changes or attach images
																		251 pop up button Claude Sonnet 5
```

## Item 3 — CROSS-PROJECT LEAK — PASS

After returning from Mafia Game to the t3code-fork thread, the composer still contained no `Directional Light` selection chip and no editor-presence text.

State excerpt anchoring the active project and the actual composer region:

```text
																	186 button New thread in t3code-fork
																	187 pop up button Thread actions for Upstream Merge Completed and Features Reviewed
																		188 heading Upstream Merge Completed and Features Reviewed, Value: 2
																			189 text Upstream Merge Completed and Features Reviewed
```

```text
																325 container
																	326 container
																		327 text This thread is settled Sending a message moves it back to Active in the sidebar.
																		328 button Un-settle
																	329 container
																		330 container
																			331 container
																				332 text entry area (settable, string) Placeholder: Ask for follow-up changes or attach images, Value:

																				333 text Ask for follow-up changes or attach images
																			334 pop up button GPT-5.6-Sol
																				335 text GPT-5.6-Sol
																			336 pop up button Low
																			337 combo box (settable, string) Description: Runtime mode, Value: Full access
																				338 text Full access
																			339 pop up button Context window 54% used
																			340 button (disabled) Send message
																		341 container
																			342 text Local checkout
																			343 combo box (settable, string) workbench/upstream-20260806
																				344 text workbench/upstream-20260806
```

Overall verdict: PASS
