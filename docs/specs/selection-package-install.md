# Spec — Setup Unity Integrations installs the selection package too (Phase A)

Repo: `~/Projects/t3code-fork`, branch `workbench/dock-port`. Part of #129.

## Why

Owner selected objects in Unity (Mafia Game, Pipeline package installed and
live) and no selection chip appeared in the composer. Correct by
construction: chips ride the editor-presence publisher, which for Unity is
DevGame's OWN package `com.ironmind.editor-presence` (in-repo at
`unity/com.ironmind.editor-presence/` — a selection-only REBUILD; read its
`UNVERIFIED.md` first). The one-click install adds only `com.unity.pipeline`
(round-4 manifest diff: exactly one line). The owner's project sits at S9:
"Unity selection chips are off…".

## Scope — the mechanical half only

Phase B (where the pairing token surfaces in the UI) is deliberately NOT in
this spec; it needs a design pass. Do not build any token-issuance UI.

### 1. Install both packages (`apps/server/src/unity/`)

Extend the install path so one click delivers BOTH:

- `com.unity.pipeline` — exactly as today, via `unity pipeline install`.
- `com.ironmind.editor-presence` — as an EMBEDDED package: copy the package
  directory into `<projectRoot>/Packages/com.ironmind.editor-presence/`.
  Unity auto-resolves embedded packages with no manifest edit — the same
  install shape Bezi uses. Deliberately NOT a `file:` manifest reference: an
  absolute path in the manifest breaks the moment the app moves or ships,
  and a relative one breaks for any project outside this repo.
- Source resolution for the copy, in order: (a) a bundled copy inside the
  packaged app's resources — add it to the desktop artifact build
  (`scripts/build-desktop-artifact.ts`) so shipped installs work; (b) dev
  fallback to the repo's `unity/com.ironmind.editor-presence`. Resolve
  server-side; never accept a source path from the wire.
- Idempotence: if the destination exists, compare the package.json `version`
  — same version ⇒ no-op success; different ⇒ replace the directory whole
  (delete + copy, never merge). Report which happened in the result.
- Do NOT copy `.meta` files' owner-side churn concerns onto the project:
  copy the package EXACTLY as it exists in-repo (its .meta files are part of
  the package and must come along).
- The install result contract gains a field reporting the selection-package
  outcome alongside the pipeline outcome (extend
  `UnityPipelineInstallResult`'s success shape; keep the error union's
  existing tags). Client toast copy: mention both, briefly.

### 2. Fix the two stale doc surfaces

- `UnityPipelineClient.ts` header: still claims `com.ironmind.editor-presence`
  "has since been DELETED entirely… no Editor Presence publisher at all."
  False since the rebuild. Rewrite to the current truth (deleted, then
  rebuilt selection-only; Pipeline owns play/stop/status; the rebuild owns
  selection publishing).
- `UnitySetupClassifier.ts` S10_MESSAGE: says "Pair it from Settings >
  Connections" — that panel was deleted (ebd4734a1). Reword to point at
  Unity's own Preferences pane (the package ships
  `EditorPresenceSettingsProvider`): e.g. "Unity has DevGame's selection
  package but isn't paired with this app yet. In Unity: Settings >
  DevGame Editor Presence, paste this app's pairing token." Keep it one
  plain true sentence; do not promise a UI affordance Phase B hasn't built.

### 3. Probe/classifier consequences

- After an embedded copy, `selectionPackageInstalled` must come true on the
  next probe. Verify how the probe computes that fact (packages-lock vs
  manifest vs Packages/ dir — `UnitySetupProbe.ts:186-196`) and make sure an
  EMBEDDED package (no manifest line) is detected. If the current fact
  derivation misses embedded packages, extend it (packages-lock.json lists
  embedded packages with `"source": "embedded"` once Unity resolves them —
  verify against a real lock file before relying on this).
- S13-style honesty: freshly copied but not yet resolved by Unity must NOT
  read as a failure. If the existing S-states don't already cover
  "selection package present on disk, Unity hasn't resolved it yet",
  say so in the report rather than inventing a new state silently.

## Non-goals

- No pairing-token UI (Phase B). No changes to EditorPresenceRoute, scopes,
  or PairingGrantStore.
- No changes under `apps/web/src/dock/**` or `dockActiveSelectionStore` —
  another lane owns those right now.
- Do not touch the Unity package's C# source.

## Acceptance

1. Route/unit tests: one install call reports both outcomes; embedded copy
   idempotence (same-version no-op, different-version replace) covered
   red-first with a temp-dir fixture.
2. Stale-comment greps: the two rewritten surfaces no longer contain
   "DELETED entirely" / "Settings > Connections" (control-grep something
   that must match in each file first).
3. `pnpm typecheck` — read the "Found N errors" summary (ANSI trap).
   Baseline: Found 14 errors in 2 files (pre-existing TS377026 fixture debt
   in UnityPackageLock.test.ts + UnityPipelineClient.test.ts). Any fixture
   you touch: migrate, don't add.
4. `pnpm test` green; verbatim summary in the report.
5. Report the desktop-artifact change and how the bundled path is resolved
   at runtime, explicitly — QA round 5 rebuilds the packaged app and clicks
   the CTA on Mafia Game (selection package already absent there), so the
   bundled-resources path is the one that will actually run.

## Git discipline

Explicit-path staging only; never add -A/., never stash. rx-dockleak may be
editing dock files concurrently.
