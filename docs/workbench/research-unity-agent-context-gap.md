# Unity Agent Context Gap — Research

Scope: answer the owner's questions about code indexing / asset graphs / Unity file
access, work out the questions they didn't think to ask, and characterize what Bezi
documents (and, as it turned out, what Bezi actually _does_ — verified directly, not
just from marketing copy).

Every claim below is labeled:

- **VERIFIED** — I ran it, on this machine, against `~/Projects/Deepmind` (read-only,
  never opened in Unity) or the T3 fork.
- **DOCUMENTED** — a cited external source states it; I did not independently test it.
- **ASSUMPTION** — inference or industry-general knowledge not directly verified this
  session; flagged so it can be checked before anyone builds on it.

---

## Executive summary

The owner's framing — _static structure lives in files, live editor state lives only
in Editor memory_ — is **correct but incomplete**. It's missing a third category that
turned out to be the most important finding of this research: **derived structure**
(the reverse-dependency graph, the C# type graph) is neither raw file content nor
live-only memory — it's a _computed index_ that only exists if something builds and
persists it. Nothing on disk gives you "what uses this asset" for free; someone has to
compute it, and the only entity in this entire investigation that has actually done so
is Bezi.

That's not a hypothetical. `~/Projects/Deepmind` has Bezi installed
(`com.bezi.sidekick` v0.103.8), and its precomputed dependency graph is sitting on disk
at `Library/AI.CoreGraph` right now — 62 MB of JSON across 12 edge types and 6 node
types, covering 45,752 assets, 134 scenes, and 85 asset types, refreshed incrementally
off domain-reload events. This is **VERIFIED**, not documented from a changelog — see
§3. It is direct proof that a real competitor judged the reverse-dependency index
worth building and shipping, at real engineering cost (62 MB per project, an
incremental-refresh pipeline, unified with the C# inheritance graph). That is strong
circumstantial evidence the need is real, even though (§2) I could not find hard
evidence of _how often_ developers actually pull that answer versus just being glad
it's there.

Separately and independently: Unity 6+ now ships an **official, first-party** local
MCP relay (`com.unity.ai.assistant`, "Unity MCP") that starts automatically with the
Editor and installs a signed relay binary to `~/.unity/relay/`. This is
**DOCUMENTED** on docs.unity3d.com, and I found **VERIFIED**, live evidence of it in
use on this machine: `Library/AI.MCP/connections-v2.asset` records a real historical
connection between that relay and a Cursor process. This matters because it means the
"existence argument" (live editor state is only reachable through a plugin) is no
longer a claim about third-party tools filling a gap — Unity itself now ships the
bridge. What it does _not_ ship, per its own docs and per the team's own tool-list
check, is any reverse-dependency query. The gap the owner is asking about is real, and
it sits specifically between what Unity's own official relay exposes (live state) and
what nothing-first-party computes (derived structure).

---

## 0. Testing the owner's framing

> Static structure (assets, scenes, prefabs, GUIDs, dependencies) lives in files — an
> agent CAN get it, just expensively. Live editor state (selection, play mode,
> console, compilation, active scene) lives only in Editor memory — an agent CANNOT
> get it from files at all.

This two-way split holds for _raw_ content. It breaks for _derived_ content, and the
break is exactly where "is an asset graph needed" lives. Three buckets, not two:

1. **Raw, on disk, cheap to read** — one `.meta`/`.prefab`/`.unity` file's own
   contents. An agent can `cat` it.
2. **Raw, on disk, expensive to reconstitute** — "what points at asset X" is _implied_
   by the union of every other file on disk, but nothing stores it explicitly. An
   agent has to grep 25,863 files (or however many) to answer a question the data
   technically already contains. This is the team lead's "efficiency argument," and
   it's correct as far as it goes.
3. **Derived, and it only exists if something built it** — the _reverse_ map, the
   type-inheritance graph, "what tool categories can this project use." This is not
   implied by any single file; it's a computed join over the whole corpus. Unity
   itself does not persist this anywhere as a stable on-disk artifact (its internal
   `SourceAssetDB`/`ArtifactDB` are opaque, private, and — per Unity's own forum
   threads on `AssetDatabase.FindAssets`, §4 — are _not_ structured as a queryable
   reverse-dependency index; they're import-caching structures, a different purpose).
   The only reason this bucket is populated in `~/Projects/Deepmind` at all is because
   a third-party plugin computed it and wrote it to `Library/AI.CoreGraph`.

So: refine the framing to _three_ buckets, and note that bucket 3 is not an
"efficiency" question dressed up — it's an **existence** question for anyone who
doesn't want to build and maintain that index themselves. Bucket 2 (raw-but-expensive)
is efficiency. Bucket 3 (derived-and-nobody-persists-it) is existence, same as live
editor state.

---

## 1. What's genuinely unavailable from files

Classification of `~/Projects/Deepmind` (**VERIFIED** structure and sizes; contents of
individual proprietary binary formats where noted are **ASSUMPTION**/**DOCUMENTED**
since I did not reverse-engineer them).

| Location                                       | Size                      | Readable?                                                                                                                                | Useful as-is?                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Assets/`                                      | —                         | Yes, text (ForceText confirmed by team lead)                                                                                             | Yes — ground truth                                                                                                                                                                                                                                                                                                                                                                                                               |
| `ProjectSettings/`                             | small                     | Yes, text                                                                                                                                | Yes — build/player config                                                                                                                                                                                                                                                                                                                                                                                                        |
| `Packages/manifest.json`, `packages-lock.json` | small                     | Yes, text                                                                                                                                | Yes — dependency graph of _packages_, not assets                                                                                                                                                                                                                                                                                                                                                                                 |
| `Library/PackageCache/`                        | 2.6 GB                    | Directory names readable; contents are the _actual source_ of every installed package (readable C#/text mostly)                          | Yes, but redundant with what the package registry already has — this is Unity's local mirror, not new information                                                                                                                                                                                                                                                                                                                |
| `Library/ScriptAssemblies/`                    | 54 MB                     | `.dll`/`.pdb` — **not** readable as source without decompiling                                                                           | No — compiled output. Useful only to confirm _what compiled_, not _what the code says_ (source is already in `Assets/`)                                                                                                                                                                                                                                                                                                          |
| `Library/Artifacts/`                           | 12 GB                     | Binary, per-asset import cache keyed by content hash                                                                                     | **Opaque.** This is Unity's Scriptable Build Pipeline import-artifact cache (import results per asset, not human-readable)                                                                                                                                                                                                                                                                                                       |
| `Library/SourceAssetDB`, `Library/ArtifactDB`  | 75 MB + 283 MB            | `file` reports both as raw `data` (**VERIFIED** — no text markers)                                                                       | **Opaque.** These are Unity's own internal asset database and artifact database — private binary formats, no documented schema, no CLI to query them. This is the single biggest "no, an agent cannot get this from files" finding: Unity's _own_ dependency bookkeeping is not agent-readable at all. It's proprietary and undocumented — not YAML, not JSON, not SQLite (contrast `ShaderCache.db`, which _is_ SQLite, below). |
| `Library/ShaderCache.db`                       | 244 KB                    | **SQLite 3.x** (**VERIFIED** via `file`)                                                                                                 | Technically queryable with any SQLite client, but scoped to shader variant caching — not asset dependencies                                                                                                                                                                                                                                                                                                                      |
| `Library/Bee/`                                 | 275 MB                    | Build-system (Bee/Buildezy) intermediate state                                                                                           | Opaque-ish; build graph internals, not asset structure                                                                                                                                                                                                                                                                                                                                                                           |
| `Library/AI.CoreGraph/`                        | ~62 MB total across files | **JSON, fully readable** (**VERIFIED**, see §3)                                                                                          | **Yes — this is the one place in the entire `Library/` folder that answers "what depends on what" in a structured, agent-parseable way.** It only exists because Bezi is installed.                                                                                                                                                                                                                                              |
| `Library/AI.Conversations/`                    | 16 KB, 4 files            | JSON, minimal (**VERIFIED**: each file is ~116 bytes, a single key `Unity.AI.Assistant.Editor.Assistant+ContextUsageState_ContextUsage`) | Not conversation transcripts — looks like a thread metadata/usage-state stub belonging to Unity's _own_ first-party AI Assistant, not Bezi. No actual message content persisted locally in the files I saw.                                                                                                                                                                                                                      |
| `Library/AI.MCP/connections-v2.asset`          | small                     | YAML (Unity serialized `MonoBehaviour`), **VERIFIED readable**                                                                           | Connection _history/registry_ for Unity's official MCP relay — proves the relay exists and has been used, but is a log, not a live-state API surface                                                                                                                                                                                                                                                                             |
| `Library/Search/`                              | 455 MB                    | Unity Search index (the built-in Ctrl+K search provider's index)                                                                         | Partially structured but undocumented; not confirmed to expose reverse-dependency queries — Unity's own Search & Dependency Viewer packages are separate from this cache                                                                                                                                                                                                                                                         |
| `Library/BurstCache/`                          | 163 MB                    | Compiled Burst/native code cache                                                                                                         | Opaque, irrelevant to asset structure                                                                                                                                                                                                                                                                                                                                                                                            |

**The clean answer to "what does the agent not get by just being in the project":**
Unity's own first-party dependency bookkeeping (`SourceAssetDB`, `ArtifactDB`) is
**proprietary binary with no documented schema** — this is stronger than "expensive,"
it's genuinely opaque. The only structured, readable reverse-dependency data that
exists in this project exists _because a third-party plugin built it_, not because
Unity ships it. That's the sharpest version of the "existence, not efficiency"
argument the team lead was looking for, and it wasn't visible from the `.meta`-file
GUID-map angle alone — the GUID map the team lead built (523 ms) recreates _some_ of
what Bezi's graph has, but not the C# inheritance/interface graph, not the
incrementally-maintained reverse index, and not the scene-composition edges, all of
which are unified in `AI.CoreGraph`.

---

## 2. Is the asset-graph need PROVEN?

Honest answer, per the brief's instruction to be honest: **not proven as frequent
day-to-day demand; strongly evidenced as valuable-when-needed, and now also evidenced
as something a funded competitor judged worth real engineering investment.**

What supports demand:

- At least **eight independent third-party tools** exist solely to answer "what uses
  this asset" — Asset Usage Detector, Asset Usage Finder, Unity Reference Finder,
  Unused Assets Finder, Unity Unused Assets Detector, AssetLens, Asset Reference
  Viewer, UnityReferenceAnalyzer (**DOCUMENTED**, via GitHub/itch.io/Unity Asset
  Store search). Independent reinvention of the same tool by many unrelated authors is
  a classic signal of a real, recurring pain point — nobody builds the same
  single-purpose editor tool eight times for a need that doesn't exist.
- A live Unity Discussions thread (**DOCUMENTED**,
  [discussions.unity.com/threads/unity-does-not-remove-unused-assets...](https://discussions.unity.com/threads/unity-does-not-remove-unused-assets-even-theyre-if-outside-resources-folder.1062212/))
  shows a developer explicitly frustrated that Unity's own dependency detection is
  opaque, that "Find References in Scene" was unreliable, and that Unity's
  documentation _claims_ automatic unused-asset handling that doesn't actually work as
  described — a credibility gap between what Unity says it tracks and what it
  actually surfaces to a developer.
- Unity's **own official Scripting API**, `AssetDatabase.GetDependencies`
  (**DOCUMENTED**, docs.unity3d.com), only answers the _forward_ direction (what does
  this asset depend on). There is no first-party `GetDependents`/`GetReferences`
  reverse call. Getting the reverse direction from the engine's own API requires
  calling `GetDependencies` on _every_ asset and inverting the map yourself — which is
  exactly the O(N) full-project scan the team lead already measured as expensive via
  grep, just moved into C#. This is strong **DOCUMENTED** confirmation that the
  reverse direction is a genuine engine-level gap, not a made-up problem.
- Unity's own forum threads on `AssetDatabase.FindAssets` performance
  (**DOCUMENTED**) confirm it "scans the whole asset graph each call" and becomes
  seconds-slow past ~10k assets — independent evidence that ad hoc/uncached queries
  degrade exactly where a precomputed index would pay off, and that Unity developers
  already hit and complain about this at scales smaller than `~/Projects/Deepmind`'s
  45,752 assets.

What does _not_ support demand, or is missing:

- I found **no** telemetry, survey, or usage study quantifying _how often_ a working
  developer actually invokes "what uses this" versus other queries. All the evidence
  above is "this pain recurs enough that people build tools for it," not "developers
  do this N times a day." The brief asked for honesty here specifically, so: **the
  frequency claim is unproven.** The tools existing and forum threads recurring is
  good evidence of _episodic, high-stakes_ need (before a delete, before a big
  refactor) — not evidence of _high-frequency_ need.
- Bezi shipping a 62 MB graph is evidence a well-funded competitor believed it was
  worth the engineering cost — but that's evidence of _their_ bet, not proof of
  _your_ users' behavior. It should be weighted as "a serious peer made this call,"
  not as "demand is proven."

**Honest characterization, as requested:** _unproven as high-frequency demand; well
evidenced as an episodic, high-stakes, currently-unmet need (deletion fear,
refactoring, "what breaks if I touch this"); cheap to build against ForceText YAML
(team lead: 523 ms for a GUID map); expensive to leave undone (a competitor is already
shipping 62 MB of it per project); high value on the occasions it's needed, not proven
to be needed often._

---

## 3. What does Bezi document — and what does it actually do (verified)

The brief asked me to characterize _shapes_ — ambient vs. pull vs. index — not copy a
feature list, and to check what Bezi "knows" per their own materials. I did that
(§3a), and then found I could check it directly against the real artifact on disk in
`~/Projects/Deepmind` (§3b), which is a stronger source than any changelog.

### 3a. Documented shape (from Bezi's own materials)

**DOCUMENTED**, from
[docs.bezi.com/get-started/changelog](https://docs.bezi.com/get-started/changelog),
[discussions.unity.com's Bezi launch thread](https://discussions.unity.com/t/released-bezi-ai-powered-game-development-assistant-for-unity/1708451),
and the `com.bezi.sidekick` package manifest itself:

- **They push X ambiently:** real-time project indexing runs continuously in the
  background (scripts, scenes, assets, packages, local docs/GDDs) — the developer
  doesn't request it, it's kept current as a standing index.
- **They pull Y on demand:** `@`-mentions for explicit asset/project/page references;
  a grep-style keyword tool for in-file search; a "Vision Tool" that auto-captures
  Game View / Scene View / UI screenshots for verification on demand rather than
  continuously.
- **They index Z persistently:** the reverse-dependency and type graph (proven in
  §3b), semantically-searchable "pages" (docs/GDDs), and per-thread conversation
  memory with explicit context-usage accounting exposed in the UI (a meter showing how
  much of the context window a thread has used, and when it will compact) — this
  mirrors, almost exactly, Unity's own first-party AI Assistant's
  `ContextUsageState.ContextUsage` field found in `Library/AI.Conversations/` (§1),
  suggesting "show the user how full their context window is" has become a shared
  convention across both the first-party and third-party tools in this space, not a
  Bezi-only idea.
- Scope control exists explicitly as a feature: "Connections can be toggled on/off to
  prevent context overload" — i.e., Bezi's own team treats _too much_ ambient context
  as a real failure mode worth a UI control, not just a nice-to-have.

### 3b. Verified shape (the actual artifact, `~/Projects/Deepmind/Library/AI.CoreGraph/`)

This is the strongest evidence in this whole research pass, because it's not a claim —
it's the file. **VERIFIED**, read-only, this session:

- `com.bezi.sidekick` v0.103.8 is installed (`Packages/com.bezi.sidekick/package.json`
  — **VERIFIED**), and `Library/ScriptAssemblies/Bezi.Editor.dll` is a freshly
  compiled artifact (timestamp same session as the graph refresh — **VERIFIED**), so
  this isn't a stale leftover; it's live and in use.
- The graph is a **property graph**, not a flat map: 6 node types (`project`, `scene`,
  `asset`, `assetType`, `tool`, `toolCategory`) and 12 edge/relation types, split
  across separate JSON shards per relation:
  - `asset_uses_asset` (12.4 MB) — general reference edges
  - `asset_directlyDependsOn_asset` (12.0 MB) — the reverse-queryable dependency edge
  - `assetType_include_asset` (11.0 MB) — type membership
  - `asset_declares_asset` (5.5 MB) — **C# field declarations pointing at other
    assets/types** (i.e., "this MonoBehaviour has a public field of type X")
  - `asset_inheritsFrom_asset` (1.5 MB) and `asset_implements_asset` (0.55 MB) — **C#
    class inheritance and interface implementation**, modeled as graph edges
    alongside asset references
  - `asset_directlyReferencedBy_scene` (1.2 MB) and `scene_directlyDependsOn_asset`
    (1.2 MB) — scene-composition edges, both directions
  - `project_has_scene`, `project_contains_assetType`, `project_canUse_toolCategory`,
    `toolCategory_include_tool` — smaller structural/roll-up edges
- **Both directions are precomputed and stored per node**: sampled asset records
  carry `direct_dependencies_count` _and_ `direct_dependents_count` as plain integers
  (e.g., `Pedestal00.prefab`: 2 dependencies, 12 dependents) — confirming Bezi
  precomputes the reverse direction Unity's own `AssetDatabase.GetDependencies` does
  not give you, exactly the gap identified in §2.
- **It unifies asset structure with code structure.** `asset_inheritsFrom_asset` and
  `asset_implements_asset` mean this is not just "what prefab uses what texture" — a
  `.cs` script is a graph node too, and its inheritance chain and interface list are
  graph edges. That's a materially bigger scope than a GUID→path map: it's a merged
  asset-dependency + C#-type graph in one structure.
- **Node IDs are path-based, not GUID-based**
  (`asset_Assets__DLNK_Characters_Arachnya_Demon_[Prefabs]_Arachnya_prefab`), which is
  a real design choice worth flagging rather than assuming — Unity's own systems key
  everything off the `.meta` GUID specifically so paths _can_ change without breaking
  references; a path-keyed graph has to actively track renames/moves to stay correct,
  which is presumably what the refresh mechanism below is for.
- **Scale, from `metadata.json`:** `{"total_assets": 45749, "last_updated":
"2026-08-03T07:36:14Z"}`, and `nodes-project/project.json` reports 45,752 assets,
  134 scenes, 85 asset types for this project. Total graph payload: **~62 MB of JSON**
  for a ~46k-asset project — call it roughly 1.35 KB of graph per asset, which is a
  usable back-of-envelope scaling constant for the "10×" question in §4.
- **Incremental refresh, not full rebuild, is proven**: `.pending_changes.json`
  records a changelog (`{"type": "domain_reload", "path": "", "timestamp":
"2026-08-03T07:39:05Z"}`) keyed to Editor domain-reload events, separate from
  `.last_refresh_timestamp`. This is the concrete answer to the staleness problem the
  team lead flagged with Unity's own official Dependency Viewer ("not refreshed when
  assets change on disk") — Bezi's graph has an explicit change-tracking mechanism to
  avoid that failure mode. I did not verify _how completely_ it catches every kind of
  change (e.g., whether an out-of-Editor filesystem edit while Unity is closed is
  caught on next open) — flagging that as untested, not as broken.
- **Tool-gating nodes exist in the schema but are empty here**
  (`nodes-tool/tools.json` and `nodes-toolCategory/toolCategories.json` are both
  literally `[]`) — the graph schema supports gating _which of Bezi's own agent tools_
  a project can use via `project_canUse_toolCategory`, but nothing populates it in
  this project. **ASSUMPTION**: likely an unused/future capability, a
  server-side-only feature, or gated behind something not present here — worth a
  one-line caveat rather than treating the schema shape as proof of a shipped feature.

### 3c. Unity's own first-party surface (not Bezi, but adjacent and important)

**DOCUMENTED + VERIFIED together**, and this is a separate, second finding worth its
own line: Unity 6+ ships **Unity MCP** as part of the official `com.unity.ai.assistant`
package (2.10.0-pre.1 is what's installed here — **VERIFIED** via
`packages-lock.json`). Per Unity's own docs
([docs.unity3d.com/Packages/com.unity.ai.assistant@2.16/manual/integration/unity-mcp-get-started.html](https://docs.unity3d.com/Packages/com.unity.ai.assistant@2.16/manual/integration/unity-mcp-get-started.html)):
it starts automatically with the Editor, installs a signed relay binary to
`~/.unity/relay/`, and is meant to give external AI clients (Claude Code, Cursor,
Windsurf, Claude Desktop) live access to the running Editor. I found the _exact_ relay
path the docs describe, live, in `Library/AI.MCP/connections-v2.asset`
(`/Users/pieroherrera/.unity/relay/relay_mac_arm64.app`, Unity-signed, connected to a
Cursor process — **VERIFIED**). Its own docs do not enumerate a
dependency/reverse-reference tool among its exposed capabilities, which lines up with
the team lead's direct check of the live ~130-tool list turning up nothing there
either. **Net: two separate confirmations, from two different angles, that Unity's own
official live-state bridge and Bezi's own precomputed structure bridge are answering
two different questions, and neither one substitutes for the other.**

---

## 4. Questions the owner isn't asking (and answers, where findable)

1. **Does the ForceText/YAML assumption hold generally, or only for this project?**
   **DOCUMENTED**: Force Text has been the default serialization mode for new Unity
   projects for some time (multiple Unity Discussions threads corroborate this), and
   it's the community-recommended setting specifically _because_ it's
   version-control-friendly (diffable/mergeable). **ASSUMPTION, flagged as a real risk
   not to skip**: "default" is not "universal" — older projects migrated forward,
   projects that intentionally chose Force Binary for file-size or load-time reasons,
   and any project with `m_SerializationMode` left at Mixed will have some assets that
   are _not_ agent-readable text. The file-based approach should detect and report
   serialization mode per-project (cheap: it's one field in `ProjectSettings`) rather
   than assume it.

2. **Does any of this transfer to Unreal or Godot?** Split answer, **DOCUMENTED**:
   - **Unreal**: No, mostly. `.uasset` is binary — every file starts with the same
     4-byte magic header (`0x9E2A83C1`) followed by a binary table-of-offsets format.
     An agent with filesystem access literally cannot read Blueprints, materials, or
     level files as text. The static-structure-in-files half of the owner's framing
     does not hold for Unreal at all — for Unreal, _everything_ is closer to the
     "live-editor-memory-only" bucket unless you go through Unreal's own Python/C++
     editor scripting API or its (also-binary, less standardized) MCP-equivalents.
   - **Godot**: Yes, closely. `.tscn` (scenes) and `.tres` (resources) are
     purpose-built text formats, human-readable and explicitly designed to be
     version-control-friendly, including typed external-resource references with
     UIDs. The Unity-style file-based approach transfers well to Godot; it does not
     transfer to Unreal.

3. **What breaks at 10× the asset count (~460k assets)?** Mostly **ASSUMPTION**
   extrapolated from **VERIFIED**/**DOCUMENTED** data points, flagged as such:
   - GUID-map build time: team lead measured 523 ms at 25,863 `.meta` files; naive
     linear scaling puts 10× at ~5 seconds — still fine for a one-time cold-start cost,
     **ASSUMPTION** since actual scaling could be worse than linear depending on
     filesystem/IO characteristics, not re-verified here.
   - Bezi-style graph size: ~1.35 KB/asset observed here (62 MB / 45,752 assets)
     extrapolates to **~620 MB** of graph JSON at 460k assets — no longer a trivial
     footprint; **ASSUMPTION** that Bezi's actual production system doesn't ship raw
     JSON at that scale (more likely a real DB/index server-side), since a 620 MB
     flat-JSON-per-project local cache would itself become a scaling problem.
   - Unity's own `AssetDatabase.FindAssets` is **DOCUMENTED** (Unity's own forum) to
     already be "seconds-slow" past 10k assets because it scans the whole graph per
     call with no caching — at 460k assets, uncached full-scan approaches (whether
     grep-based or `FindAssets`-based) should be assumed non-viable for anything
     latency-sensitive, reinforcing that a precomputed, incrementally-maintained index
     stops being a nice-to-have and becomes closer to necessary at that scale.

4. **What about Git LFS pointers standing in for real assets?** **DOCUMENTED**: LFS is
   a common, explicitly recommended pattern for Unity projects with large binary
   assets (models, audio, textures) — GitHub's own 50 MB warning / 100 MB cap pushes
   teams there. Standard `.gitattributes` guidance explicitly carves out `.unity` and
   `.prefab` as text (`merge=unityyamlmerge eol=lf`) while routing the _binary_ payload
   assets through LFS. **ASSUMPTION, worth flagging as a real gap**: an agent reading
   the filesystem of an LFS-enabled clone that hasn't run `git lfs pull` sees pointer
   files (small text stubs with a hash and byte count), not the actual asset bytes —
   the `.meta`/GUID/dependency graph still works (it's metadata, tracked separately
   from LFS payloads), but any content-level operation on the actual texture/model/
   audio data would silently operate on a pointer stub instead. This is a real,
   checkable failure mode nobody in this research thread had raised yet.

5. **What does a fresh clone with no `Library/` look like to an agent, versus this
   machine's warm one?** **DOCUMENTED + reasoned**: on first open, Unity regenerates
   the entire `Library/` folder from scratch — full reimport of every asset, full
   shader compile, full script compile. This is widely reported as a real one-time
   cost (minutes to hours depending on project size; the earlier `AssetDatabase`
   performance search turned up reports of reimports taking **hours** for projects
   with thousands of materials absent batching). Concretely, for the file-based
   approach this means: **`Library/AI.CoreGraph` does not exist until Bezi has run at
   least once inside a live Editor session** — a fresh clone gives an agent the same
   `Assets/`/`.meta` raw material, but _zero_ of the derived-graph value described in
   §3, until someone opens the project in the actual Editor and lets the plugin build
   it. A purely file-based, no-Editor-required asset graph (like the GUID map the
   team lead already proved cheap) does _not_ have this dependency — that's a real,
   concrete advantage of building your own lightweight file-based index over relying
   on any Editor-resident plugin's cache: it works on a bare clone with no Editor
   session at all.

6. **Does Unity's own internal dependency bookkeeping give an escape hatch?**
   Addressed in §1 but worth calling out as its own question: no. `SourceAssetDB` and
   `ArtifactDB` are private, undocumented binary formats (**VERIFIED**: `file` reports
   plain `data`, no readable structure). There is no first-party CLI or documented API
   to query them directly from outside a running Editor. This closes off what might
   have looked like a free win ("Unity must already have this somewhere") — it does,
   but it's locked.

---

## 5. Concrete scenarios: what could an agent do _better_ with an asset graph that it cannot do at all today

Per the brief's instruction to give scenarios, not capability words:

- **"Rename this prefab and fix every reference."** Today: an agent has to grep every
  `.unity`/`.prefab`/`.asset` file for the old GUID or path string, with false
  positives from substring collisions and false negatives from anything referencing by
  GUID with a display name that never changes. With a reverse-dependency index: a
  single lookup of `direct_dependents_count`/edges for that asset ID returns the exact
  file set to touch, with the relation type (declares/uses/inherits) telling you _how_
  it's referenced, which changes what the fix looks like.
- **"I want to delete this old character model — what actually still uses it?"** This
  is precisely the fear documented in §2 (forum thread: dependency detection so opaque
  that a developer had to manually bisect their own project to find a false unused-
  asset warning). Today an agent's honest answer requires a full-project grep and
  still risks missing scene-only references that never appear in another asset file.
  With the graph: `asset_directlyReferencedBy_scene` + `asset_uses_asset` reversed
  gives a direct, complete answer in one query.
- **"Which of my ~130 prefabs implement `IDamageable`, and do any of them not
  override `TakeDamage`?"** This requires _code_-structure awareness combined with
  _asset_-structure awareness — exactly what `asset_implements_asset` and
  `asset_inheritsFrom_asset` unify. A file-only agent would need to open every prefab,
  resolve its `MonoScript` GUID, open that script, and check its interface list by
  hand — one query per candidate, not one query total.
- **"This scene won't load a texture at runtime — is it actually referenced from this
  scene, or did I only reference it from a prefab that isn't placed anywhere in this
  scene?"** `scene_directlyDependsOn_asset` vs `asset_directlyReferencedBy_scene`
  gives a direct yes/no per scene; today this is a manual, scene-by-scene grep for a
  GUID that may appear in a dozen unrelated contexts.
- **What an asset graph does _not_ help with, worth stating for balance**: none of
  this touches _live_ state — whether the project currently compiles, what's selected
  right now, whether Play Mode is running, what just printed to the console. Those
  remain squarely in the live-editor-memory bucket regardless of how good the file-
  based graph gets, which is exactly the owner's original framing holding up for that
  half of the split.

---

## Sources index

- [Bezi Changelog](https://docs.bezi.com/get-started/changelog) — DOCUMENTED, §3a
- [Bezi Unity Discussions launch thread](https://discussions.unity.com/t/released-bezi-ai-powered-game-development-assistant-for-unity/1708451) — DOCUMENTED, §3a
- `~/Projects/Deepmind/Library/AI.CoreGraph/*`, `Library/AI.Conversations/*`,
  `Library/AI.MCP/connections-v2.asset`, `Packages/com.bezi.sidekick/package.json`,
  `Packages/packages-lock.json` — VERIFIED, §1/§3b/§3c (read-only, this session)
- [Unity MCP — Get started](https://docs.unity3d.com/Packages/com.unity.ai.assistant@2.16/manual/integration/unity-mcp-get-started.html) — DOCUMENTED, §3c
- [Unity forum: "Unity Does Not Remove Unused Assets"](https://discussions.unity.com/threads/unity-does-not-remove-unused-assets-even-theyre-if-outside-resources-folder.1062212/) — DOCUMENTED, §2
- [AssetDatabase.GetDependencies (Unity Scripting API)](https://docs.unity3d.com/ScriptReference/AssetDatabase.GetDependencies.html) — DOCUMENTED, §2
- Unity forum threads on `AssetDatabase.FindAssets`/import performance at scale — DOCUMENTED, §2/§4
- Third-party asset-usage tools (Asset Usage Detector, Asset Usage Finder, Unity
  Reference Finder, Unused Assets Finder, AssetLens, Asset Reference Viewer,
  UnityReferenceAnalyzer) — DOCUMENTED (existence/count), §2
- [Sackbird Studios: "The .uasset Problem"](https://www.sackbirdstudios.com/news/uasset-binary-problem) — DOCUMENTED, §4
- [Godot TSCN file format docs](https://docs.godotengine.org/en/stable/engine_details/file_formats/tscn.html) — DOCUMENTED, §4
- Git LFS + Unity setup guides (thoughtbot, Medium, gamedeveloper.com) — DOCUMENTED, §4
- Unity Discussions/serialization-mode threads (Force Text as new-project default) — DOCUMENTED, §4

---

## CORRECTION (team-lead, verified after this document was written)

**`Library/AI.CoreGraph/` is Unity's own artifact, not a third-party package's.**

This document attributed that 60MB bidirectional asset-dependency graph to an
installed competitor package and treated it as evidence that a funded
competitor judged a reverse-dependency index worth building. That attribution
is wrong.

Verified: `GraphTypes.cs` and `GraphRefreshManager.cs` live inside
`Library/PackageCache/com.unity.ai.assistant@…/Editor/Assistant/GraphGeneration/`.
The competitor's package (`Packages/com.bezi.sidekick`) contains no reference to
`CoreGraph` in its source, and none in its compiled `Bezi.Editor.dll`.

The on-disk structure — `edges-asset_declares_asset`,
`edges-asset_directlyDependsOn_asset`, `edges-asset_directlyReferencedBy_scene`,
plus `.last_refresh_timestamp` and `.pending_changes.json` — is therefore
**Unity's**, forward and reverse, incrementally maintained.

**This strengthens the conclusion rather than weakening it, but changes what to
build.** It is no longer "a competitor thought this was worth the cost"; it is
"Unity itself computes and persists exactly this." Before writing any
asset-graph tool, establish whether Unity's artifact is readable and queryable
from outside the Editor. If it is, the tool is a thin reader over Unity's own
data rather than an index we compute, own and keep fresh — the same shape as the
Play/Stop decision, where deleting 1,633 lines of our own C# in favour of
Unity's official package was the right call.

The competitor package IS installed in the owner's project. That fact stands.
It is simply not the author of this artifact.
