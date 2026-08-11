# Spec — the unified top band (rev 4: post-critique, post-live-probe)

Repo: `~/Projects/t3code-fork`, branch `workbench/upstream-20260806`. Owner
iteration (2026-08-10, supersedes the shipped strip `ffafc3728` on design):
ONE top band — traffic lights + brand + the dock tabs in the same row.
Empty band space moves the WINDOW; only tab headers reorganize the dock;
the empty-space group-drag/float ("multiple panels sort of view") is gone.

Rev 4 folds in the fresh-critic review (3 blockers, 4 majors, 6 minors) AND
a live Electron probe (evidence: this session's appregion probe, electron
41.5.0, real-mouse driver) that settled the three statically-undecidable
questions. Citations to dockview are against the INSTALLED dist/esm build
of dockview-core@7.0.4 (the critic corrected rev 3's line numbers; the
implementer should trust behavior claims and re-locate lines in dist/esm).

## Probe-settled facts (2026-08-11, decisive)

- `-webkit-app-region: drag` swallows pointerdown/mousedown/click at the
  OS layer: the void container's click-to-activate AND the
  shift+pointerdown float-detach (tabsContainer's shiftKey path — the
  owner's "multiple panels sort of view") both die in the band with no
  code. SHIFT gestures are swallowed too (probe check 4, log empty).
- During an ACTIVE HTML5 drag, dragenter/dragover/drop DO NOT fire over an
  app-region element (probe check 3: SOURCE dragstart logged, zero BAND
  drag events). CONSEQUENCE: band empty space is window-drag XOR
  tab-drop-target — the owner's stated priority picks window-drag.
  RESIDUE (documented, owner-informed): in the band, drop dragged tabs
  ONTO TABS (no-drag islands keep full dnd — probe check 5); the
  drop-on-empty-space append gesture survives only on non-band strips.
- Synthetic driver drags cannot move macOS windows (window-server needs
  hardware events) — window-move verification is owner-eye, permanently.

## Design (simpler than rev 3 — no dockview API vetoes at all)

The API vetoes (`onWillShowOverlay`, `onWillDragGroup`) are DROPPED:
the first became redundant (no drag events reach band voids under
app-region) and would have killed the non-band append gesture globally
(critique B1/M1); the second leaks the drag payload (critique B3 —
LocalSelectionTransfer never disposed when dragstart is prevented after
getData). What remains:

### A. Band-scoped drag region + guards

- ONE helper (pure, unit-tested red-first) computes from `api.groups` +
  `group.api.boundingBox` (dockview-root-relative) on `onDidLayoutChange`:
  (1) the set of TOP-ROW groups (boundingBox.top === 0), (2) which of them
  owns (0,0) — the corner-padding target. DockviewLayout stamps
  `data-dv-topband` on top-row groups' `.dv-tabs-and-actions-container`
  and sets the corner padding on the (0,0) owner.
- dockviewTheme.css: `[data-dv-topband] .dv-void-container {
-webkit-app-region: drag; cursor: default; }` — SCOPED to the band
  (critique B1: a global rule would make every strip's blank space a
  window-drag handle, including bottom groups). `cursor: default`
  OVERRIDES dockview's own `.dv-draggable { cursor: grab }` (critique m1 —
  it comes from the library stylesheet and stays applied; without the
  override the band advertises a dead affordance). Explicit
  `-webkit-app-region: no-drag` on `.dv-tab`, `.dv-left-actions-container`,
  `.dv-right-actions-container` (overflow dropdown lives there).
- `disableFloatingGroups: true` in createDockview options — EXPLICITLY
  (critique B2: it is NOT set today; grep proves it). This kills the
  shift+drag float-detach on NON-band strips too and removes the float
  action from tab context menus — a product decision, recorded here:
  floating windows were never part of the fork's dock design and the
  owner's complaint names the artifact; reversible in one line.
