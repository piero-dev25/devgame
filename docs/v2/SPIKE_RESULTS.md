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
