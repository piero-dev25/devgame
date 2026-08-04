# Reading Unity's asset graph vs scanning from disk

Investigation of the three questions after the AI.CoreGraph correction. Read-only.
Measured against the owner's real Unity project (`~/Projects/Deepmind`, 45,752 graph
nodes) and the Godot fixture in `t3code-fork/godot/`.

Labels as before: **VERIFIED** (read it / ran it), **DOCUMENTED** (quoted from a file
in the repo), **ASSUMPTION** (reasoning, unchecked).

---

## Answers in one paragraph

Unity's graph is **plain JSON on disk, readable outside the Editor, and parses in
~100 ms — the "60 MB parse" worry was wrong**. It answers a reverse dependency query
in 107 ms against 1,307 ms for a from-disk scan, and it answers three questions a disk
scan _structurally cannot_ (`inheritsFrom`, `implements`, `declares` come from
compiled type info, not text). But it is **path-keyed, not GUID-keyed**, it is
**gitignored and absent from a fresh clone**, and it **misses references that live in
code** — a from-disk scan found a hardcoded GUID array in an editor script that
Unity's graph does not model as a dependency. Godot's equivalent is `.godot/uid_cache.bin`,
a trivially parseable UID→path map, but Godot needs it far less because `.tscn` files
reference by readable `res://` path. Unreal is **unverified — there is no Unreal project
on this machine** and I did not guess. One interface covers both backends only if it
answers "what would break if I touch this", which is the union of both — not either one
alone.

---

## Q1 — Can we read Unity's graph?

**Yes, easily. VERIFIED.**

`Library/AI.CoreGraph/` is 60 MB across 20 directories, each holding exactly **one
plain-JSON file**. No database, no proprietary container, no Editor process required.

```
metadata.json            {"total_assets": 45749, "last_updated": "2026-08-03T07:36:14Z"}
.last_refresh_timestamp  2026-08-03T07:36:15Z
.pending_changes.json    {"version":"1.0","totalChanges":1,"changes":[{"type":"domain_reload",...}]}
nodes-asset/assets.json                             17.1 MB   45,752 nodes
edges-asset_directlyDependsOn_asset/dependencies.json 12.0 MB  37,527 edges
edges-asset_uses_asset/…                            12.4 MB   43,848 edges
edges-asset_declares_asset/…                         5.5 MB   19,225 edges
edges-asset_inheritsFrom_asset/…                     1.5 MB    4,936 edges
edges-scene_directlyDependsOn_asset/…                1.2 MB    4,255 edges
edges-asset_directlyReferencedBy_scene/…             1.2 MB    4,255 edges
edges-asset_implements_asset/…                       0.5 MB    1,796 edges
```

Node and edge shapes (VERIFIED, read from the files):

```json
{ "id": "asset_Assets__DLNK_Characters_Arachnya_Demon_[Prefabs]_Arachnya_prefab",
  "type": "asset", "path": "Assets/…/Arachnya.prefab", "name": "Arachnya.prefab",
  "direct_dependencies_count": 4, "direct_dependents_count": 4,
  "asset_type": "GameObject" }

{ "src_id": "asset_…_Arachnya_prefab", "dst_id": "asset_…_ArachnyaAnimator_controller",
  "relation_type": "directlyDependsOn", "src_type": "asset", "dst_type": "asset" }
```

### Queryable, or a 60 MB parse?

**Both, and it doesn't matter — the parse is nearly free.** VERIFIED:

|                                                                       |            |
| --------------------------------------------------------------------- | ---------- |
| Parse `dependencies.json` (12 MB, 37,527 edges)                       | **23 ms**  |
| Parse `nodes-asset/assets.json` (17 MB, 45,752 nodes)                 | **38 ms**  |
| **Full reverse query, cold, including both parses + both node types** | **107 ms** |

The files are flat JSON _arrays_ — not keyed maps — so a single query technically scans
everything. At these sizes that costs tens of milliseconds. There is no need for a
persistent index, an invalidation story, or a daemon. Parse, answer, discard, exactly
like the from-disk map.

### Three things that constrain using it

**1. It is path-keyed, not GUID-keyed.** The node `id` is a mangled path:
`Assets/UNI VFX 6D/Beams & Energy/Prefabs/UNI_LaserBeam_neon.prefab` becomes
`asset_Assets_UNI_VFX_6D_Beams_&_Energy_Prefabs_UNI_LaserBeam_neon_prefab` — `/`, space
and `.` all collapse to `_`, while `&` survives. That mangling is **lossy in principle**:
`A_B/C` and `A/B_C` produce the same id. In this project there are **zero collisions
across 45,752 nodes** (VERIFIED), so it is not a live problem, but a reader must
resolve by matching the `path` field rather than by constructing an id from a path.
More importantly, path-keying means a **rename invalidates the graph** where a
GUID-keyed index would survive it — and renames are exactly when "what uses this"
gets asked.

