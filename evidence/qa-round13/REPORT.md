# QA round 13 report — corner clearance fix re-verification

Target: `DevGame (Alpha)`

## Item 0 — PREFLIGHT

**Verdict: PASS**

The first `get_app_state` call resolved the exact target, and the benign `Raise` action completed successfully on its standard window.

Verbatim initial state excerpt:

```text
Window: "DevGame (Alpha)", App: DevGame (Alpha).
0 standard window DevGame (Alpha), Secondary Actions: Raise
```

Verbatim post-Raise state excerpt:

```text
The following is a diff from the previous accessibility tree for Window: "DevGame (Alpha)" with ~ and + representing changed and added elements, respectively.
~							7 toggle button Toggle Sidebar, Value: 1
```

No capability error was present; what was present was the exact named window and its exposed `Raise` secondary action.

## Item 1 — FIRST-PAINT CLEARANCE

**Verdict: PASS**

The untouched first-paint state placed the corner controls before the Sidebar group's tab strip:

```text
6 container
	7 toggle button Toggle Sidebar
	8 link Description: Go to threads, Value: devgame://app/#/
9 container
	10 button Reset workspace layout
	11 container
		12 container
			13 container
				14 container
					15 container Sidebar
						16 container
							17 tab group
								18 tab (selected) Sidebar, Value: 1
									19 text Sidebar
```

Secondary screenshot confirmation: the top band visibly read as the `> DevGame` brand plus the sidebar-toggle icon, followed by a clear gap and then the `Sidebar` label. The label began to the right of the corner controls and did not intersect them or sit underneath them. No overlapping `Sidebar` label was present; what was present was one fully legible `Sidebar` label to the right of the toggle.

## Item 2 — HIDDEN-STATE HANDOFF

**Verdict: FAIL**

Initial shown-state excerpt:

```text
7 toggle button Toggle Sidebar, Value: 1
15 container Sidebar
	16 container
		17 tab group
			18 tab (selected) Sidebar, Value: 1
				19 text Sidebar
```

After the hide click, the state remained shown instead of handing the first non-Sidebar group to `(0,0)`:

```text
7 toggle button Toggle Sidebar, Value: 1
15 container Sidebar
	16 container
		17 tab group
			18 tab (selected) Sidebar, Value: 1
				19 text Sidebar
```

A precise click at the visible corner toggle's center was intercepted by the Sidebar tab; the returned focus evidence was:

```text
The focused UI element is 18 tab (selected) Sidebar, Value: 1
```

After the required show-again click, the state was still the same shown state:

```text
7 toggle button Toggle Sidebar, Value: 1
15 container Sidebar
	16 container
		17 tab group
			18 tab (selected) Sidebar, Value: 1
				19 text Sidebar
```

No hidden-state `(0,0)` tab strip appeared; what remained present after both clicks was the selected `Sidebar` tab and the full `container Sidebar`. The handoff clearance postcondition therefore could not be satisfied.

## Item 3 — TAB-TARGETED RETURN DROP

**Verdict: FAIL**

Before the drop, the Browser group contained `Browser, Diff`, while the home group contained `Files, Terminal`:

```text
73 tab group
	74 tab (settable, integer) Browser, Value: 0
		75 text Browser
	76 tab (selected) Diff Close Diff, Value: 1
		77 container
			78 text Diff
			79 button Close Diff
85 tab group
	86 tab (settable, integer) Files, Value: 0
		87 text Files
	88 tab (selected) Terminal Close Terminal, Value: 1
		89 container
			90 text Terminal
			91 button Close Terminal
```

After dragging the `Diff` label and releasing precisely on the `Terminal` label, the tab lists were unchanged:

```text
73 tab group
	74 tab (settable, integer) Browser, Value: 0
		75 text Browser
	76 tab (selected) Diff Close Diff, Value: 1
		77 container
			78 text Diff
			79 button Close Diff
85 tab group
	86 tab (settable, integer) Files, Value: 0
		87 text Files
	88 tab (selected) Terminal Close Terminal, Value: 1
		89 container
			90 text Terminal
			91 button Close Terminal
```

No `Diff` tab appeared in the Files/Terminal group; what remained present was `Browser, Diff` in the Browser group and `Files, Terminal` in the home group.

OVERALL VERDICT: FAIL
