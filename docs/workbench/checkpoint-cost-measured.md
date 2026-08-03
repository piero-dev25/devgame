# Checkpoints: the claim is true, and the fix is smaller than it looks

The goal's third MUST-GUT item said checkpoints "fire per-turn, unbenchmarked
on big binary trees". The other two items in that list did not survive
investigation. **This one does** — and measuring it produced a much more
targeted fix than "rewrite the policy".

## Corrections to what I had been asserting

- **The mechanism is at `GitVcsDriver.ts:650-730`, not `GitVcsDriverCore.ts`.**
  I cited the wrong file repeatedly. `GitVcsDriverCore.ts` contains no
  `GIT_INDEX_FILE` reference at all.
- **The triggers live in the orchestration layer**, not the VCS driver —
  `apps/server/src/orchestration/Layers/CheckpointReactor.ts`. That is why I
  looked for a per-turn call site in the VCS code and found nothing, then
  reported the claim as unverified.
- **"Per-turn" understates it.** It is roughly **twice per turn**: a baseline
  capture at turn start and a real capture at completion. Four call sites
  (`:482`, `:629`, `:355`, `:428`), with idempotency guards that prevent
  duplicates but not the baseline-plus-completion pair.

## What one capture does

Against an isolated `GIT_INDEX_FILE`: `rev-parse` ×2, `read-tree HEAD`,
**`git add -A -- .`**, `write-tree`, `commit-tree`, `update-ref`.

Everything except `add -A` is under 25ms regardless of tree size. `add -A` is
the entire cost, and it walks the **whole tree every time**.

## Measured, on an M4 Max with NVMe — an upper bound

| tracked | capture |
| ------- | ------- |
| 224 MB  | 0.36s   |
| 1.0 GB  | 1.53s   |
| 2.0 GB  | 3.09s   |
| 3.0 GB  | 4.64s   |

Linear, ~665 MB/s. A one-byte edit costs exactly the same as no change at all
(1.53s), which is what proves the walk is full-tree rather than incremental.

At ~5GB tracked — not exotic for Unity or Unreal without LFS — that is ~8s per
capture and **~15s of git work per turn**.

### It does not merely get slow. It breaks.

`VcsProcess.ts` sets `DEFAULT_TIMEOUT_MS = 30_000` on every `execute()`, with
no override for checkpoint operations. Past roughly 15–18GB tracked, a single
`add -A` crosses it and capture **hard-fails** with a timeout, surfacing as
`checkpoint.capture.failed`. There is a cliff, not just a slope.

## The root cause is a choice, not a git limit

`read-tree HEAD` populates the fresh temp index with **zeroed stat metadata**.
That defeats git's native mtime/size comparison, so `add -A` must re-open and
re-hash every tracked file on every capture.

Isolated directly: run `add -A` twice against the _same_ index with no file
changes between runs — **1.56s, then 0.01s. 156×.**

The asymmetry proves it too. `restoreCheckpoint` is already O(changed bytes):
reverting a 20-file/90MB change on the 1GB tree takes 0.3s, a no-op revert
~50ms. Git's write path is not the problem. Only the capture path's habit of
rebuilding its index from scratch is.

**So the fix is not a policy rewrite.** Reuse a persistent per-workspace index
instead of rebuilding it from `read-tree HEAD` on every call, and unchanged
files collapse to near-zero while changed files cost what they actually weigh.

## `.gitignore` is the biggest lever that already exists

Capture uses git's native ignore engine, so a correct `.gitignore` is doing
most of the mitigation today. On the 1GB-tracked / 578MB-ignored repo:

- with `Library/` + `Temp/` ignored: **1.53s**
- with `.gitignore` moved aside: **11.6s** (7.6×), because that content must be
  hashed _and_ written as new loose objects
- second run without it: 2.41s — so the object writes, not the hashing, drove
  most of the difference

Unity's standard template ignores `Library/` and `Temp/`. A project whose
`.gitignore` is missing or wrong — or that committed `Library/` once — pays
the full price on every capture forever.

