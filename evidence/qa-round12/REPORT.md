# QA round 12 — unified top band

## 0. PREFLIGHT — PASS

The first `get_app_state` succeeded and exposed the benign `Raise` action:

```text
Window: "DevGame (Alpha)", App: DevGame (Alpha).
0 standard window DevGame (Alpha), Secondary Actions: Raise
```

Invoking `Raise` succeeded. The next full state again began:

```text
Window: "DevGame (Alpha)", App: DevGame (Alpha).
0 standard window DevGame (Alpha), Secondary Actions: Raise
```

## 1. ONE BAND — FAIL

The initial topmost content region exposed the compact corner controls and every dock tab strip:

```text
						6 container
							7 toggle button Toggle Sidebar, Value: 1
							8 link Description: Go to threads, Value: devgame://app/#/
```

```text
											17 tab group
												18 tab (selected) Sidebar, Value: 1
													19 text Sidebar
```

```text
									68 container Browser
										70 tab group
											71 tab (selected) Browser Close Browser, Value: 1
													73 text Browser
```

```text
											82 tab group
												83 tab (settable, integer) Files, Value: 0
													84 text Files
												85 tab (selected) Terminal Close Terminal, Value: 1
														87 text Terminal
												89 tab (settable, integer) Diff, Value: 0
													90 text Diff
```

```text
											97 tab group
												98 tab (selected) Chat, Value: 1
													99 text Chat
```

No separate full-width strip row was present above those tabs. However, in the initial `get_app_state` screenshot the `Sidebar` tab text occupied the corner region and visibly intersected the `> DevGame` brand instead of beginning to its right. Because the first tab was not given clear space to the right of the corner, the complete item fails.

## 2. DOCK BOTTOM — PASS

The baseline screenshot showed the dock surfaces reaching the window bottom. The chat composer was fully visible, including its complete lower selector row; the sidebar also exposed its bottom `Settings` control. The lowest relevant accessibility elements were:

```text
																		124 container
																			125 text entry area (settable, string) Placeholder: Ask for follow-up changes or attach images, Value:

																			126 text Ask for follow-up changes or attach images
																		127 pop up button GPT-5.6-Sol
																			128 text GPT-5.6-Sol
																		129 pop up button More composer controls
																		130 button (disabled) Send message
																	131 container
																		132 combo box (settable, string) Description: Workspace, Value: Current checkout
																			133 text Current checkout
																		134 combo box (settable, string) workbench/upstream-20260806
																			135 text workbench/upstream-20260806
```

```text
												66 content list
													67 button Settings
```

No composer edge or lower control was clipped.

## 3. TAB DND INTACT — FAIL

Before the drag, the Browser group contained only `Browser`, while the adjacent group contained `Files`, `Terminal`, and `Diff`:

```text
									68 container Browser
										70 tab group
											71 tab (selected) Browser Close Browser, Value: 1
													73 text Browser
```

```text
											82 tab group
												83 tab (settable, integer) Files, Value: 0
													84 text Files
												85 tab (selected) Terminal Close Terminal, Value: 1
														87 text Terminal
												89 tab (settable, integer) Diff, Value: 0
													90 text Diff
```

Dropping `Diff` directly onto the `Browser` tab succeeded. Afterward, the Browser group was:

```text
									68 container Diff
										70 tab group
											71 tab (settable, integer) Browser Close Browser, Value: 0
													73 text Browser
											75 tab (selected) Diff Close Diff, Value: 1
													77 text Diff
```

During a real return drag, a translucent lavender fill and sharp purple outline covered the candidate pane, with the drag marker over `Diff`: the expected drop overlay appeared. It had no dedicated AX label; the affected pane remained anchored by this verbatim excerpt:

```text
									68 container Diff
														71 tab (settable, integer) Browser, Value: 0
															72 text Browser
														73 tab (selected) Diff Close Diff, Value: 1
																75 text Diff
																76 button Close Diff
										77 container Diff Close Diff
The focused UI element is 73 tab (selected) Diff Close Diff, Value: 1
```

The return drop onto the original group's tabs did not succeed: after the attempted return, `Diff` was still grouped with `Browser`, while the original group still contained only `Files` and `Terminal`:

```text
									68 container Diff
										70 tab group
											71 tab (settable, integer) Browser, Value: 0
												72 text Browser
											73 tab (selected) Diff Close Diff, Value: 1
													75 text Diff
									80 container Terminal
											82 tab group
												83 tab (settable, integer) Files, Value: 0
													84 text Files
												85 tab (selected) Terminal Close Terminal, Value: 1
														87 text Terminal
```

The forward no-drag-island drop works, but the required return does not, so the item fails and the final layout retains `Diff` beside `Browser`.

## 4. SIDEBAR TOGGLE — FAIL

The first toggle activation hid the sidebar column. The Browser/Diff group moved into the left slot; its tab strip was:

```text
							7 toggle button Toggle Sidebar, Value: 1
							8 link Description: Go to threads, Value: devgame://app/#/
									71 container Diff
										73 tab group
											74 tab (settable, integer) Browser, Value: 0
												75 text Browser
											76 tab (selected) Diff Close Diff, Value: 1
													78 text Diff
													79 button Close Diff
```

The hidden-state screenshot showed this new corner-owner strip occupying the corner region: the `Diff` text intersected `> DevGame`, and `Browser` did not have clear visible placement to the right of the corner. Thus the corner clearance did not follow the group at `(0,0)`.

The second toggle activation returned the sidebar column to the left slot. The final corner-owner strip was restored as:

```text
									15 container Sidebar
										16 container
											17 tab group
												18 tab (selected) Sidebar, Value: 1
													19 text Sidebar
```

The restored `Sidebar` label was visibly clear to the right of `> DevGame` and the toggle. The leave/return behavior passed, but the required hidden-state corner handoff did not, so the complete item fails.

OVERALL VERDICT: FAIL
