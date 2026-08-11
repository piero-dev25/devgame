# QA round 19 report — one-click legacy migration end to end

Target: `/Applications/DevGame (Alpha).app` with Unity project `Mafia Game`

## Item 0 — PREFLIGHT

**Verdict: PASS**

The required DevGame state read succeeded on the first attempt, and the benign `Raise` action completed:

```text
Window: "DevGame (Alpha)", App: DevGame (Alpha).
0 standard window DevGame (Alpha), Secondary Actions: Raise
```

Unity was running on the required Mafia Game project:

```text
Window: "SampleScene - Mafia Game - Windows, Mac, Linux - Unity 6.3 LTS (6000.3.14f1) <Metal>", App: Unity.
0 standard window SampleScene - Mafia Game - Windows, Mac, Linux - Unity 6.3 LTS (6000.3.14f1) <Metal>, URL: file:///Users/pieroherrera/Projects/Mafia%20Game/Assets/Scenes/SampleScene.unity, Secondary Actions: Raise
```

The two-failure blocking rule did not apply.

## Item 1 — BASELINE

**Verdict: PASS**

Mafia Game was active, and the Setup CTA was offered alongside the settled transport cluster:

```text
													221 button New thread in Mafia Game
													232 button Setup Integrations
													233 container Unity transport controls
														234 toggle button Description: Play, Value: 0
														235 toggle button (disabled) Description: Nothing is playing to pause., Value: 0
```

The S14 upgrade copy was not present in the accessibility tree; per the handoff, that absence is not a failure for this round.

## Item 2 — THE CLICK

**Verdict: PASS**

The preliminary action call was rejected as stale before delivery; after refreshing state, exactly one UI click reached `Setup Integrations`.

At approximately five seconds, the notification was captured with no error wording:

```text
288 container Unity integrations installed
	289 button Dismiss notification
	290 heading Unity integrations installed, Value: 2
		291 text Unity integrations installed
	292 text com.unity.pipeline@0.4.0-exp.1 was already installed. Embedded com.devgame.editor-presence@0.4.0 under Packages/. A fresh pairing credential was handed off; pairing will finish automatically in Unity. Removed the old com.ironmind.editor-presence package.
```

At approximately twenty seconds, the notification had auto-dismissed. The present toolbar still read:

```text
232 button Setup Integrations
233 container Unity transport controls
	234 toggle button Description: Play, Value: 0
	235 toggle button (disabled) Description: Nothing is playing to pause., Value: 0
```

No error wording appeared in either sample.

## Item 3 — SETTLE

**Verdict: PASS**

The approximately sixty-second sample was already settled, so the handoff's early-stop rule applied. No import/progress dialog was observed. The final toolbar cluster was:

```text
232 button Bring the Unity Editor to the front
233 container Unity transport controls
	234 toggle button Description: Play, Value: 0
	235 toggle button (disabled) Description: Nothing is playing to pause., Value: 0
236 container
```

That complete present cluster anchors both absence checks: the state contained neither `Setup Integrations` nor a stuck `Checking…` label.

## Item 4 — SELECTION CHIP

**Verdict: PASS**

After Unity's Hierarchy received a single click on `Directional Light` and DevGame was raised, the composer exposed the required chip:

```text
274 toggle button Description: Directional Light, Value: 0
```

## Item 5 — PLAY/STOP ROUND-TRIP

**Verdict: PASS**

Approximately ten seconds after clicking Play in DevGame, the engaged transport was:

```text
233 container Unity transport controls
	234 toggle button Description: Stop, Value: 1
	235 toggle button Description: Pause, Value: 0
```

Unity's own play toggle was then clicked to stop. Approximately ten seconds after raising DevGame, the transport had returned to:

```text
233 container Unity transport controls
	234 toggle button Description: Play, Value: 0
	235 toggle button (disabled) Description: Nothing is playing to pause., Value: 0
```

The restored Play face anchors the stopped state; Unity was left stopped.

OVERALL VERDICT: PASS — the one-click migration reported legacy-package removal, settled without the Setup CTA, paired selection presence, and completed the Play/Stop round-trip.
