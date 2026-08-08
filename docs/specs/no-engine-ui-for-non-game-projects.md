# Spec — game-harness UI renders ONLY for game projects (rev 2, post-critique)

Repo: `~/Projects/t3code-fork`, branch `workbench/upstream-20260806`. Owner
request (2026-08-08, two screenshots): (1) a non-game project (the fork
itself) shows a "No engine" chip in the chat header — "just not show the no
engine chip in there and any other chip that is game harness specific";
(2) "the 'current selection' chip was showing in an unrelated project
session" — a t3code-fork thread's composer displayed the Mafia Game Unity
editor's "Directional Light" selection chip.

Rev 2 incorporates a fresh-critic review (14 findings). The critic's method
warning binds the implementer too: the shell `grep` here is aliased to ugrep
and can SILENTLY skip directories — verify absences with `/usr/bin/grep`.

## Ruling supersession (record it, don't bury it)

`apps/web/src/editorPresence/store.ts:153-160` records the 2026-08 ruling
"presence is environment-scoped BY OWNER RULING — every connected editor is
visible in the chip row" (why task #71 scoped only the send path). The
owner's 2026-08-08 screenshot report supersedes the display half: the chip
ROW is project-scoped too, now. Rewrite that comment to carry both rulings
with dates. Same treatment for the now-false "mounted once, always live"
claims at store.ts:184-186 and EditorPresenceChips.tsx:2-7 (already false —
ChatComposer.tsx:2899-2902 unmounts the row on three conditions today).
`docs/workbench/plan-engine-header-redesign.md:164-165` left "does the
header show nothing for non-engine projects?" open — this request answers
it: nothing. Add a supersession note to `docs/specs/unity-header-cleanup.md`
(its line ~39 describes the old keep-the-badge contract).

## The three-state engine signal (core design)

`engineType` on the wire has THREE client-visible states and they mean
different things (contracts orchestration.ts:216-232, :459-471):