**2. It does not exist in a fresh clone.** VERIFIED: `.gitignore:2` is `[Ll]ibrary/`,
and `git ls-files Library/` is empty. The graph appears only after the Editor has run
and built it. Your constraint holds exactly as stated.

**3. Staleness is detectable but not self-healing.** `.last_refresh_timestamp` and
`.pending_changes.json` are both readable, and `.pending_changes.json` currently shows
one un-applied `domain_reload` change. In this project **0 files under `Assets/` are
newer than the graph timestamp** (VERIFIED), so it happens to be current — but that is
because the owner hasn't edited since. A reader must compare the timestamp against the
tree and say so when the answer may be stale. It cannot refresh the graph itself:
refresh is `GraphRefreshManager`'s job inside the Editor, and forcing it from outside
would mean Roslyn execution, which is off-limits.

---

## Q2 — What does the fallback cost?

### Two corrections to my own earlier numbers

**My research-doc figure of "reverse query ≈ 2,839 ms" was measured through the broken
`grep` shell wrapper and is unreliable.** Re-running the same shape through
`/usr/bin/grep` took **145,512 ms** — fifty times slower — because it walks every binary
asset. Neither number should be used.

The honest number is a **pure-Python single pass over text assets only**, which is what
a real implementation would do anyway. VERIFIED:

| Backend                                         | Time         | Result  |
| ----------------------------------------------- | ------------ | ------- |
| Unity graph                                     | **107 ms**   | 2 users |
| From-disk scan (7,134 text assets, 962 MB read) | **1,307 ms** | 3 users |
| `/usr/bin/grep -rl` over all of `Assets/`       | 145,512 ms   | 3 users |

My earlier **523 ms GUID→path index build over 25,863 `.meta` files still stands** — that
was pure Python and never touched grep.

So the fallback is ~1.3 s uncached for a full reverse query, and a real implementation
would build the reverse index once per invalidation rather than per query.

### Godot

**The `.uid` mechanism is real and trivially readable, but Godot needs it less than
Unity does.** VERIFIED:

- `.uid` sidecars exist next to scripts: `epp_client.gd.uid` contains `uid://ce8b5sbraa15c`.
- `.godot/uid_cache.bin` is the UID→path map, in a simple binary layout I confirmed by
  parsing it: `[count:u32]` then repeating `[uid:i64][pathlen:u32][path:utf8]`.
  **10/10 records parsed cleanly**, e.g.
  `uid=8354482205548733666 -> res://addons/editor_presence/tests/epp_client_integration_test.gd`.
- `.godot/` is **gitignored** (`.gitignore:48`) and untracked — **same fresh-clone
  constraint as Unity's `Library/`**.

The important difference: **Godot's scene files reference by readable path.**
`main.tscn` contains `[ext_resource type="Script" path="res://main.gd" id="1"]`
(VERIFIED). Unity scenes contain _only_ GUIDs, so the GUID→path indirection is
mandatory there; in Godot a plain path search answers "what uses this" with no index at
all. **ASSUMPTION** (medium confidence): modern Godot writes both `uid=` and `path=` on
`ext_resource`, so a reader should match either — this fixture's `main.tscn` was
hand-written (it carries explanatory comments Godot would not emit), so it is not
representative of editor-saved scenes. Worth confirming against an editor-saved `.tscn`
before building.

### Unreal

**Unverified. I did not establish it, and I am not going to assume it.**

