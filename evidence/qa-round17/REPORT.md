# QA round 17 report — renamed package migration + zero-touch install, live on Mafia Game

Target: `/Applications/DevGame (Alpha).app` with Unity project `Mafia Game`

## Item 0 — PREFLIGHT

**Verdict: PASS**

The display-name lookup first resolved a second, same-named Electron shell, but both the requested state call and benign `Raise` action completed. The ambiguous state identified itself as:

```text
Window: "Electron", App: DevGame (Alpha).
0 standard window Electron, Secondary Actions: Raise
```

Using the handoff's exact installed-app path then resolved the intended DevGame window and exposed its app content:

```text
Window: "DevGame (Alpha)", App: DevGame (Alpha).
0 standard window DevGame (Alpha), Secondary Actions: Raise
	1 container DevGame (Alpha)
		2 container
			3 HTML content DevGame (Alpha), URL: devgame://app/#/draft/385129c8-61c2-4775-8b32-40cc45d4083a
```

Unity was running on the required project:

```text
Window: "SampleScene - Mafia Game - Windows, Mac, Linux - Unity 6.3 LTS (6000.3.14f1) <Metal>", App: Unity.
0 standard window SampleScene - Mafia Game - Windows, Mac, Linux - Unity 6.3 LTS (6000.3.14f1) <Metal>, URL: file:///Users/pieroherrera/Projects/Mafia%20Game/Assets/Scenes/SampleScene.unity, Secondary Actions: Raise
```

No Computer Use operation failed, so the two-failure blocking rule did not apply.

## Item 1 — BASELINE

**Verdict: FAIL**

Mafia Game was made active, as shown by both project-specific controls:

```text
																	224 button New thread in Mafia Game
															98 search text field (settable, string) Description: Search Mafia Game files, Placeholder: Search files
```

The expected `Setup Integrations` control was not offered. The toolbar's verbatim Unity cluster instead contained only the Unity raise control and the quiet transport controls:

```text
																	235 button Bring the Unity Editor to the front
																	236 container Unity transport controls
																		237 toggle button Description: Play, Value: 0
																		238 toggle button (disabled) Description: Nothing is playing to pause., Value: 0
```

That present cluster anchors the absence claim: there was no `Setup Integrations`-labeled element anywhere in the complete sampled state.

## Item 2 — THE CLICK

**Verdict: FAIL**

Because item 1 exposed no `Setup Integrations` target, there was no valid control to click once. I did not substitute another control. After approximately 20 seconds, the sampled toolbar still exposed only:

```text
																	235 button Bring the Unity Editor to the front
																	236 container Unity transport controls
																		237 toggle button Description: Play, Value: 0
																		238 toggle button (disabled) Description: Nothing is playing to pause., Value: 0
```

The notifications region was present but contained no toast or install report text:

```text
					289 container Notifications
					290 container Notifications
```

Accordingly, the required sentence `Removed the old com.ironmind.editor-presence package.` was not reported, and the migration/install proof failed.

## Item 3 — SETTLE

**Verdict: PASS**

After the approximately 60-second settle window, Unity showed no import/progress dialog, and DevGame presented the required quiet Play face. The complete toolbar cluster was:

```text
																	235 button Bring the Unity Editor to the front
																	236 container Unity transport controls
																		237 toggle button Description: Play, Value: 0
																		238 toggle button (disabled) Description: Nothing is playing to pause., Value: 0
```

This present cluster anchors the absence claims: the sampled state contained neither a Setup CTA nor a stuck `Checking…` status. This visible-state pass does not repair item 2's missing migration action.

## Item 4 — SELECTION CHIP

**Verdict: PASS**

After single-clicking `Directional Light` in Unity's Hierarchy and raising DevGame, the composer exposed the selection chip verbatim:

```text
																			277 toggle button Description: Directional Light, Value: 0
```

## Item 5 — PLAY/STOP ROUND-TRIP

**Verdict: PASS**

Approximately 10 seconds after clicking Play in DevGame, the engaged transport sample was:

```text
																	236 container Unity transport controls
																		237 toggle button Description: Stop, Value: 1
																		238 toggle button Description: Pause, Value: 0
```

After clicking Unity's own play toggle to stop, raising DevGame, and waiting approximately five seconds, the external stop was reflected:

```text
																	236 container Unity transport controls
																		237 toggle button Description: Play, Value: 0
																		238 toggle button (disabled) Description: Nothing is playing to pause., Value: 0
```

Unity was left stopped, and the dock layout was not changed.

OVERALL VERDICT: FAIL — the required migration/install path could not be initiated because `Setup Integrations` was absent, so the legacy-removal report was never produced.