## Why T3's own users do not hit this

Worth asking explicitly, since "upstream is broken" has been wrong seven times
in this project. They are not broken; **their usage does not stress this path**.
Web projects track kilobytes of source, and `node_modules` is ignored. At those
sizes `add -A` is milliseconds and rebuilding the index costs nothing.

Game projects track hundreds of megabytes to gigabytes of binary assets. Same
code, entirely different regime. This is a genuine gap _for us specifically_,
which is exactly the kind of thing owning the fork is for.

## One more finding, unasked for

The capture worker (`DrainableWorker.ts`) is a **single process-wide serial
queue**. A slow checkpoint on one thread's large project blocks checkpoint
processing — and the `thread.turn.diff.complete` dispatch that carries the
file-change summary to the client — for every other active thread on the
server. There is no per-thread parallelism.

## Not determined

Real throughput on typical (non-NVMe, cloud, or network) storage; Windows
behaviour; and whether `turn.processing.quiesced` gates any client-visible
state — no consumer was found outside its own publish site.

Bench scripts remain at
`/Users/pieroherrera/.claude/jobs/d1eda764/tmp/checkpoint-bench/`.

---

## VERDICT (2026-08-03): we are NOT changing T3's code

Two real projects measured, read-only, on the same machine and the same T3
build:

|              | tracked at HEAD           | on disk | LFS                         | capture      |
| ------------ | ------------------------- | ------- | --------------------------- | ------------ |
| Deepmind     | **227 MB** (49,650 files) | 71 GB   | 100% pointers, zero leakage | **0.3–0.4s** |
| Rising Tides | **1.2 GB** (11,709 files) | 15 GB   | configured but drifted      | **1.5–1.9s** |

Deepmind ignores 46GB (`Library/` 16G, `AssetLibrary/` 30G) and pointer-izes
every tracked binary extension present. **0.3% of the project reaches the hash
pass.** Rising Tides reaches 8%.

Same code. A 4–5× difference in capture cost, entirely from repository
hygiene.

### What this settles

The cost is real but it is **ours, not theirs**. A fully-disciplined
`.gitignore` + LFS setup already reduces it to a non-issue, and the owner has
a working example of that in his own home directory. Patching T3's checkpoint
path would make a symptom cheaper while the actual cause — assets falling out
of LFS coverage — kept getting worse.

Owner's ruling, stated three times: _"t3 features are working fine. we dont
need to change them."_ The measurement supports it.

**No change to `GitVcsDriver.ts` or `CheckpointStore.test.ts`. Tree confirmed
stock.**

### The real finding: LFS drift on Rising Tides

`.gitattributes` routes png/mp3/jpg/tga/hdr/tif/exr through LFS, but:

- **479 of 579 PNGs are still full blobs** (426 MB) — never backfilled
- **TGA and HDR have rules and zero migrated files** — the rule has never
  applied to anything
- 2 large MP3s leaked through (141 MB)
- WAV (174 MB) and FBX (134 MB) are not in the rule at all

This is not static. Assets keep landing as full blobs while the config claims
otherwise, and the project has already grown to 15GB.

### Options, with honest costs — owner's call, his project

1. **`git lfs migrate import`** — converts existing files properly. **Rewrites
   history**: new commit SHAs, force-push required, every existing clone
   breaks and must be re-cloned. Disruptive if anyone has work in flight.
2. **`git lfs migrate import --no-rewrite`** — converts files in a NEW commit
   without touching history. No force-push, no broken clones. This is the safe
   middle option and it _does_ reduce tracked bytes at HEAD, which is what
   capture cost actually depends on.
3. **Forward-only tracking** — new files get pointers, existing blobs stay in
   HEAD's tree. Worth knowing: this does **not** reduce capture cost for
   existing assets, because they are still real blobs in the current tree.
4. **Nothing.** 1.5–1.9s per capture, twice per turn, on a background worker.
   Noticeable but not blocking, and it will slowly worsen.

Option 2 is the one worth looking at first.
