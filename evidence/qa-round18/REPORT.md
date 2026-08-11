# QA round 18 report — S14 upgrade offer + legacy migration, live on Mafia Game

Target: `/Applications/DevGame (Alpha).app` with Unity project `Mafia Game`

## Item 0 — PREFLIGHT

**Verdict: PASS**

The required DevGame state call succeeded, and the one benign `Raise` action completed. The intended window identified itself as:

```text
Window: "DevGame (Alpha)", App: DevGame (Alpha).
0 standard window DevGame (Alpha), Secondary Actions: Raise
```

Unity was running on the required project:

```text
Window: "SampleScene - Mafia Game - Windows, Mac, Linux - Unity 6.3 LTS (6000.3.14f1) <Metal>", App: Unity.
0 standard window SampleScene - Mafia Game - Windows, Mac, Linux - Unity 6.3 LTS (6000.3.14f1) <Metal>, URL: file:///Users/pieroherrera/Projects/Mafia%20Game/Assets/Scenes/SampleScene.unity, Secondary Actions: Raise
```

The two-failure blocking rule did not apply.

## Item 1 — BASELINE

**Verdict: FAIL**

Mafia Game was active, and the expected upgrade CTA appeared alongside a working transport cluster:

```text
													221 button New thread in Mafia Game
													232 button Setup Integrations
													233 container Unity transport controls
														234 toggle button Description: Play, Value: 0
														235 toggle button (disabled) Description: Nothing is playing to pause., Value: 0
```

That complete present toolbar cluster anchors the failure: neither its accessible state nor its visible focused state contained the required older-package upgrade copy mentioning `com.ironmind.editor-presence`. The CTA and transport requirements passed, but the required message did not.

## Item 2 — THE CLICK

**Verdict: FAIL**

The first stale element reference was rejected before delivery; after refreshing the state, exactly one UI click reached `Setup Integrations`. Approximately 20 seconds later, the toolbar had temporarily changed to:

```text
													232 button Bring the Unity Editor to the front
													233 container Unity transport controls
														234 toggle button Description: Play, Value: 0
														235 toggle button (disabled) Description: Nothing is playing to pause., Value: 0
```

No error wording was visible, but the notifications regions contained no report text:

```text
					286 container Notifications
					287 container Notifications
```

The required verbatim report sentence, `Removed the old com.ironmind.editor-presence package.`, was therefore not observable and could not be verified.

## Item 3 — SETTLE

**Verdict: FAIL**

Unity itself was quiet with no import/progress dialog after the first half of the settle interval:

```text
Window: "SampleScene - Mafia Game - Windows, Mac, Linux - Unity 6.3 LTS (6000.3.14f1) <Metal>", App: Unity.
```

After the full approximately 60-second settle, DevGame had returned to the upgrade state instead of retaining the required settled state:

```text
													232 button Setup Integrations
													233 container Unity transport controls
														234 toggle button Description: Play, Value: 0
														235 toggle button (disabled) Description: Nothing is playing to pause., Value: 0
```

The present cluster anchors both absence checks: there was no stuck `Checking…`, but the forbidden settled-state `Setup Integrations` CTA was present.

## Item 4 — SELECTION CHIP

**Verdict: FAIL**

Unity's Hierarchy visibly selected `Directional Light` after the required single click. After DevGame was raised and sampled, the composer subtree contained no selection chip:

```text
																		275 text entry area (settable, string) Placeholder: Ask for follow-up changes or attach images, Value:
																		276 text Ask for follow-up changes or attach images
																		277 pop up button Claude Sonnet 5
```

After a five-second confirmation sample, the composer still had no `Directional Light` toggle/chip. The only selection label remaining in DevGame's complete state was old conversation content:

```text
															238 text Main Camera
```

## Item 5 — PLAY/STOP ROUND-TRIP

**Verdict: FAIL**

The DevGame-to-Unity play leg passed. Approximately 10 seconds after clicking Play, the engaged transport was:

```text
													233 container Unity transport controls
														234 toggle button Description: Stop, Value: 1
														235 toggle button Description: Pause, Value: 0
```

Unity's own play toggle was then clicked to stop. The post-click Unity state was visibly stopped: its play control was no longer engaged and the play-mode-only `DontDestroyOnLoad` Hierarchy row seen immediately before the click was gone. Unity was left stopped.

Five seconds after raising DevGame, however, the external stop had not propagated; DevGame still exposed:

```text
													233 container Unity transport controls
														234 toggle button Description: Stop, Value: 1
														235 toggle button Description: Pause, Value: 0
```

The required restored `Play` face was absent.

OVERALL VERDICT: FAIL — the upgrade offer rendered, but its required legacy-package copy/report were not observable, the Setup CTA returned after settling, selection did not publish, and DevGame stayed on Stop after Unity stopped.