- Defense-in-depth (covers the web build + any pointer-backend path where
  app-region is absent/inert): a CAPTURE-phase `dragstart` listener on
  the dockview container that calls preventDefault when the target is a
  band void container — this lands on dockview's own supported cancel
  branch (backend dragstart checks event.defaultPrevented FIRST, before
  getData), so nothing leaks (critique B3's clean cancel point).
  Red-first headless test per critique m6: the repo's jsdom+dockview
  harness precedent (evidence/task-108-f7-headless-repro/, referenced
  from DockviewLayout.tsx) — construct a dock, synthetic dragstart on a
  band void, assert defaultPrevented AND LocalSelectionTransfer empty.
- KNOWN, ACCEPTED: the non-Electron web build on a TOUCHSCREEN keeps the
  pointer-backend group drag from band voids (critique m2 — pointer drags
  are manually driven; preventDefault doesn't cancel them; no app-region
  in browsers). Desktop-first product; recorded, not fixed.

### B. The corner cell (replaces the full-width strip)

- `WorkspaceChromeStrip` in `_chat.tsx` becomes a fixed-width absolute
  top-left corner: lights inset (reuse `resolveWorkspaceChromeInsetStyle`)
  - `SidebarBrand` + the sidebar toggle (wiring unchanged — round-11
    verified it is strip-independent). The cell stays INSIDE SidebarProvider
    (the brand's `--workspace-titlebar-content-left` margin resolves only
    under `[data-slot="sidebar-wrapper"]` — critique M3 fit-check).
- HEIGHT: the corner locally overrides
  `--workspace-topbar-height: var(--dv-tabs-and-actions-container-height)`
  (36px). The GLOBAL token stays 52px — it is consumed by ChatView's
  panel-internal topbar, RightPanelTabs, settings, and more (critique M3
  enumerates); changing it globally is forbidden. SidebarChromeHeader's
  28px brand fits a 36px row (verified).
- The corner width is a CSS var (`--workspace-corner-width`) the padding
  helper also reads — single source.
- NARROW-COLUMN RULE (critique M4): give the Sidebar panel definition a
  `minWidth` >= the corner width so the (0,0) group can never be narrower
  than the corner (the constraints plumbing derives group minimumWidth
  from definition.minWidth). Helper fixture covers a hypothetical
  narrower-than-corner (0,0) group anyway: cap the padding at the group's
  own width so the tab strip never renders fully off-canvas.
- Traffic lights: `trafficLightPosition: { x: 16, y: 10 }`
  (DesktopWindow.ts:199) — grounded, not guessed: the shipped y:18 against
  the 52px band satisfies y=(band−16)/2 exactly, so y:10 for 36px follows
  the confirmed model; screenshot-confirm in round 12 (critique m3).
- The provider drops the strip ROW; the dock returns to full height. The
  corner OVERLAYS. Acceptance asserts "dock bottom edge == viewport
  bottom edge" (critique m5 — the removal fixes a latent 52px overflow
  chain; assert it, don't hedge).
- DockControlsCluster (absolute top-right of the dock) now sits inside
  the band next to the rightmost group's strip — pre-existing placement,
  not a regression, but it is inside the "clean" band now; owner
  adjudicates on the build (critique m4). No change this pass.
- `_chat.index.tsx` hosted-static header: re-check against the CORNER;
  smallest change avoiding double-branding.

## Non-goals

- No dockview API vetoes (dropped by design — see above).
- No Windows/Linux titlebar work; no pointer-backend dnd work; no
  sidebar-group pinning (doesn't exist); settings-route chrome untouched.
- Floating groups stay DISABLED unless the owner asks for them back.

## Tests

- Pure: the top-row/corner-target helper — red-first (owns-(0,0), hidden
  first group, narrower-than-corner cap, empty groups).
- Headless jsdom: the capture dragstart cancel (defaultPrevented + empty
  LocalSelectionTransfer) — red-first against no-listener.
- Render: corner renders brand + toggle + `.drag-region`; full-width
  strip absent (anchored).
- Full web suite green; typecheck exit 0.

## Acceptance (packaged build, round 12)

1. Driver: ONE band — corner + tab strips at the same 36px height; no
   full-width strip; dock bottom edge == viewport bottom edge.
2. Driver: tab dnd intact — drag a tab onto another group's TAB, lands;
   drag within the band, overlays appear ONLY during that tab drag.
3. Owner-eye: empty band space drags the WINDOW; no highlights or
   "multiple panels" view from empty space (click, drag, shift+drag);
   traffic lights centered in the band; fullscreen drops the inset.
4. Owner-eye: drag the Sidebar tab elsewhere → corner clearance follows
   the new (0,0) group; sash the sidebar to its minimum → tab strip
   never disappears under the corner.
