# QA round 15 report — brand restored: composition + folded clearance

Target: `DevGame (Alpha)`

## Item 0 — PREFLIGHT

**Verdict: PASS**

The first `get_app_state` call resolved the exact named app on the first attempt and exposed the benign `Raise` secondary action:

```text
Window: "DevGame (Alpha)", App: DevGame (Alpha).
0 standard window DevGame (Alpha), Secondary Actions: Raise
	1 container DevGame (Alpha)
		2 container
			3 HTML content DevGame (Alpha), URL: devgame://app/#/draft/385129c8-61c2-4775-8b32-40cc45d4083a
```

The benign `Raise` completed successfully. The follow-up full state again resolved the same window and ended with:

```text
The focused UI element is 3 HTML content DevGame (Alpha), URL: devgame://app/#/draft/385129c8-61c2-4775-8b32-40cc45d4083a
```

Neither preflight operation failed, so the two-failure blocking rule did not apply.

## Item 1 — CORNER COMPOSITION AT FIRST PAINT

**Verdict: FAIL**

Before any layout mutation, the primary accessibility order placed the sidebar toggle immediately before the workspace-layout container and the Sidebar tab group:

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

No `link Description: Go to threads` or other brand element appeared between `Toggle Sidebar` and the workspace/tab container; what was present there was `Reset workspace layout`, followed by the selected `Sidebar` tab.

Screenshot confirmation: the visible left-to-right sequence was traffic lights → sidebar-toggle glyph → an empty region → `Sidebar`. The screenshot did **not** paint `> DevGame` anywhere in that region. Thus the required traffic lights → toggle → `> DevGame` → clear gap → `Sidebar` composition was absent; this reproduces the present-but-unpainted brand defect rather than confirming a visible restoration.

## Item 2 — FOLDED-STATE CLEARANCE

**Verdict: FAIL**

Clicking the corner sidebar toggle hid the sidebar visually. The full accessibility snapshot retained the hidden Sidebar subtree, so the following present Browser group anchors the first tab that became the visual `(0,0)` owner:

```text
						6 toggle button Toggle Sidebar, Value: 1
						7 container
							8 button Reset workspace layout
```

```text
											69 container Browser
												70 container
													71 tab group
														72 tab (selected) Browser Close Browser, Value: 1
															73 container
																74 text Browser
																75 button Close Browser
```

Screenshot confirmation: `Browser` began at the extreme left in the traffic-light corner, followed by its close control and the sidebar-toggle glyph. The traffic lights and `> DevGame` were not visible. The first tab was therefore in the corner rather than to the right of a visible brand with clear space.

The first AX-targeted show-again click and one precise click on the visible toggle left the screenshot folded. The default `mod+b` sidebar command ultimately restored the original shown-sidebar state. The restored primary order was:

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

The restored screenshot showed traffic lights → toggle → empty gap → `Sidebar`; the Sidebar tab was clear again, but the brand remained unpainted.

## Item 3 — LEAVE THE LAYOUT AS FOUND

**Verdict: PASS**

The final screenshot and full state restored the original shown-sidebar layout, with Sidebar again the leftmost group and Browser the next group:

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

No app Terminal or git control was operated, and no prohibited surface or path was accessed.

OVERALL VERDICT: FAIL
