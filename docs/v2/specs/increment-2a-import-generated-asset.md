# Increment 2a — import_generated_asset (FROZEN SPEC)

Status: frozen 2026-08-12. Closes the charter loop's "…enters Unity" step
through the product. Mechanism proven LIVE (spike 2, this session): a
generated barrel converted to FBX, its GLB textures extracted, imported,
and bound to a URP material — rendered textured in Mafia Game's Game View
(screenshot in the session). This spec freezes that exact recipe.

Grounds: SPIKE_RESULTS.md (spikes 1+2), increment-1 spec + code
(a8696fdfc/55aa8e068), notes/unity-engine-integration.md (the 140-tool
surface + CLI param gotchas).

## Goal

A fifth harness MCP tool, `import_generated_asset({ assetId })`, that takes
a succeeded GeneratedAsset (from increment 1) and lands it in the caller's
Unity project as a **textured, ready-to-use** asset: FBX geometry + a URP
material wired from the GLB's PBR textures.

## Scope (IN)

1. **Complete `deriveFbx`** in `TripoProvider.ts` (currently a stub): POST
   `type:"convert_model", original_model_task_id, format:"FBX"` → poll →
   return the FBX url. FREE + ~6s (spike-measured). Store the derived FBX
   under the asset's dir.
2. **Server-side GLB texture extraction** (new `glbTextures.ts`, sibling to
   `glbInspect.ts`): parse the glTF binary, pull the material's
   `baseColorTexture`, `metallicRoughnessTexture`, `normalTexture` image
   bufferViews → write to files (`baseColor.<ext>`, `metallicRoughness.<ext>`,
   `normal.<ext>`), returning `{ role → path }`. (Spike proved: barrel GLB
   has all 3 as 2048² JPEGs.) Reuse glbInspect's header/JSON-chunk parser.
3. **`import_generated_asset` MCP tool** (`toolkits/generation/`): gated on
   `generation` capability, project-scoped like the other tools. Steps:
   a. Resolve projectId→workspaceRoot (Diff/increment-1 precedent).
   b. Require a LIVE matched Unity editor for the project (the import needs
   the editor). No editor → clean typed error telling the user to open
   Unity (do NOT cold-start).
   c. deriveFbx + extract textures (steps 1-2) if not already cached on the
   asset.
   d. Run the Unity Pipeline commands (see "Unity command surface"):
   import FBX + 3 textures into `Assets/DevGame/<assetId>/`; set the
   normal texture's import type = NormalMap; build the URP material +
   bind it to the model's renderers via the fixed harness snippet.
   e. Return `{ assetPath, materialPath, textures: {role→path},
   unityStats: {triangles, materials} }` — Unity-side stats read via the
   D1 read-only eval; note `texturesCarried: true`.
4. **OWNER_DOCKET D1 refinement** (update the file): D1 allowed
   harness-authored read-only eval. This tool needs a harness-authored
   FIXED WRITE eval for the material bind (Unity has no clean named-tool
   path for glTF→URP material assembly). Record: D1 extended to "harness-
   authored, allowlisted, FIXED snippets — read OR write — never
   agent-composed C#." The write snippet is a constant in the tool, not
   built from tool input. **OWNER-APPROVED 2026-08-12**: write-evals are
   fine "if that's something Unity is supporting and how people write
   custom code for the agent↔pipeline" — both true: `eval` is a first-class
   command in Unity's pipeline tool surface (the live 140-tool enumeration),
   the idiomatic path for custom authoring C#. No veto pending.

## The proven material recipe (implement exactly)

Import order matters (textures before the material bind). Fixed C# (adapt
to a constant string; NO interpolation of agent input — only the fixed
asset-dir path the tool controls):

- Shader: `Universal Render Pipeline/Lit` (fallback `Standard`).
- `_BaseMap` ← baseColor texture; `_MainTex` ← baseColor (Standard fallback).
- `_BumpMap` ← normal texture + `EnableKeyword("_NORMALMAP")`; the normal
  texture MUST be imported with `textureType:"NormalMap"` first
  (`set_import_settings --asset <normal> --settings {"textureType":"NormalMap"}`).
- `_Metallic` 0, `_Smoothness` 0.25 (wood default; see fidelity note).
- `CreateAsset(mat, "<dir>/material.mat")`, then assign to every
  `Renderer.sharedMaterials` on the imported model.
- FIDELITY FOLLOW-UP (out of scope, note it): glTF packs metallic in B /
  roughness in G; URP `_MetallicGlossMap` wants metallic in R / smoothness
  in A. The spike skipped the MR map (baseColor+normal already read as
  wood). A future increment channel-remaps MR for full PBR fidelity.

## Unity command surface

`UnityPipelineClient.ts` currently exposes 8 methods (status/play/stop/
pause/list/install/open/packageResolve). This tool needs `import_asset`,
`set_import_settings`, and `eval` (read for stats; the fixed write for the
material). Add these to `UnityPipelineClient` via its existing shell-out
idiom (the Unity connection is a keep-family file — a narrow extension is
correct), OR a sibling `UnityAuthoringClient` if cleaner. CLI param
gotchas (from notes/unity-engine-integration.md, verified live):
`import_asset` needs BOTH `--source` (abs external) AND `--path` (Assets
dest); `set_import_settings` uses `--asset` (not --path); `unity command`
needs explicit `--project-path`; optional params silently no-op without
`--flagName`. Always pass `--project-path <canonical workspaceRoot>`.

## Scope (OUT — later)

Scene placement (import ≠ place), the Generation dock panel (2b), MR
channel-remap fidelity, glTFast alternative, non-Unity engines, undo.

## Acceptance

1. Unit: glbTextures extraction against the committed `barrel-5996tris.glb`
   fixture returns exactly `{baseColor, metallicRoughness, normal}` with
   real bytes (red-prove: a wrong role set / zero files fails). deriveFbx
   with a mock provider returns the fbx url. The import tool with a MOCKED
   Unity command runner drives the full sequence in order (import→
   set-normal→material-bind→stats) and returns the contract shape; project
   scoping enforced (wrong project → NotFound). Capability gate enforced.
   All red-proven. NO live Unity/Tripo in unit tests.
2. Typecheck server+contracts clean; full server suite green; contracts
   still ZERO vendor edits (new generation/ files + the one barrel line
   only).
3. LIVE (orchestrator-run): import a real generated barrel into a Unity
   project; confirm the imported model is TEXTURED (not white) via a Game
   View capture + Unity-side material check. (~0 extra credits — convert is
   free; reuses an increment-1 generated asset.)

## Doctrine

New files over hot-file edits; the UnityPipelineClient extension is the one
sanctioned existing-file edit (keep-family). Effect v4 idioms. Red-first
tests. The material write-eval is a FIXED constant — never interpolate tool
input into C# (injection guard). Match the increment-1 toolkit structure.
