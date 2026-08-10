# Spec — Unity publishes live play state over presence; toolbar prefers it

Repo: `~/Projects/t3code-fork`, branch `workbench/upstream-20260806`. Owner
bug (2026-08-10, task #136, screenshot): started Play through the harness,
stopped inside Unity, harness toolbar kept "playing"; clicking harness Stop
then discovered Unity was already stopped. "Should be more stateful if
possible."

## Confirmed facts (research-verified — do not re-derive)

- The harness's Unity play state is COMMAND-ECHO only: local state at
  `ChatView.tsx:1602`, written only at `:1737` on a successful harness
  dispatch, reset per project by the effect at `:1603-1605`, consumed via
  `resolveEngineToolbarView`'s unity-cli branch at
  `EngineToolbar.logic.ts:461` (`playState: input.unityPlayState ?? null`).
  Nothing updates it when the user acts inside Unity.
- The presence protocol ALREADY defines playState as a level
  (`apps/web/src/editorPresence/protocol.ts:53`, union
  `"stopped"|"playing"|"paused"`), and the SERVER already implements and
  TESTS the full relay: `parsePlayState` → route case `"playState"`
  (`EditorPresenceRoute.ts:301-311`, gated only on a prior hello) →
  `updatePublisherPlayState` (`EditorPresenceRegistry.ts:599-612`) →
  broadcast. `registerPublisher` resets playState to null on every
  (re)registration EXPECTING a fresh frame right after hello
  (`EditorPresenceRegistry.ts:487-495`; test at
  `EditorPresenceRegistry.test.ts:254`). The server-side protocol doc
  states the contract: "Sent once right after `hello` on every
  (re)connect… and again on every actual change"
  (`apps/server/src/editorPresence/protocol.ts:373-383`). ZERO server
  changes in this task.
- THE CAPABILITY TRAP DOES NOT FIRE: dispatch routing is hardcoded on
  engine type (`resolveEngineDispatchBackend`,
  `EngineToolbar.logic.ts:95-105` — unity → "unity-cli" unconditionally),
  and the server accepts a playState frame from a publisher that
  advertised no play capabilities (no capability check anywhere on the
  relay path). Unity keeps `capabilities: []` — publishing playState never
  reroutes Play/Stop dispatch off the CLI path.
- The web plumbing ALREADY delivers a connected Unity editor to the
  toolbar: the Unity package sends hello today (selection chips work), so
  `connectedProjectEditor` (`ChatView.tsx:1585`, via
  `resolveProjectEditor.ts:35-47`) resolves for Unity projects and is
  passed into `resolveEngineToolbarView` as `connectedEditor` — where the
  unity-cli branch currently drops it on the floor. The test at
  `EngineToolbar.test.ts:479-486` ("ignores any connectedEditor passed
  in — Unity never appears in the presence feed") locks the obsolete
  assumption and flips red-first.
- Unity package internals (`unity/com.ironmind.editor-presence/Editor/`):
  `[InitializeOnLoad]` connection with EditorPrefs bearer, ≤3s reconnect
  pump, SessionState-backed session id (survives domain reload → server
  treats reconnect as same-identity takeover). Selection publishing shape
  to mirror exactly: event sets a dirty flag → `EditorApplication.update`
  pump with 100ms debounce → build frame from LIVE state → fire-and-forget
  send that silently no-ops when the socket isn't open
  (`EditorPresenceSelectionWatcher.cs`).
- GROUND-TRUTH CORRECTION: Godot does NOT publish playState today either
  (addon sends hello/selection/ping/commandResult only) — Unity will be
  the first publisher. Godot's mirror-image gap is filed separately, NOT
  fixed here.

## Scope

### A. Unity package 0.3.1 — a playState publisher mirroring the selection watcher

New `Editor/EditorPresencePlayStateWatcher.cs`, `[InitializeOnLoad]`,
mirroring `EditorPresenceSelectionWatcher.cs`'s structure exactly:

- Subscribe `EditorApplication.playModeStateChanged` AND
  `EditorApplication.pauseStateChanged` (orthogonal: pausing fires no
  playModeStateChanged and does not reload the domain). Handlers only set
  a dirty flag — no work in the callback.
- Publish from the `EditorApplication.update` pump (same 100ms debounce
  constant), computing the state LIVE at send time — never inferred from
  which enum value fired: `EditorApplication.isPlaying ?
(EditorApplication.isPaused ? "paused" : "playing") : "stopped"`.
  Transitional phases (ExitingEditMode/ExitingPlayMode) need no special
  casing: the domain reload disconnects the socket anyway, and the
  post-reload reconnect republishes the settled state (below).
- THE RECONNECT CONTRACT (the server's stated expectation): a playState
  frame is sent once right after `hello` on every (re)connect. MECHANISM
  IS MANDATED (critique F1 — the alternative loses the frame): the send is
  a DIRECT, AWAITED call inside `ConnectAndRunAsync`, between
  `await SendHelloAsync()` (EditorPresenceConnection.cs:225) and
  `await ReceiveUntilClosedAsync(...)` (:227). Rationale: state flips to
  Connected BEFORE hello is awaited (:224), so any pump/StateChanged-driven
  publish can race hello on the wire — and the server drops a playState
  frame arriving before registration (EditorPresenceRoute.ts:307)
  SILENTLY, leaving the null window permanent until the next real change;
  concurrent SendAsync on one ClientWebSocket is also unordered/unsafe and
  the send helper swallows exceptions. Awaited-in-sequence = single
  writer, guaranteed ordering, no heartbeat needed. The watcher then
  publishes ONLY on change (debounced), never on connect. Because
  `[InitializeOnLoad]` reruns after every domain reload and the connection
  pump reconnects within ~3s, this rule also delivers the EnteredPlayMode
  state after the play-mode reload with no extra machinery.
- Frame shape: `{v:1, type:"playState", playState:"stopped"|"playing"|
"paused"}` (the server's `parsePlayState` shape). Fire-and-forget via
  the connection's existing send helper; silent no-op when disconnected.
- `capabilities` stays `[]` — unchanged.
- Supersession sweep (critique F5) — ALL of these currently assert this
  change is impossible or absent; each gets the dated supersession
  treatment, not deletion:
  `EditorPresenceProtocol.cs` header ("no playState frame is ever sent");
  `EditorPresenceConnection.cs:1-8` ("sends hello and selection … never
  sends … anything else"); `package.json:5` description + `:7-13` keywords
  ("Selection-only …" — USER-VISIBLE in Unity's Package Manager; reword to
  selection + play-state reporting); `unity/README.md:43-46`;
  `EngineToolbar.logic.ts:81-84` ("unity-cli … never appears in the
  presence feed"), `:296-299`, `:376-380`, `:538-541` (all three state
  play state is caller-supplied-only); and
  `apps/web/src/editorPresence/protocol.ts:77-80` (documents null as the
  steady state for a no-play-capability publisher — Unity now reports
  playState with `capabilities: []`; supersede so its frames don't read
  as a protocol violation).
- Bump `package.json` to `0.3.1`. The version bump is LOAD-BEARING:
  `installUnityEmbeddedSelectionPackage` replaces the on-disk package only
  on a manifest-version mismatch (UnityEmbeddedSelectionPackage.ts:88-105).
  DELIVERY SCOPING (critique F2, decided): there is currently NO
  user-reachable trigger to re-run the install where 0.3.0 is already
  installed — the Setup CTA hides once `selectionPackage.installed` is
  true (presence/disk only, no version term; EngineToolbar.logic.ts:215,
  UnitySetupProbe.ts:198). THIS round rolls 0.3.1 onto the rig by invoking
  the install route/CLI directly plus an external `package_resolve` (state
  it in the round evidence); the product-level delivery path (a version
  term in the setup facts re-offering the CTA when the embedded package is
  newer — the "versioning" the owner already named as later work) is filed
  as its own task alongside #130, NOT built here.
- Ship a committed `.meta` for the new `.cs` file, matching the package's
  existing convention (all 8 current Editor scripts have one; the install
  copy is verbatim, and #65 records this repo's .meta hygiene as a live
  concern). (critique F7)

### B. Web — the one-line merge point plus honest comments

- `EngineToolbar.logic.ts:461` (unity-cli branch) becomes:
  `playState: connectedEditor?.playState ?? input.unityPlayState ?? null,`
  with a doc comment carrying the precedence rationale: presence wins
  WHENEVER non-null because it is a level sourced from Unity's own
  callbacks and republished in full on every reconnect (protocol.ts's own
  design principle); the echo is a one-shot snapshot that can go stale the
  moment the user acts inside Unity, so it is only the fallback for
  presence-has-no-opinion (no publisher connected, an older package that
  never sent a frame, or the momentary post-reconnect null window).
  Post-click transient: after a harness Play, presence may say "stopped"
  for a sub-second until Unity's callback fires — intentional; the reverse
  choice reintroduces #136 in miniature. During Unity's play-mode domain
  reload the publisher DISCONNECTS, so `connectedEditor` is null and the
  echo bridges the gap. HONEST BOUND (critique F4): this composition holds
  only while disconnections are short — the echo carries no age and no
  invalidation, so a LONG presence outage (credential rejection halting
  reconnect, a backend restart, #113's degraded pairing) reverts the
  toolbar to exactly today's echo-only behavior until presence returns.
  That is the status quo, not a regression; the comment must say so
  rather than claim unconditional composition.
- STALE-PUBLISHER GUARD (critique F3 — without this the fix reproduces
  #136): a crashed/force-quit Unity leaves a half-open registry entry
  (`connected` is never written false; no liveness sweep; the Unity
  package sends no ping), and a relaunched editor registers as a SECOND
  publisher (fresh SessionState id) sharing the same workspace root —
  first-match resolution in `resolveConnectedEditorForProject`
  (resolveProjectEditor.ts:43-47) would let the corpse's stale "playing"
  outrank the live editor forever. Fix in the pure function: among
  same-root connected matches, prefer the entry with the newest
  `lastSeenAt` if the wire entry carries it; if it does not, prefer the
  LAST matching entry (registration order — the live re-registration is
  newest). Verify the actual wire shape first and state which variant
  shipped; red-first test with two same-root entries (stale-first) in
  `resolveProjectEditor.test.ts`. This also fixes the same ambiguity for
  selection chips.
- Flip `EngineToolbar.test.ts:479-486` red-first: connectedEditor with a
  playState now WINS for the unity-cli backend; add cases for the
  fallback (presence null → echo) and both-null → null.
- `hasConnectedEditor` stays `false` for the unity-cli branch (its
  consumers only pick between generic disabled-copy strings) — but its
  doc comment (:277-283, "no publisher, ever") is rewritten: the field
  means "presence-DRIVEN controls", which unity-cli's are not, even
  though a Unity presence publisher now exists and feeds playState.
  (critique F6)
- Update the obsolete comment at `ChatView.tsx:1595-1601` ("Unity has no
  presence feed to read a play state from") — supersede with date: it does
  now (package ≥0.3.1); the echo path stays as the fallback and the
  per-project reset stays load-bearing for it.
- Fix the stale parenthetical in `EditorPresenceRegistry.ts` (~:487-495
  region) claiming "Unity no longer publishes through this registry at
  all" — Unity publishes hello/selection today and playState as of this
  task.

## Non-goals

- No server behavior changes (comment fix only).
- No Godot playState publishing (filed as its own follow-up task).
- No capability advertising, no dispatch-path changes, no #130.
- No new UI states — the existing toolbar faces (play/stop toggle, pause
  latch) just start tracking reality.

## Tests

- Web: the flipped + new `resolveEngineToolbarView` cases above (red-first
  where expressible). Full web suite green; typecheck exit 0.
- C#: no in-repo Unity test harness exists — the proof is the live rig
  round below. State that plainly in the report; do not fake a harness.

## Acceptance (live rig round, packaged build + 0.3.1 rolled onto Mafia)

1. Harness Play → Unity enters play mode → toolbar shows playing (existing
   behavior, now presence-confirmed after the reload reconnect).
2. THE OWNER'S REPRO, driver-verified: with play running, stop the editor
   EXTERNALLY (pipeline CLI `editor_stop` or eval `isPlaying=false` —
   indistinguishable from the user clicking stop in Unity, since the
   harness issues nothing) → the toolbar flips to stopped WITHOUT any
   harness click, within a few seconds.
3. External pause (`editor_pause`) while playing → toolbar pause latch
   engages without a harness click.
4. UNITY-INITIATED PLAY, harness idle (critique F8 — the other half of
   #136): with the harness having issued nothing, start play mode
   externally (eval `EditorApplication.isPlaying = true`) → the toolbar
   toggle flips to the Stop face without any harness click. This also
   exercises the play-mode domain-reload disconnect→reconnect→post-hello
   republish end to end — the mechanism the whole design rests on.
5. PRESENCE-OUTAGE OBSERVATION (critique F4): kill the presence socket
   mid-play (quit the Unity editor or block the connection) and record
   what the toolbar shows — expected: falls back to the echo's last
   value (today's behavior), documented in the round report, not hidden.
6. Round evidence names the build commit and the package version it
   exercised, and states HOW 0.3.1 was rolled on (direct install-route/
   CLI invocation + external package_resolve, per the delivery scoping).
