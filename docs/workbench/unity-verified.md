# Unity: verified against a real editor

The last engine binding that could be closed, and it is closed. Verified
against **Unity 6000.3.14f1** headlessly (`-batchmode -executeMethod`), in a
throwaway project outside the repo. The owner's Deepmind project was never
touched — it does not have the package installed.

The package had been "correct by construction, unverified" since it was
written, because Unity was believed absent from the machine.

## What is now observed rather than assumed

| Claim                                                                 | Evidence                                                                                                                                                     |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Installs into a real project                                          | Clean compile, zero `CS####` errors, across four launches                                                                                                    |
| `Selection.selectionChanged` fires and the package's OWN watcher runs | `SessionState` sequence counter — written only by `EditorPresenceSelectionWatcher.PublishCurrentSelection` — incremented 1→2→3→4 across four real selections |
| Frames reach the server                                               | An independent Node WebSocket subscriber, separate bearer token, logged every `presence` frame; items byte-identical to what Unity's builder produced        |
| `ClientWebSocket` works inside Mono                                   | Full connect / send / receive / close cycle, repeatedly                                                                                                      |
| Close codes read correctly                                            | Forced a **real 4401** with a garbage token; `LastErrorMessage` came back exactly `invalid_credential`, matching the server's own reason string              |
| Credential rejection halts retrying                                   | `_credentialRejected` set, **zero** auto-retry events counted over 5 s                                                                                       |
| `Retry()` clears the halt                                             | Reconnected within ~50 ms given a good token                                                                                                                 |
| The pairing redeem works                                              | Exercised through the plugin's own `UnityWebRequest`/`WWWForm` path, not a curl replica                                                                      |

### The load-bearing claim, confirmed

`SessionState` surviving a domain reload was the assumption the whole
reconnect design rests on. A **real** domain reload was triggered mid-run via
`EditorUtility.RequestScriptReload()`: sequence was 3 before and 3 immediately
after. The same `session.id` re-claimed its registry record, with the old entry
removed first — no duplicate chip.

## Prefab selection — three cases, and one product nuance

| Case                               | `identifierType` | id              | path                |
| ---------------------------------- | ---------------- | --------------- | ------------------- |
| Prefab **asset** (Project window)  | 1                | full durable id | `Assets/…/X.prefab` |
| Prefab **instance**, unsaved scene | 0 (`kIDNull`)    | null            | null                |
| Prefab **instance**, saved scene   | 2                | full durable id | **null**            |

All three satisfy the wire contract — the unsaved case still carries a
non-empty `label`, so the server does not drop it.

**The nuance worth knowing:** a prefab instance in the Hierarchy will **never**
carry an asset path, even in a saved scene, because `AssetDatabase.GetAssetPath`
only resolves for the asset itself. Only a prefab selected in the Project
window gets a path. That is Unity's model, not a defect — but it means the chip
for a Hierarchy selection identifies the object by id and scene detail rather
than by file path, and anything downstream that assumes a path will be
disappointed.

## Still genuinely unexercised

- The unrecognised `>= 4000` branch (e.g. 4500) — no real 4500 was triggered.
- IMGUI / UI-Toolkit redraw and tooltip behaviour — needs an interactive
  windowed editor, not batchmode.
- Nested or multi-level prefab hierarchies, and the 64-item truncation path —
  only a flat single-GameObject prefab was tested.
- A full editor restart, as opposed to a same-process domain reload.
- Whether a normal UI workflow can produce an empty `GameObject.name`. The
  fallback mechanism itself is confirmed to work when one is forced.

## Not proven: the pixel

Server receipt is proven from the receiving end. Whether the frame renders as a
literal chip in the browser composer was **not** checked here — that needs a
computer-use pass. The chip renderer was verified independently, and the same
path was observed working end to end with a Godot publisher, so the risk is
low; it is simply not the same claim.

## Hygiene note worth copying

The package's two settings live in a **global** EditorPrefs plist shared by
every Unity project on the machine, not a per-project file. Both keys were
recorded as unset before the test and restored to unset afterwards.
