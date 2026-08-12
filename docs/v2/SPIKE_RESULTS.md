# SPIKE_RESULTS.md

Living record of what the V2 generation spikes actually proved (vs. what
the research predicted). Charter §67 deliverable.

## Spike 0 — Tripo provider half, end to end (2026-08-12) ✅

**Goal:** prove the 3D provider works submit → poll → download a real,
game-usable asset, and measure it. No app changes; raw API against the
free trial wallet.

**Result: PASS, and it handed us the moat on a plate.**

| Fact          | Value                                                                  |
| ------------- | ---------------------------------------------------------------------- |
| Endpoint      | `POST /v2/openapi/task` type `text_to_model`, model `v2.5-20250123`    |
| Auth          | `Bearer <key>` — key authenticates, `balance` readable                 |
| Prompt        | "a stylized low-poly wooden barrel, game asset"                        |
| Job shape     | **async** — returns `task_id` immediately, then `GET /task/{id}` polls |
| Progress      | real 0→100, monotonic (6→9→…→100) — usable for a progress bar          |
| **Latency**   | **~158 s (2.6 min)** to `success`                                      |
| Output        | signed URL to a **PBR GLB** (`texture:true, pbr:true, export_uv:true`) |
| File          | valid glTF 2.0 binary, **14.8 MB**                                     |
| Mesh          | 1 mesh, 1 material, 3 PBR textures, UVs present                        |
| **Triangles** | **≈ 501,146**                                                          |

### The finding that matters

The default "low-poly barrel" came back at **half a million triangles** —
against a mobile game budget of ~5,000. This is _exactly_ the charter's
§63/§25 scenario, now a measured fact rather than a hypothesis:

> a generic generator returns "here's your barrel." A **game** harness
> returns "here's your barrel — 501,146 triangles, target <5,000 for this
> project, I'll remesh or regenerate with a polycount cap."

So the technical-inspection moat (which needs D1's `eval`, now approved)
is not a nice-to-have — the **first asset we ever generated is 100× over
budget.** Without inspection the agent ships it blind.

### What this confirms for the architecture

- **Async job model is right** (matches OpenCode's 65 s tool timeout —
  2.6 min blows every synchronous ceiling; `generate_3d` MUST return a
  job handle, server owns the poll loop). GENERATION_ARCHITECTURE.md §8 ✅
- **`inspect_generation` must run before import**, and can catch polycount
  from the GLB directly (glTF accessor counts — no Unity needed for the
  _number_; Unity/`eval` is for the in-context render + import settings).
- **Tripo has the fix built in** — `face_limit`/quad params + a remesh
  task — so the regenerate-with-budget loop is real and cheap to demo.
- Build against **API v3** (v2 retires 2026-10-01); v2 used here only to
  de-risk the provider fast.

**Credits:** ~30 of the 600-credit free wallet spent. Asset saved to
scratch (`barrel.glb`), not committed.

## Next (not yet run)

- Spike 1: `generate_3d` as a harness MCP tool → GenerationJob tracked →
  human + agent review (charter §69). Needs the toolkit + service slice.
- Spike 1b: import the barrel into a Unity project + Game View capture +
  agent evaluates. **Owner call: throwaway project or explicit OK to use
  a real project** — will not auto-mutate an owner project.

## Spike 1 — FULL LOOP, live end to end on Mafia Game (2026-08-12) ✅

**Goal (charter §69/§77):** agent request → generate → agent+human review →
iterate → import → scene → Game View → agent evaluates. Ran against the
owner's live Mafia Game editor (authorized); scene never saved; asset
folder removed after; project verified pristine.

**Result: the whole loop ran, and the final agent-review step found a real
defect — exactly the point.**

| Step                         | Outcome                                                                                                                                                                                                    |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| generate_3d                  | 501,146-tri barrel, ~20 credits, ~158 s (async)                                                                                                                                                            |
| agent inspect                | "501k tris vs ~5k budget → regenerate"                                                                                                                                                                     |
| **iterate**                  | regen `face_limit=6000` → **5,996 tris** (14.8 MB → 0.7 MB)                                                                                                                                                |
| **convert → FBX**            | `convert_model` on the existing task: **0 credits, 6 s**                                                                                                                                                   |
| import to Unity              | native FBX import → real GameObject (glb → `DefaultAsset`, unusable)                                                                                                                                       |
| Unity-side inspect (D1 eval) | 5,996 tris, 1 material, 0.88×1.0×0.88 m — read-only eval, working                                                                                                                                          |
| place + capture              | placed in front of Main Camera, `screenshot --output` → 1109×878 PNG                                                                                                                                       |
| **agent evaluates**          | geometry/proportions/budget/placement all correct — **BUT untextured white: the PBR materials were lost in the FBX convert.** Next iteration: carry GLB textures across or import GLB-with-a-glTF-package. |

### Load-bearing findings for the build

1. **Cheap-iterate ("reuse token") is real** (owner insight, confirmed):
   `convert_model` / remesh on an existing task is FREE and ~6 s. The whole
   inspect→remesh-to-budget→reformat loop is near-zero cost after gen 1.
   → GenerationService should model "derive from existing generation" as a
   first-class, cheap operation distinct from a fresh gen.
2. **Unity import needs FBX or a glTF importer package.** Raw `.glb` →
   `DefaultAsset` (0 meshes). Options: convert to FBX server-side (free via
   Tripo — recommended for the spike/MVP), or require/bundle glTFast in game
   projects (keeps textures + is the modern path). **D-new: owner call —
   convert-to-FBX vs require-glTFast.**
3. **FBX conversion drops textures.** Geometry survives, materials don't.
   The import step must re-attach GLB textures or prefer the glTF path when
   materials matter. Caught only by the in-context render → validates §26
   (agent view ≠ human view) and §64 (Unity-render review is the strongest).
4. **`instantiate_prefab` rejects model-FBX roots** ("not a prefab asset").
   Placement pipeline = import → **create_prefab** (wrap) → instantiate.
   The spike used a one-off write-eval to place (documented shortcut); the
   product path uses named tools per D1.
5. **CLI param ergonomics** (extends Q41): `import_asset` needs BOTH
   `--source` (external) and `--path` (Assets dest); `instantiate_prefab`
   uses `--prefab`; `unity command` needs explicit `--project-path` with 2
   editors open. Optional params silently no-op without `--flags`.
6. **`capture_game_view` returns inline base64** (no file); use
   `screenshot --output <abs>` for a file. Both work unfocused.

### Spike-scope defaults exercised (flag for production)

D2 grant generation broadly (single-user) ✅ · D4 wrote to canonical
Assets/ ✅ · D6 nested engineImport (n/a — spike had no DB) · scene never
saved, project restored pristine.

**Credits:** 40 of 600 free-wallet spent total (2 gens); converts were free.
Balance ~560, valid to 2026-08-26.

### Verdict

The loop is **coherent and native to coding-agent work** — a chat intent
became a budget-correct asset rendered in the real game, and the agent's
final look caught a shippable defect (missing textures) a generic tool
would have missed. Charter §77's bar is met. Proceed to productize:
GenerationService + the harness `generate_3d`/`inspect_generation`/
`import_generated_asset` MCP toolkit + the Generation panel.