`find ~/Projects -name "*.uproject"` returns **nothing** — there is no Unreal project on
this machine (consistent with task #38's "no Unreal on this machine"). I can state only
what follows from that: any claim about `.uasset` binary parsing, or about whether
Unreal exposes a dependency manifest, is untested here. The one thing I can say with
confidence is that the _text-scan_ fallback that works for Unity and Godot **cannot**
work on `.uasset`, because the format is binary — so Unreal needs either a different
mechanism or an explicit "not supported" answer. Establishing which needs an actual
Unreal project.

---

## Q3 — Does one interface cover both backends?

**Only if the interface answers "what would break if I touch this." For that question,
yes. For "what does Unity think depends on this," no — they are different questions and
the difference is not a rounding error.**

The evidence is the single disagreement between the two backends on the same asset.
VERIFIED:

```
GRAPH  (107 ms) → 2 users
  Assets/UNI VFX 6D/Beams & Energy/ScenesURP/DemoURP.unity
  Assets/UNI VFX 6D/Beams & Energy/ScenesURP/PrefabsURP.unity

DISK  (1,307 ms) → 3 users
  Assets/Editor/BeamPilotDataRepair.cs          ← graph does not have this
  Assets/UNI VFX 6D/Beams & Energy/ScenesURP/DemoURP.unity
  Assets/UNI VFX 6D/Beams & Energy/ScenesURP/PrefabsURP.unity
```

They agree perfectly on the two real asset references. The extra disk hit is
`BeamPilotDataRepair.cs:147`, a **hardcoded array of GUID string literals** in an editor
script:

```csharp
"8e81d088e4d3eba4ca608feb38017bf1","221078c50e2883343b1004f2454bd2b1",…
```

Unity's AssetDatabase does not model a string literal as a dependency, and it is right
not to. But if you delete that prefab, **that script breaks**, and an agent asked "is it
safe to delete this" that answers "only two scenes use it" has given a confidently wrong
answer. Hardcoded GUID lists are common in real projects — data-repair scripts,
addressable manifests, editor tooling.

### What each backend uniquely provides

**Graph only** (a disk scan cannot produce these at any cost — they come from compiled
type information, not text):

| edge                       | count  |
| -------------------------- | ------ |
| `asset_declares_asset`     | 19,225 |
| `asset_inheritsFrom_asset` | 4,936  |
| `asset_implements_asset`   | 1,796  |

Plus typed metadata per node (`asset_type`: MonoScript 13,214, AudioClip 10,517,
Texture2D 6,304, GameObject 5,350, …), and **`Packages/` coverage: 20,022 of the 45,752
nodes are under `Packages/`, not `Assets/`** — a disk scan of `Assets/` alone misses 44%
of the graph.

**Disk only**: textual references from code and from any file the AssetDatabase doesn't
treat as a dependency edge. Also: it works on a fresh clone, after a rename, and without
the Editor ever having run.

### Recommendation

**One tool, one union answer, provenance labelled per result.** Not "read the graph if
present, else scan" — that silently changes what the answer _means_ depending on whether
the Editor has run, which is the worst property a tool can have.

```
engine_asset_refs(path, direction, limit)
  → [{ path, via: "asset-graph" | "file-scan" | "both" }],
    plus a freshness note when the graph is older than the tree
```

- Run **both** on Unity when the graph exists: graph for semantic edges and `Packages/`
  coverage, scan for code references. Cost is ~1.4 s combined, which is fine for a tool
  the agent calls deliberately.
- Godot: scan only, using paths (and `uid://` where present).
- Unreal: **say it is unsupported** until someone can test against a real project. An
  honest "I can't answer this for Unreal" beats a plausible wrong list, which is the same
  principle as omitting play state rather than defaulting it to `stopped`.
- Label provenance in the result. "Used by DemoURP.unity (asset graph) and
  BeamPilotDataRepair.cs (file scan)" tells the agent _why_ it should be careful about the
  second one.

### What would make me wrong

1. **The mangled-id collision is theoretical here.** Zero collisions in 45,752 nodes, but
   a project with paths differing only in `_` vs `/` vs space would produce silent wrong
   answers. _Check:_ run the collision detector against a second real project before
   trusting id-based lookup — or sidestep it by matching on `path` only, which is what I'd do.
2. **One sampled asset.** The 2-vs-3 disagreement is a single prefab. The pattern
   (graph = semantic, disk = textual superset) is well-motivated, but the _frequency_ of
   code-held GUID references is unmeasured. _Check:_ count how many assets in the project
   are referenced from `.cs` but absent from the graph's dependent set. If it's near zero,
   the union buys little and graph-only is simpler.
3. **Godot's editor-saved scene format.** My `path=`-only evidence comes from a
   hand-written fixture. If editor-saved scenes reference purely by `uid://`, the Godot
   path scan needs the uid cache after all — which exists and parses, so it's a
   complication rather than a blocker.
4. **Unreal could be free.** If Unreal ships a readable dependency manifest the way Unity
   does, the "unsupported" answer is wrong and lazy. It is genuinely untested here.

---

## Follow-up measurement (team-lead): the union should be NARROW, not full-disk

This document's open question was the frequency of code-held GUID references —
the one thing that would change the union recommendation. Measured against
`~/Projects/Deepmind`:

- **1 of 1,644** `.cs` files contains a 32-hex string literal.
- That single file holds **23 distinct literals**, and **all 23 match real
  asset GUIDs** in the project.

So the pattern is **rare but never spurious**. It is not noise to be filtered;
every occurrence found was a genuine reference that Unity's graph does not
model — and correctly does not, since a string literal is not a dependency.

**This changes the shape of the union.** The full from-disk scan (1,307 ms,
962 MB read) exists to catch these, but it is scanning _every text asset_ to
find references that only ever live in _code_. Unity's graph already covers
asset→asset references completely, including the 44% of nodes under
`Packages/` that a disk scan misses entirely.

**So: graph for asset references, plus a narrow scan of source files for GUID
literals.** 1,644 `.cs` files rather than 7,134 files and 962 MB — orders of
magnitude cheaper than the full scan, and it targets exactly the gap the full
scan was justified by.

The provenance labelling still applies, and matters more at this ratio: a
result found only in code should say so, because "a script hardcodes this GUID"
is a different fact for a human than "a scene references this prefab", and it
fails differently — silently, at runtime, rather than as a broken reference in
the Editor.

Godot needs none of this: `.tscn` references by readable path, so the
code-literal case has no equivalent. Unreal remains unsupported and untested.
