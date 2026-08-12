# Unity engine integration — HANDOFF.md Q40–44 (Game Engine block)

**Status:** Research note, answering the whole Game Engine block (§66 Q40–45) that
`GENERATION_ARCHITECTURE.md` DRAFT 1 left unwritten (its §9 defers to "a real Unity
lane"). Nothing here changes running state; two read-only probes and one screenshot
capture were run live against `~/Projects/Mafia Game`'s Unity Editor (6000.3.14f1),
under the task's explicit read-only bound.

**Repo:** `~/Projects/t3code-fork`, branch `workbench/upstream-20260806`.
**Charter:** `docs/v2/HANDOFF.md` §64 (Unity review loop), §66 Q40–45, §69 (success
criterion ends in a Game View screenshot).
**Evidence base:**

| Cite         | Source                                                                                                                                                                                                                              |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **CODE**     | `apps/server/src/unity/UnityPipelineClient.ts` (910 lines, read in full)                                                                                                                                                            |
| **ARCH**     | `docs/workbench/unity-integration-architecture.md` (1850 lines; read through §5)                                                                                                                                                    |
| **VERIF**    | `docs/workbench/unity-verified.md`                                                                                                                                                                                                  |
| **UNVER**    | `unity/editor-presence-UNVERIFIED.md`                                                                                                                                                                                               |
| **LIVE**     | `unity list --json` / `unity command <name> ... --json` run against the live Mafia Game Editor (127.0.0.1:7800), 2026-08-11, this session — full 140-tool listing captured, plus two read-only C# evals and two screenshot captures |
| **UNITYDOC** | Unity Manual / Scripting API (light web reference, cited inline where used)                                                                                                                                                         |

Every claim below is marked **VERIFIED** (read from this repo's code, or observed
live this session, cited) or **INFERRED** (reasoned, not observed). Where the two
disagree — this repo's _chosen_ automation surface vs. what the live Editor's CLI
_can_ do — that gap is the central finding, not a footnote.

---

## 0. The one-paragraph answer

The live Unity Editor, through `com.unity.pipeline`'s HTTP server, exposes **140
commands** covering nearly everything the vertical spike needs — asset import,
prefab creation, component/collider attachment, transform placement, Game View
capture, console reads, and an arbitrary-C# `eval` escape hatch. **This repo's own
TypeScript client wires almost none of that.** `UnityPipelineClient.ts` deliberately
implements only `status/play/stop/pause/list/install/open/packageResolve` and its
doc comment states, in scope: _"No `eval`/`eval_file` (arbitrary C# execution, not
bounded by `set_authoring_root` — explicitly out per the owner's ruling)"_ (CODE:1-48).
So the gap Q41–44 need to close is not "can Unity do this" (yes) but "what do we
build, and under what approval gate, to let an agent reach the 130+ tools this
client doesn't yet touch" — and specifically whether `eval` is ever back in scope,
because for one load-bearing fact (mesh triangle/vertex/bounds/rig data — §42) **no
named tool exists**; only `eval` can read it today.

---

## 1. Q40 — Minimum Unity import contract

### 1.1 What Unity's own auto-import gives (UNITYDOC, light web reference)

Dropping a `.glb`/`.gltf`/`.fbx` into `Assets/` (or a package under `Packages/`,
though the CLI confines authoring to `Assets/` by default — §1.3 below) triggers
Unity's `AssetPostprocessor` pipeline automatically, on the next `AssetDatabase`
refresh:

- **Mesh** — parsed, triangulated, given a `Mesh` asset (or sub-assets, one per
  mesh in the source file) with normals/tangents/UVs per the ModelImporter's
  default settings (`Normals: Import`, `Tangents: Calculate Tangent Space`).
- **Materials** — glTF materials import as native Unity `Material` sub-assets
  (`materialImportMode` governs whether they're extracted or left embedded) with a
  best-effort PBR mapping (glTF metallic-roughness → URP/Lit or Standard, depending
  on the active render pipeline).
- **Textures** — embedded or referenced glTF textures import as `Texture2D`
  sub-assets or standalone files, with Unity's _default_ compression/max-size
  settings applied — not the ones a target platform budget would want (this is
  exactly CHARTER §63's "18,000 triangles / 4096 texture, want <5,000 / 1024"
  gap: Unity's default import is never budget-aware).
- **Animation clips**, if the source file carries them and `Animation Type` is not
  `None` — imported as sub-assets of the same file.
- **Rig**, if skinning data is present — Unity infers `Generic` or `Humanoid`
  (Humanoid requires a recognizable bone hierarchy; a generated prop typically has
  none, so `animationType` will read `None` or `Generic` — verified live for a
  static prop-shaped mesh, §3.2 below).

### 1.2 What needs an explicit step (none of this is automatic)

- **Collider** — a `.glb` import never creates a `Collider` component; nothing
  is placed in a scene by importing an asset. A `BoxCollider`/`MeshCollider`/etc.
  must be added to a GameObject via `add_component` (§2.2) after the mesh is
  instantiated into a scene or prefab.
- **Prefab** — import produces an _asset_, not a scene object and not a prefab.
  Turning it into a reusable placed object is `create_prefab` (source GameObject
  → prefab asset) or `instantiate_prefab` if a prefab already exists.
- **Scene placement** — placing the imported mesh (or a prefab built from it) into
  an open scene is a separate step (`instantiate_prefab` targeting a scene, or
  `create_gameobject`/`create_gameobjects` + manually assigning the mesh), followed
  by `set_transform` for position/rotation/scale.
- **Material reassignment for the target render pipeline** — glTF import's PBR
  mapping is a best-effort guess; a project on URP may need `set_material_properties`
  to reassign the shader explicitly (`set_material_properties` accepts a `shader`
  param precisely for this — §2.2's tool table).

### 1.3 This repo's own Unity knowledge — the authoring-root confinement

**VERIFIED, live, this session.** The CLI's built-in tools (everything _except_
`eval`/`eval_file`) are confined to a project's `Assets/` root by
`set_authoring_root` (default `"Assets"`). Confirmed by direct failure:

```
$ unity command get_import_settings "Packages/com.unity.render-pipelines.core/…/UnityMaterialBall.fbx" \
    --project-path "/Users/pieroherrera/Projects/Mafia Game" --json
COMMAND_FAILED: Asset '…' is outside the authoring root 'Assets'
```

This is a real, load-bearing constraint for the generation pipeline: an
`import_asset` call must land the generated `.glb` **under `Assets/`** (or a
subfolder the harness sets as the authoring root, e.g. `Assets/AgentWork/` — the
tool description for `set_authoring_root` names exactly this pattern: _"the base
folder (under Assets/) that bare authoring paths resolve against and are confined
to"_). `eval`, by contrast, is **not** confined — it read a mesh under `Packages/`
with no error (§3.1). That confinement asymmetry is exactly what `UnityPipelineClient.ts`'s
doc comment cites as the reason `eval` is out of scope (CODE:39-47): the one
tool that can do anything is also the one tool with no folder fence around it.

**No code in this repo reads `Packages/manifest.json` or is `.meta`-aware**
(ARCH §2, VERIFIED by exhaustive grep there). So today, nothing in the harness
itself validates a `.glb` landed correctly beyond what the Pipeline CLI's own
`import_asset` return value reports.

---

## 2. Q41 — What Unity CLI / `com.unity.pipeline` can automate

### 2.1 How this was enumerated

`unity list --json` run **cwd-pinned inside `~/Projects/Mafia Game`**, per the
task's mandatory pinning (an un-pinned invocation from this repo's own checkout
returns `COMMAND_FAILED: Multiple Unity Editor instances found` — VERIFIED, this
session — because a second live Editor, `CurseJar` on port 7801, is also running
on this machine; `--project-path` or a correctly-pinned cwd is what disambiguates,
not just being "in a Unity project somewhere"). Result: **140 tools, one flat
`"built-in"` group** (no `"pipeline"` vs. other grouping exists in this version),
target `127.0.0.1:7800`, `Mafia Game`.

### 2.2 The tool surface relevant to the vertical spike

| Need                            | Tool(s)                                                                                                                                                                                                                               | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Import / refresh assets**     | `import_asset` (copy external file → path under authoring root, then import), `package_resolve` (force-refresh from manifest, may trigger recompile), `package_add`/`package_remove`/`package_list`/`package_status`/`package_search` | `import_asset` is exactly the "copy generated `.glb` into `Assets/` and import" primitive Q40/§9 of `GENERATION_ARCHITECTURE.md` needs. `package_resolve` is already wired in this repo's client (CODE:558-580) for a _different_ purpose (forcing an embedded package to load) but is the same mechanism CHARTER §41 asks about.                                                                                                                                                                                                                                                                                              |
| **Create prefabs**              | `create_prefab` (GameObject → prefab asset), `create_prefab_variant`, `instantiate_prefab`, `save_prefab_contents` (isolated prefab-stage edit), `unpack_prefab`, `apply_prefab_overrides`, `revert_prefab_overrides`                 | `create_prefab` requires an existing GameObject (`source: objectref`) — so the order is always instantiate/create → configure → `create_prefab`, not the reverse.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Add colliders**               | **No dedicated `add_collider` tool.** `add_component(target, type: "BoxCollider" \| "MeshCollider" \| "SphereCollider" \| …)`                                                                                                         | Same generic path as any component. `get_component_properties`/`set_component_properties` then read/tune the collider's fields (e.g. `isTrigger`, `size`, `sharedMesh` for `MeshCollider`).                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Place objects in a scene**    | `create_gameobject`/`create_gameobjects` (batch, with primitive/position/rotation/scale), `set_transform`, `set_parent`, `set_active`, `instantiate_prefab` (targets a loaded scene by path), `set_selection`                         | `create_gameobjects` batch-creates N objects with per-object position/rotation/scale arrays in one call — useful for scattering multiple instances without N round trips.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Eval — the escape hatch**     | `eval` (arbitrary C# via Roslyn, 5s default timeout, confined by nothing — §1.3), `eval_file`/`reload_file`/`reload_file_override` (compile+apply a hot-reload `.cs` file)                                                            | **Power:** can do anything the other 139 tools can (and more — arbitrary `UnityEditor`/`UnityEngine` API surface, including reading data — mesh stats, ModelImporter internals — no named tool exposes). **Risk:** exactly the risk `UnityPipelineClient.ts` flagged and excluded it for: unconfined by `set_authoring_root`, a 5-second default timeout that a real workload can blow through, and the _tool itself_ is the sandbox boundary — a malformed or malicious `eval` string is full C#-in-the-Editor-process, not a scoped operation. This repo's client does not wire it (CODE:39-47) as an explicit owner ruling. |
| **Capture Game View to a file** | `screenshot` (view: `game`\|`scene`, file-based, `output` path can be absolute), `capture_game_view` (camera-targeted render, inline base64 or `save_path`), `capture_scene_view` (Scene View only)                                   | §3 below verifies both mechanisms live.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Read console errors**         | `get_console_logs` (severity filter, `limit`, most-recent-first), `console` (tail + level + `since` cursor for polling/follow), `clear_console`                                                                                       | `console`'s `since` cursor is the one built for polling a running session without re-reading old entries — the right one for "did Play Mode log an error" during the vertical spike's `play` step.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Run play mode**               | `editor_play`, `editor_stop`, `editor_pause`, `editor_focus`, `set_autotick` (keeps ticking while unfocused/minimized), `recompile`/`recompile_status`                                                                                | **This is the ONLY row in this table already wired into `UnityPipelineClient.ts`** (as `play`/`stop`/`pause`, dispatch-and-confirm via a status re-read — CODE:679-693) — everything else in this table is unwired.                                                                                                                                                                                                                                                                                                                                                                                                            |

### 2.3 A CLI operational gotcha worth recording (found live, this session)

The `unity command <name> <args>` CLI's argument binding is **inconsistent**
across tools in a way that cost real time this session and would cost a real
integration real time too:

- For `eval` (one **required** string param) and `get_import_settings` (one
  **required** `objectref` param), a bare positional argument binds correctly.
- For `screenshot` and `get_console_logs` (all **optional** params), bare
  positional arguments are silently dropped — the call succeeds but every param
  falls back to its default, with no error and no indication anything was
  ignored. The reliable syntax for optional params is auto-generated named flags:
  `--view game --output /abs/path.png`, `--severity warning --limit 5` — **not**
  `key=value` and **not** unflagged positional.

**Implication for Q44:** a coding-agent-facing wrapper around this CLI (or a
future TS client extending `UnityPipelineClient`) must not shell out with
positional args for any tool that has optional parameters — it will look like a
successful call while silently doing the default thing. This repo's own client
sidesteps the whole problem today by only calling zero-parameter actions
(`editor_play`, `editor_status`, …) plus one that takes no _optional_ CLI args
either (`package_resolve` passes no args at all, CODE:883-889). Any extension
into `import_asset`/`create_prefab`/`screenshot`/etc. is the first code in this
repo that would need to get this right.

---

## 3. Q42 — Inspecting an imported model

### 3.1 The mechanism, VERIFIED live against the real Mafia Game Editor

**Read-only, per the task's bound — no scene, asset, or settings mutation; no
Play Mode entered.** Two probes:

**Probe A — Unity's own built-in cube mesh** (`Resources.GetBuiltinResource`,
touches no project file at all):

```
unity command eval \
  'var mesh = UnityEngine.Resources.GetBuiltinResource<UnityEngine.Mesh>("Cube.fbx");
   return new { vertexCount = mesh.vertexCount,
                triangleCount = mesh.triangles.Length/3,
                bounds = mesh.bounds.ToString() };' \
  --project-path "/Users/pieroherrera/Projects/Mafia Game" --json
→ { vertexCount: 24, triangleCount: 12, bounds: "Center: (0,0,0), Extents: (0.5,0.5,0.5)" }
```

**Probe B — a real imported `.fbx` already in the project's package cache**
(`Packages/com.unity.render-pipelines.core/.../UnityMaterialBall.fbx`), reading
`ModelImporter` for rig presence _and_ `Mesh` for geometry stats _and_
`AssetDatabase.LoadAllAssetsAtPath` for the material/texture sub-asset list, in
one call:

```
unity command eval '
  var path = "Packages/…/UnityMaterialBall.fbx";
  var importer = (UnityEditor.ModelImporter)UnityEditor.AssetImporter.GetAtPath(path);
  var mesh = UnityEditor.AssetDatabase.LoadAssetAtPath<UnityEngine.Mesh>(path);
  var allAssets = UnityEditor.AssetDatabase.LoadAllAssetsAtPath(path);
  var mats = …; var texs = …; // filter allAssets by is Material / is Texture
  return new { animationType = importer.animationType.ToString(),
               importAnimation = importer.importAnimation,
               materialImportMode = importer.materialImportMode.ToString(),
               vertexCount = mesh.vertexCount, triangleCount = mesh.triangles.Length/3,
               subMeshCount = mesh.subMeshCount, bounds = mesh.bounds.ToString(),
               materials = mats, textures = texs };'
  --project-path "/Users/pieroherrera/Projects/Mafia Game" --json
→ {
    animationType: "Generic", importAnimation: true, materialImportMode: "None",
    vertexCount: 1819, triangleCount: 3150, subMeshCount: 1,
    bounds: "Center: (0,-0.14,-0.37), Extents: (0.28,0.26,0.13)",
    materials: [], textures: []
  }
```

(`materials`/`textures` came back empty because this particular sample fbx embeds
no material sub-assets — `materialImportMode: "None"` explains why, and confirms
the query mechanism is reading real importer state, not a stub.)

### 3.2 What this settles for `inspect_generation`

- **Triangle/vertex count, bounds, submesh count** — `Mesh.vertexCount`,
  `Mesh.triangles.Length/3`, `Mesh.bounds`, `Mesh.subMeshCount`. **No named
  Pipeline tool exposes these** — `get_import_settings` (§2.2) reads _importer
  configuration_ (scale factor, mesh compression setting, read/write flag, …),
  not _computed geometry facts about the imported result_. Getting CHARTER §25's
  "Triangles: 18,300 / Target: <5,000" readout requires either `eval` or a new
  named Pipeline tool this version doesn't have.
- **Materials/textures** — `AssetDatabase.LoadAllAssetsAtPath(path)` filtered by
  type, as shown above; `Texture2D.width`/`.height` for texture size.
- **Rig presence** — `ModelImporter.animationType` (`None`/`Generic`/`Humanoid`/
  `Legacy`) plus `.importAnimation`. A generated prop with no skinning data will
  read `None` or `Generic`; `Humanoid` requires Unity's own bone-mapping heuristic
  to succeed, which a procedurally generated character mesh is unlikely to satisfy
  without a manual Avatar-mapping step (out of scope for the first spike — CHARTER
  §49 targets a prop, not a rigged character).
- **What `inspect_generation` should actually run**: one `eval` call combining
  `AssetImporter.GetAtPath` (cast to `ModelImporter`) + `Mesh` stats +
  `LoadAllAssetsAtPath`, shaped exactly like Probe B, returning the
  `{triangles, materials, textureSize, bounds, rig}` object `GENERATION_ARCHITECTURE.md`
  §6's `metadata: Record<string, unknown>` field already has room for.

### 3.3 The tension this creates with §41's finding

`inspect_generation`'s only mechanism today is the exact tool
(`eval`) this repo's own client has ruled out of scope. That is not a contradiction
in this document — it is the actual state of the system, and it is CHARTER §66
Q44's "can generation and Unity operations be safely chained" question made
concrete: **not yet, not for the technical-inspection half of the review loop**,
without either a scoped re-admission of `eval` (§5 below) or a new Pipeline
command this Unity package version doesn't ship.

---

## 4. Q43 — Game View capture

### 4.1 VERIFIED live, this session, both mechanisms

**`capture_game_view`** — inline base64 PNG in the same JSON envelope, no file
write required:

```
unity command capture_game_view --project-path "/Users/pieroherrera/Projects/Mafia Game" --json
→ { width: 1280, height: 720, encoding: "png", base64: "iVBORw0KG…" }
```

Decoded and saved to scratch space (`/tmp/unity-engine-probe/gameview-capture.png`,
190,620 bytes) and visually confirmed as a real render of the open `SampleScene`
(sky gradient + ground plane, `Camera.main`) — not a blank or placeholder image.
**Measured latency: 310 ms** end-to-end (subprocess spawn → HTTP round trip →
JSON parse → base64 decode), on an already-warm, already-open Editor with a
trivial scene.

**`screenshot`** — writes a PNG directly to a caller-chosen path, which can be
**absolute**, i.e. entirely outside the Unity project:

```
unity command screenshot --view game --output /tmp/unity-engine-probe/gameview-probe2.png \
  --project-path "/Users/pieroherrera/Projects/Mafia Game" --json
→ { success: true, path: "/tmp/unity-engine-probe/gameview-probe2.png", view: "game", width: 1109, height: 881 }
```

**Measured latency: 337 ms.** Comparable to `capture_game_view`; the difference
is delivery shape (file path vs. inline base64), not speed. **Without an
explicit `--output`, `screenshot` defaults to
`<project>/Temp/pipeline-screenshots/screenshot_game_<timestamp>.png`** — inside
the project's `Temp/` folder, which is Unity's own ephemeral/gitignored scratch
directory, not tracked asset state. (Two of this session's earlier probe attempts
landed there before the correct `--output` flag syntax was found — see §2.3's
CLI-gotcha note; `Temp/` is not asset/scene/settings state, so this does not
violate the read-only probe bound, but it is disclosed here for completeness.)

### 4.2 Where the file lands (Q43, restated precisely)

- `capture_game_view` with `save_path`: **project-relative** only (per its own
  parameter description — "Optional project-relative path to write the PNG").
- `screenshot` with `output`: **absolute or project-relative**, caller's choice —
  the more flexible of the two for a generation pipeline that wants captures to
  land in a harness-owned location rather than inside the game project.
- Neither tool needs `set_authoring_root` confinement — a Game View render is not
  an asset read, so the `Assets/`-only fence from §1.3 does not apply here.

### 4.3 Does it work unfocused?

**Not directly re-verified this session (no window-focus manipulation was
performed).** Two indirect, repo-internal signals support "yes":

- `recompile`'s own tool description states it explicitly: _"works while
  unfocused/minimized"_ — a documented Pipeline-CLI-wide property for at least
  one command in the same 140-tool family.
- `set_autotick`'s existence — _"Keep the editor ticking while unfocused by
  forcing `EditorApplication.SignalTick`"_ — implies Pipeline's design
  anticipates commands running against an Editor that isn't the foreground
  window, and gives a lever for when Unity's own update loop wouldn't otherwise
  pump fast enough.
- Neither probe in this session issued `editor_focus` before capturing, and both
  captures succeeded and produced real image content — consistent with, but not
  proof of, unfocused operation (this machine's actual window-focus state during
  the probe was not checked).

**INFERRED, not VERIFIED: mark this an open item for the vertical spike**, not a
settled fact — a real test (minimize the Unity window, or run with another app
focused, then capture) is a five-minute check the spike should do before relying
on it, since the whole point of a headless-viable review loop is that the agent
should not need the Editor window on top.

---

## 5. Q44 — Chaining safety: the vertical-spike step list

Synthesizing §1–4 into `GENERATION_ARCHITECTURE.md`'s §9/§14 "first end-to-end
vertical spike" (CHARTER §49), with failure modes per step and where CHARTER
§45 (credentials) / §47 (approval boundaries) should sit.

| #   | Step                                                                                                                                                                                                                                                                          | Mechanism (this doc's §)                                                   | Failure modes                                                                                                                                                                                                                                                                                                               | Approval boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Generate** — `generate_3d` produces a `.glb` on disk (outside the Unity project)                                                                                                                                                                                            | `GENERATION_ARCHITECTURE.md` §3/§8 (provider job, out of this doc's scope) | Provider timeout/error; a synchronous provider path never producing a job id                                                                                                                                                                                                                                                | **CHARTER §47 "Allow paid cloud generation": ask** — this is the step that spends money, per `GENERATION_ARCHITECTURE.md` §46/§47's split of _this_ gate from the import gate below                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 2   | **Import** — copy the `.glb` into `Assets/<authoring-root>/` + `import_asset`, then (if the project has async package resolution pending) `package_resolve`                                                                                                                   | §1.3, §2.2                                                                 | `.glb` lands outside `Assets/` (authoring-root confinement, §1.3) → `import_asset` rejects it; Unity's default import settings are not budget-aware (§1.1) so the raw import may already violate a platform triangle/texture budget before step 3 even runs                                                                 | **CHARTER §47 "Allow importing generated 3D": ask** — a _separate_ gate from step 1's, because it is the step that first writes into the user's actual game project (mutating consequence, not spending consequence)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 3   | **Configure** — `eval` (or, once/if a named tool exists, that tool) reads triangle count/materials/texture size/bounds/rig via `Mesh`+`ModelImporter` APIs (§3), decides pass/fail against the project's budget, and — if within budget — `add_component` attaches a collider | §2.2, §3.2                                                                 | **This step's mechanism is the tool this repo's client has explicitly excluded** (§2.2, §3.3) — an `eval` call that hangs past its 5s default timeout, or one with a scripting bug that mutates something the caller didn't intend (nothing confines it), is a real risk class distinct from every other step in this table | **This is the step CHARTER §45/§47 has no explicit answer for yet, and it needs one before the spike, not during it.** Two live options, not adjudicated here: (a) re-admit `eval` into `UnityPipelineClient` but _only_ for a harness-authored, reviewed, parameterized query template (never an agent-composed arbitrary string) — narrows the risk to "wrong data," not "arbitrary code"; (b) treat `eval` as permanently out of scope and accept that automated technical-budget inspection (CHARTER §63) is unavailable until Unity ships a named tool for it. Either way this is an **owner ruling**, not a spike-time engineering choice, because it reopens a decision `UnityPipelineClient.ts`'s own doc comment already recorded as settled the other way |
| 4   | **Place** — `create_prefab` (source GameObject → prefab) or `instantiate_prefab`, then `set_transform` for position/rotation/scale, `set_parent` if nesting under an existing hierarchy node                                                                                  | §2.2                                                                       | Instantiating into a scene that isn't the one the user expects (no scene-identity check shown in any tool's schema beyond `scene_path` on `instantiate_prefab`, which defaults to "the active scene" — an agent-driven session with an unexpected active scene open would place the prop in the wrong place silently)       | Folds into step 2's "Allow importing generated 3D" gate in `GENERATION_ARCHITECTURE.md` §47's sketch — CHARTER doesn't split "import the asset" from "place it in the scene" as two separate consents, and this doc doesn't find a reason it should for the first spike (both mutate the same project, moments apart)                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 5   | **Play** — `editor_play`, confirmed via a `status` re-read (this repo's OWN existing pattern, CODE:679-693, ready to reuse as-is)                                                                                                                                             | §2.2's play-mode row; ARCH §4.4                                            | The domain-reload gap `UnityPipelineClient.ts` already documents and defends against (`editor_status` can 404 for a few seconds right after `editor_play` succeeds — CODE:26-37) — any NEW code built for this step should reuse `dispatchAndConfirm`'s bounded-retry pattern rather than re-deriving it                    | Governed by CHARTER §47's existing "Allow modifying Unity scene: existing agent permission" line — this step doesn't mutate the project further, so it is the one step in this table that plausibly needs **no new gate**, riding the permission model this repo already has for engine control                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 6   | **Capture** — `screenshot --view game --output <harness-owned path>` (preferred: file-based, not inline base64, for latency/size — §4.1's two measurements were within 30ms of each other, so the choice is about payload shape, not speed)                                   | §4                                                                         | Unfocused-operation is unverified (§4.3) — if the spike's real environment runs the Editor window backgrounded (e.g. a headless dev box with a virtual display, or a user working in another app), this step is the one to actually test that assumption on, before trusting it in a CI-shaped loop                         | No new gate — read-only, same posture as any other tool-result the agent already receives                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 7   | **Agent evaluates** — the captured PNG becomes an MCP image-content block back to the coding agent (ARCH §4.6's `registerPreviewSnapshot` idiom is the proven-working precedent for this exact hand-back shape, ARCH:258-265), alongside step 3's technical-evidence JSON     | `GENERATION_ARCHITECTURE.md` §4/§9                                         | TOOLING's finding (cited in `GENERATION_ARCHITECTURE.md` §14 item 3) that image-content-block delivery is confirmed for Claude Code only, unverified for Codex/OpenCode — the whole point of CHARTER §64's "strongest review method" claim rests on this actually reaching the model, not just the tool result              | No new gate — this is the read the agent uses to decide whether to loop back to step 1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

