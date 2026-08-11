# QA round 11 — Part A report

## Item 0 — PREFLIGHT — PASS

`get_app_state` succeeded on the first attempt. The window exposed `Raise`; the benign `Raise` secondary action succeeded, and the follow-up state remained focused on DevGame.

Initial accessibility-state excerpt:

```text
Window: "DevGame (Alpha)", App: DevGame (Alpha).
0 standard window DevGame (Alpha), Secondary Actions: Raise
	1 container DevGame (Alpha)
		2 container
			3 HTML content DevGame (Alpha), URL: devgame://app/#/draft/385129c8-61c2-4775-8b32-40cc45d4083a
```

Post-`Raise` accessibility-state excerpt:

```text
The focused UI element is 3 HTML content DevGame (Alpha), URL: devgame://app/#/draft/385129c8-61c2-4775-8b32-40cc45d4083a
```

## Item 1 — CHROME STRIP — PASS

The topmost content row was the standalone chrome strip, not a dock tab strip. Screenshot vision, used only as the secondary channel, showed the visible `DevGame` brand. In the accessibility tree the brand is exposed as the root link `Description: Go to threads`, next to the sidebar toggle; the workspace/dock container follows beneath it.

Topmost content-row excerpt:

```text
			3 HTML content DevGame (Alpha), URL: devgame://app/#/draft/385129c8-61c2-4775-8b32-40cc45d4083a
				4 container
					5 container
						6 toggle button Toggle Sidebar, Value: 1
						7 link Description: Go to threads, Value: devgame://app/#/
					8 container
						9 button Reset workspace layout
```

Below that row, the dock exposed the required tab headers. Verbatim group excerpts, in tree order:

```text
									14 container Sidebar
										15 container
											16 tab group
												17 tab (selected) Sidebar, Value: 1
													18 text Sidebar
```

```text
									67 container Browser
										68 container
											69 tab group
												70 tab (selected) Browser Close Browser, Value: 1
													71 container
														72 text Browser
														73 button Close Browser
```

```text
									78 container
										79 container Terminal
											80 container
												81 tab group
													82 tab (settable, integer) Files, Value: 0
														83 text Files
													84 tab (selected) Terminal Close Terminal, Value: 1
														85 container
															86 text Terminal
															87 button Close Terminal
													88 tab (settable, integer) Diff, Value: 0
														89 text Diff
```

```text
										94 container Chat
											95 container
												96 tab group
													97 tab (selected) Chat, Value: 1
														98 text Chat
```

## Item 2 — SIDEBAR TOGGLE — PASS

After one click on the strip toggle, the sidebar column disappeared visually; the remaining visible dock began with Browser and retained the Files/Terminal/Diff and Chat groups. The full accessibility snapshot retained the hidden Sidebar subtree, so the visual absence is a secondary-screenshot judgment; the following verbatim lines anchor the chrome and dock elements that remained present:

```text
					5 container
						6 toggle button Toggle Sidebar, Value: 1
						7 link Description: Go to threads, Value: devgame://app/#/
					8 container
						9 button Reset workspace layout
```

```text
									70 container Browser
										71 container
											72 tab group
												73 tab (selected) Browser Close Browser, Value: 1
```

```text
										82 container Terminal
											83 container
												84 tab group
													85 tab (settable, integer) Files, Value: 0
													87 tab (selected) Terminal Close Terminal, Value: 1
													91 tab (settable, integer) Diff, Value: 0
```

```text
										97 container Chat
											98 container
												99 tab group
													100 tab (selected) Chat, Value: 1
```

After the second click, the sidebar returned as the leftmost sibling column. It was not inserted into Chat's tab group:

```text
								13 container
									14 container Sidebar
										15 container
											16 tab group
												17 tab (selected) Sidebar, Value: 1
													18 text Sidebar
```

```text
									67 container Browser
										68 container
											69 tab group
												70 tab (selected) Browser Close Browser, Value: 1
```

```text
									78 container
										79 container Terminal
											80 container
												81 tab group
										94 container Chat
											95 container
												96 tab group
													97 tab (selected) Chat, Value: 1
```

## Item 3 — BASELINE — FAIL

The Mafia Game thread opened and, after the initial status check resolved, the Unity transport correctly showed the stopped Play face and disabled pause control. However, the required `Directional Light` chip was absent from the composer in both the accessibility state and the secondary screenshot.

Transport excerpt:

```text
														115 button Bring the Unity Editor to the front
														116 container Unity transport controls
															117 toggle button Description: Play, Value: 0
															118 toggle button (disabled) Description: Nothing is playing to pause., Value: 0
```

Composer excerpt anchoring the chip absence with the controls actually present:

```text
													155 container
														156 container
															157 container
																158 text entry area (settable, string) Placeholder: Ask for follow-up changes or attach images, Value:

																159 text Ask for follow-up changes or attach images
															160 pop up button Claude Sonnet 5
																161 text Claude Sonnet 5
															162 pop up button More composer controls
															163 pop up button Context window 5.3% used
															164 button (disabled) Send message
```

## Item 4 — HARNESS PLAY — PASS

Exactly one harness click was issued on the Play toggle. A local REPL binding error occurred after that click and before the same call could capture state; no second click was issued. The immediate follow-up sample already showed the engaged Stop face. After approximately 20 seconds, the final sample still showed the engaged Stop face, confirming play state survived the Unity domain reload and presence reconnect.

Immediate toolbar sample:

```text
														116 container Unity transport controls
															117 toggle button Description: Stop, Value: 1
															118 toggle button Description: Pause, Value: 0
```

Final toolbar sample after approximately 20 seconds:

```text
														116 container Unity transport controls
															117 toggle button Description: Stop, Value: 1
															118 toggle button Description: Pause, Value: 0
```

## Item 5 — REPORT — PASS

This artifact records Part A only and ends with Part A's aggregate verdict.

Part A overall verdict: FAIL