- **unknown** — the project entity has not loaded (`activeProject === null`,
  every thread open and project switch passes through this window), OR the
  entity loaded but the field is ABSENT (older server predating the field;
  optional-for-decode per the contract's own comment). We cannot say
  whether this is a game.
- **none** — entity loaded and `engineType === null`: detection RAN against
  the workspace and matched no marker. This is "not a game".
- **unity | godot | unreal | threejs** — a game project.

A pure `resolveEngineChipState(activeProject)` in `ChatView.logic.ts`
returns `"unknown" | "none" | EngineType`. Every gate below keys off THIS,
never off a collapsed `?? null` (the collapse is exactly what would have
made the composer unmount its socket on every project switch — critique F1,
blocker — and would have blanked all engine UI on an older backend, F3).

The 2026-08-05 flash doctrine is satisfied WITHOUT retention: `unknown`
never hides an already-mounted composer surface, and within a loaded
payload `null` is a settled answer, not an in-flight one. (Rev 1's
session last-good retention is DROPPED per critique F2: the server caches
an I/O-degraded null for ~a minute — that is a real state lasting 60s+,
not a flash to smooth over, and masking it would also keep a Unity toolbar
alive for a project folder that no longer exists.)

## Scope

### A. EngineToolbar renders nothing without a concrete engine

- Single engine source (critique F4): DELETE the `resolvedEngineType` prop
  from EngineToolbar (EngineToolbar.tsx:63-71) — the component reads
  `view.engineType` only. ChatView already feeds the identical value into
  both today; the compiler finds every stale call site.
- `resolveEngineToolbarView` resolves a null/unknown engine to a view the
  component renders as `null` — the rule lives in the component's own
  contract so no future caller can resurrect the chip. ChatHeader.tsx:364's
  `activeProjectName &&` gate stays as is.
- Tests: the existing null-case test (EngineToolbar.test.tsx:173-176,
  "still renders 'No engine'") flips to assert NOTHING renders — and the
  shared `renderToolbar` fixture must be corrected first: today it always
  passes a threejs VIEW while overriding only the prop, so the two engine
  inputs deliberately disagree (F4). After the prop deletion the fixture
  has one input and the flip is a true red-first anchor. Every
  detected-engine state renders exactly as today (anchored assertions).
- Grep gate, scoped to `apps/` (F14): "No engine" survives nowhere in
  app code. Update the doc comments asserting the old contract
  (EngineToolbar.tsx:63-70, EngineToolbar.logic.ts:257-259).

### B. Composer chip row: game-gated and project-scoped

- Plumb from ChatView through ChatComposer as MEMO-SAFE primitives
  (ChatComposer is memo'd, F8): `engineChipState: "unknown" | "none" |
EngineType` and `presenceWorkspaceRoot: string | null`
  (`activeProject?.workspaceRoot ?? null`).
- Mount rule at ChatComposer.tsx:2899-2902 gains ONE new condition:
  unmount only when `engineChipState === "none"`. `unknown` keeps the
  socket mounted (no ticket re-mint, no "connecting…" flash on project
  switch — F1).
- The testable decision is extracted pure (critique F5 — do NOT extract a
  merge+filter that store.test.ts:266-316 already covers):
  `resolveEditorPresenceChipsView({ liveChips, pinned, workspaceRoot,
engineChipState })` in store.ts returns either `{ kind: "hidden" }` (for
  "none") or `{ kind: "chips", chips }` — chips = merged live+pinned
  filtered through the EXISTING `selectEditorPresenceChipsForProject` by
  workspaceRoot (null root ⇒ no chips). Unit-test the gate and the
  scoping through THIS function; EditorPresenceChips.tsx becomes a thin
  caller; EditorPresenceChipRow stays presentational.
- Publish the RENDERED list (F7): `publishCurrentEditorPresenceChips`
  receives the same filtered chips the row shows. The snapshot's only
  reader is the send path (ChatView.tsx:5120), which KEEPS its own
  identical filter as defense-in-depth on the privacy-critical path — with
  both sides filtering by the same value, see-what-you-send is structural.
  The EDITORS snapshot stays raw: its one consumer
  (buildEngineHeadlineBlock, engineHeadline.ts:79-84) project-filters
  internally.

### C. Prompt-content effect: explicit, not accidental (F6/F13)

Unmounting the row CLEARS both published snapshots (EditorPresenceChips'
effect cleanup) — so for a "none" project the model stops receiving
`<engine>`/`<editor_selection>` blocks even in the F13 edge where a
connected publisher's root matches a null-engine project (server-side
detection I/O hiccup while a real editor is connected). That prompt change
is DESIRED and is now stated: a "none" project sends no engine context,
period. Record the corrected reason from F13 in the spec and code comment:
the prompt path was clean for non-game projects because of PROJECT
scoping (workspaceRoot), not engine scoping — the two can diverge, and the
"none" mount-gate is what closes the divergence. Cover at the pure seam:
`resolveEditorPresenceChipsView` returning "hidden" for "none" is the
tested gate; note in the container that publish follows render by
construction.

## Named behavior changes (owner-visible, intended)

- Draft threads with NO resolved project show no selection chips (they
  could never send them — store.ts:175 returns [] for a null project; the
  old row showed chips that silently would not attach). Status pill still
  appears for game-project drafts only. (F10)
- A pin made in project B stays in the global pin store but is invisible
  (and un-unpinnable) while project A is open; it reappears on returning
  to B. No pin-clearing on project switch. (F9)
- A project that GAINS an engine mid-session shows engine UI on the next
  snapshot refetch (pre-existing lazy re-detection; unchanged).

## Non-goals

- No server changes.
- Settings → Connections "Control connected editors" stays (environment-
  level grant, not per-project chrome).
- Historical `EditorSelectionMessageChips` in transcripts stay ungated —
  they render what was actually sent.
- ChatView's second `useEditorPresence` (toolbar) may stay connected for
  non-game projects; optional follow-up.

## Acceptance

1. Suites: `pnpm typecheck` exit 0; full web + server green; every changed
   test's red-or-why documented (the flipped toolbar null-case test and the
   new `resolveEditorPresenceChipsView` gate tests are the anchors).
2. E2E on the packaged build, commit named (F12): open t3code-fork — no
   badge, no toolbar, no chips, no status pill; header and composer
   indistinguishable from stock T3. Open Mafia Game — toolbar and chips
   exactly as today. The cross-project scenario (second editor connected
   elsewhere showing NOTHING in t3code-fork) rides the same pass — the
   Mafia editor connected while a t3code-fork thread is open IS the
   owner's screenshot, re-run.
3. Grep gate: `/usr/bin/grep -rn "No engine" apps/` returns nothing.