### 5.1 The two things a spike-runner should NOT do, per this doc's evidence

- **Do not drive any parameterized Pipeline tool via bare CLI positional args
  in production code.** §2.3's finding (optional params silently default,
  no error surfaced) means a naive shell-out will look like a working
  integration in a demo and silently do the wrong thing in a corner case — use
  the auto-generated `--flagName value` syntax, or better, go through the
  `unity mcp`/HTTP transport this session did not have cause to probe, if
  it offers stronger typing.
- **Do not let an agent compose the `eval` string.** Even if §5's owner ruling
  (item 3, option a) re-admits `eval` at all, the risk this doc found is
  specifically "no authoring-root confinement, no scoping" — a harness-authored
  fixed query template (parameterized only by an asset path already validated
  by step 2's `import_asset` success) keeps the blast radius to "read the wrong
  mesh," never "execute attacker-influenced C#."

### 5.2 What this doc leaves open, explicitly

1. **§3.3/§5 row 3 — is `eval` back in scope, narrowly, for read-only technical
   inspection?** This is the single highest-leverage open question this
   document produced: CHARTER §63/§64 name automated technical review as the
   strongest differentiator, and the only mechanism this Unity version offers
   for it is the one tool this repo's own client has already excluded by name.
   **Owner ruling needed before the spike's step 3 can be built at all.**
2. **§4.3 — unfocused Game View capture is INFERRED, not VERIFIED.** A five-minute
   live check (minimize the Editor, capture, compare) should happen before the
   spike's step 6 is trusted in an unattended loop.
3. **§2.3's CLI arg-passing behavior** was reverse-engineered this session, not
   read from Unity's own source or documentation — a future Pipeline CLI version
   could change it. Whoever extends `UnityPipelineClient.ts` should re-verify
   this against the exact installed CLI version at build time, not trust this
   note indefinitely.
4. **No `create_game_asset`-style single tool exists in Pipeline** (nor should
   one — CHARTER §14 already rules this out at the harness-tool-surface layer;
   noted here only to confirm Unity's own tool surface doesn't secretly offer one
   Pipeline could delegate to instead).

---

## Addendum (2026-08-11, orchestrator-verified live)

**Unfocused Game View capture: VERIFIED WORKING.** With the Unity Editor
fully backgrounded (terminal frontmost, no Unity focus for minutes),
`unity command screenshot --project-path "<root>" --output /tmp/x.png`
returned success and wrote a real rendered 1109×881 PNG (185 KB — actual
scene content, not a blank buffer). The Q43 "unfocused?" flag is closed:
an unattended generation→capture→agent-review loop does not need window
focus.

**Multi-editor gotcha (supersedes the cwd-pinning guidance for
`command`):** with TWO editors running, `unity command <tool>` REFUSES
cwd auto-detection — even when invoked from inside the project
directory — and errors with "Multiple Unity Editor instances found";
only `--project-path <root>` disambiguates. (`unity pipeline list`
does honor cwd.) The generation toolkit must therefore ALWAYS pass
`--project-path` explicitly and never rely on cwd, since a second
editor being open is a normal end-user condition.
