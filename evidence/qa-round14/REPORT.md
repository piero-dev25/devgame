# QA round 14 report — corner composition + folded-state clearance re-verification

Target: `DevGame (Alpha)`

## Item 0 — PREFLIGHT

**Verdict: PASS**

The first `get_app_state` call resolved the exact named app on the first attempt and exposed the benign `Raise` secondary action:

```text
Window: "DevGame (Alpha)", App: DevGame (Alpha).
0 standard window DevGame (Alpha), Secondary Actions: Raise
	1 container DevGame (Alpha)
		2 container
			3 HTML content DevGame (Alpha), URL: devgame://app/#/e8123456-0e70-4708-a552-dd4ca66259bb/3fab92de-4666-4bf5-8d6c-95bc0e779bb1
```

The benign `Raise` completed successfully. The follow-up full state again resolved the same window, and its focus line was:

```text
The focused UI element is 3 HTML content DevGame (Alpha), URL: devgame://app/#/e8123456-0e70-4708-a552-dd4ca66259bb/3fab92de-4666-4bf5-8d6c-95bc0e779bb1
```

Neither preflight operation failed, so the two-failure blocking rule did not apply.

## Item 1 — CORNER COMPOSITION AT FIRST PAINT

**Verdict: FAIL**

The primary accessibility order placed the sidebar toggle immediately before the workspace-layout container and then the Sidebar tab group:

```text
					5 container
						6 toggle button Toggle Sidebar
						7 container
							8 button Reset workspace layout
							9 container
								10 container
									11 container
										12 container
											13 container Sidebar
												14 container
													15 tab group
														16 tab (selected) Sidebar, Value: 1
															17 text Sidebar
```

No `link Description: Go to threads` or other brand element appeared between `Toggle Sidebar` and the workspace/tab container; what remained present there was `Reset workspace layout`, followed by the selected `Sidebar` tab.

Secondary screenshot confirmation: the visible left-to-right order was the three traffic lights, the sidebar-toggle glyph, and then the `Sidebar` tab glyph and label. The elements that rendered did not overlap one another, but the required visible `> DevGame` brand was absent, so the prescribed traffic lights → toggle → brand → clear gap → `Sidebar` composition was not present.

## Item 2 — FOLDED-STATE CLEARANCE

**Verdict: FAIL**

One click on the corner sidebar toggle hid the sidebar visually. The full accessibility snapshot retained the hidden Sidebar subtree, so the following present Browser group anchors the tab that became the visual `(0,0)` owner:

```text
											69 container Browser
												70 container
													71 tab group
														72 tab (selected) Browser Close Browser, Value: 1
															73 container
																74 text Browser
																75 button Close Browser
```

Secondary screenshot confirmation: the purple tab underline began at the left window edge, `Browser` occupied the extreme top-left corner where the traffic lights had been, and its close control was followed immediately by the sidebar-toggle glyph inside the same corner region. Neither the traffic lights nor the `> DevGame` brand was visible. The first tab was therefore at the corner, not clear of it.

The second toggle click restored the shown-sidebar layout. The restored primary order was:

```text
					5 container
						6 toggle button Toggle Sidebar, Value: 1
						7 container
							8 button Reset workspace layout
							9 container
								10 container
									11 container
										12 container
											13 container Sidebar
												14 container
													15 tab group
														16 tab (selected) Sidebar, Value: 1
															17 text Sidebar
```

The restored screenshot showed the traffic lights and toggle again, with the `Sidebar` tab label clear to their right and not overlapping them. The first-paint brand absence from item 1 remained.

## Item 3 — RESTORE LAYOUT AND REPORT

**Verdict: PASS**

The sidebar was toggled back on after the folded-state observation. The final state restored `Sidebar` as the leftmost group and retained `Browser` as the next group:

```text
											13 container Sidebar
												14 container
													15 tab group
														16 tab (selected) Sidebar, Value: 1
															17 text Sidebar
											66 container Browser
												67 container
													68 tab group
														69 tab (selected) Browser Close Browser, Value: 1
```

No tab, terminal, git, or project control was operated. The layout was left in its original shown-sidebar state.

OVERALL VERDICT: FAIL
