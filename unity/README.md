# T3 Editor Presence — Unity package

Streams the current Unity Editor selection (GameObjects and Project window
assets) to a T3 Code chat composer, over the Editor Presence Protocol (EPP)
— see `docs/workbench/spec-editor-presence.md` in this repo for the
protocol itself, and `apps/server/src/editorPresence/protocol.ts` for the
exact wire contract this package implements.

An editor-only UPM package (`com.ironmind.editor-presence`): pure C#, no
external DLLs, uses `System.Net.WebSockets.ClientWebSocket` (already
available at this project's `.NET Standard 2.1` API compatibility level) so
nothing is vendored. Nothing here ships in a player build.

**Unity was not installed on the machine this package (or its later
cross-engine audit fixes) were built on — none of this C# has been
compiled or run.** See `UNVERIFIED.md` in this directory for exactly which
claims about `ClientWebSocket`, `SessionState`, and the rest of the Editor
API have not been confirmed, before trusting this package in a real
project.

## Install

1. Copy the `com.ironmind.editor-presence/` folder (the one directly
   containing `package.json`) into your project's `Packages/` directory —
   or add it to `Packages/manifest.json` as a local or git-URL dependency,
   whichever your project's convention is. There is no compile step; Unity
   picks the package up automatically.
2. Open (or focus) the Unity Editor. The package's `[InitializeOnLoad]`
   classes start automatically — no explicit "enable" step, unlike the
   Unreal plugin, since this is a plain C# assembly, not something that
   needs a separate scripting backend turned on.
3. If you have not already paired a T3 app (web/desktop/mobile) with your
   server, do that first — the normal first-run flow, via the pairing URL
   the server prints at its own startup. **That startup code is for
   pairing the app itself, and cannot be redeemed directly by this
   package — see "Credential flow" below before assuming otherwise.**
4. From the ALREADY-PAIRED app: **Settings ▸ Connections ▸ Pairing links ▸
   Create link**. This mints a one-time device pairing token — a
   different, plugin-usable credential from the startup code in step 3.
   Copy it.
5. In the Unity Editor: **Edit ▸ Preferences ▸ T3 Editor Presence** (macOS:
   **Unity ▸ Settings**). Paste what you copied in step 4 into the "Device
   pairing token or URL" field, then click **Pair**.
6. The connection starts automatically once pairing succeeds — no separate
   "connect" step. Watch the status dot in the Scene view's overlay
   toolbar (or the Preferences page's own status row) go
   connecting → connected.
7. Select a GameObject in the Hierarchy, or an asset in the Project
   window. A chip appears in the T3 composer.

No compiler step beyond what Unity already does for any C# in your
project — this package is source, not a prebuilt DLL, so it participates
in your project's normal domain-reload/recompile cycle like everything
else in `Assets/` or `Packages/`.

## Credential flow

**The server's own startup pairing code cannot be redeemed by this
package.** At boot the server prints something like:

```
Authentication required. Open T3 Code using the pairing URL.
  pairingUrl: http://localhost:13790/pair#token=XXXXXXXXXXXX
```

That code is for pairing an actual T3 app (web/desktop/mobile) — the
normal first-run flow a person does once. Handing that specific code to
this package fails every time with an `invalid_credential` error,
including on a freshly-issued code redeemed a second after printing, so it
does not look like an expiry problem and it is not one. See
`docs/workbench/engine-credential-flow.md` for the full investigation; the
exact mechanism of the failure is not established there (three
explanations were checked and eliminated, one remains a
plausible-but-unconfirmed suspect) — what matters here is only that the
flow below is the one that works.

**The flow that works:** this package is a bearer-paired device, like T3's
mobile app, and its credential comes from an app you have already paired,
not from the server's own startup screen:

1. Pair a T3 app with the server once, the normal way (the startup URL
   above).
2. From that already-paired app: **Settings ▸ Connections ▸ Pairing links
   ▸ Create link** — a different action from the startup screen, mints a
   device pairing token via an authenticated request
   (`POST /api/auth/pairing-token`).
3. Paste THAT token into the Preferences page (install step 5) and click
   **Pair**. `EditorPresenceSettings.RedeemPairingCredential` exchanges it
   at `/oauth/token` — the mechanism was already correct in this package;
   the missing piece was a `scope` field on that request (now added — see
   `EditorPresenceSettings.cs`) and, separately, this documentation
   previously pointing at the wrong source for the credential.

`client_label` is sent as `"Unity Editor"` on that redeem request — this
is what shows up in the paired app's device list if you ever need to find
and revoke this specific editor's access.

The redeemed bearer token is stored in `EditorPrefs`, which is per-machine
(shared across every project this Editor install opens), not per-project —
acceptable since the token authorizes a specific _server_, not a specific
project; `workspace.root` in the `hello` frame is what tells the server
which project a given connection belongs to. There is currently no
environment-variable override for CI use the way the sibling Unreal plugin
has (`T3_EDITOR_PRESENCE_TOKEN`) — pairing through the Preferences page is
the only path today.

## Where's the status indicator?

Two places, both always available, no engine-version-dependent fallback
chain the way Unreal's toolbar-anchor search needs (Unity's `Overlay` API
and `SettingsProvider` are both stable, documented UPM-package surfaces):

- A small dot in the **Scene view's overlay toolbar** ("T3 Editor
  Presence") — green/connected, yellow/connecting, red/disconnected, with
  a distinct "rejected" label and tooltip (see below) when the server has
  rejected your credential.
- The **Preferences ▸ T3 Editor Presence** page's own status row, plus a
  **Retry now** button that only appears when a credential rejection is
  halting the automatic reconnect loop.

Every connection-state transition is also logged to the Console
(`[T3 Editor Presence] ...`) as a backstop, same convention as the Unreal
plugin's Output Log lines.

## Credential-rejection handling

The server always reads the close code and reason it sent and shows that
reason **verbatim** in both the overlay tooltip and the Preferences page,
rather than a generic "disconnected" message. What happens next depends on
_which_ close code:

- **4400 (no credential presented) or 4401 (invalid/expired credential):**
  this package **stops trying to reconnect automatically.** Retrying with
  the same rejected credential every few seconds cannot succeed — it only
  hammers the server and spams the Console. Fix the token (re-pair, per
  "Credential flow" above), or click **Retry now** once you believe the
  problem is resolved.
- **Any other close code the server sends, including one this package
  does not specifically recognize (e.g. 4500, server internal error):**
  the reason is still shown verbatim, but this package **keeps retrying
  automatically** on the existing fixed interval. A momentary server fault
  is transient by definition, and an unrecognized failure is more likely
  to be transient than to be a problem with your specific credential — see
  `docs/workbench/godot-probe-findings.md`'s "Correction: '>= 4000 means
  stop retrying' was too coarse" for the reasoning (an earlier version of
  this package got this wrong: it halted for ANY close code ≥ 4000, which
  meant a single momentary server fault would have permanently
  disconnected every editor on every machine until each user noticed and
  clicked Retry).

A connection that merely can't be reached at all (server not running,
wrong URL, network down) behaves the same as the second case above: it
keeps retrying automatically, and reads as "cannot reach Workbench at
`<url>`" — a firewalled or otherwise-unreachable server never gets far
enough to reject anything.

## What "presence" means here

Whatever is selected right now — in the Hierarchy or the Project window —
appears as a chip in the T3 composer. Deselecting clears the chip; it is
not sticky. This package only ever sends the _current_ selection state,
never a history of it (see `docs/workbench/spec-editor-presence.md` for
why — "presence is a level, not an edge").

GameObjects and Project window assets are both supported through one
shared code path (`Selection.objects`, `EditorPresenceItemBuilder.Build`).
Multi-select publishes multiple chips, capped at 64 (the same cap the
server itself enforces); selecting more than that publishes the first 64
and logs a warning to the Console rather than silently dropping the rest
without saying so.

## Known limitations (stated, not hidden)

- **`kind` is finer-grained than the Unreal plugin's.** Unity reports
  `"gameobject"` for a GameObject and the lowercased C# type name for
  everything else (`"texture2d"`, `"material"`, `"audioclip"`, ...);
  Unreal reports a coarse `"actor"` or `"asset"`. This is intentional, not
  a bug to fix for consistency — `kind` is an explicitly open string per
  the protocol precisely so each engine can describe its own concepts at
  whatever granularity makes sense for it, and the client is required to
  render it, never switch on it.
- **`GlobalObjectId` stability is unmeasured.** Object identity
  (`GlobalObjectId.GetGlobalObjectIdSlow(obj).ToString()`) has never been
  exercised anywhere in a real project per the original build's grep, so
  its behavior across nested prefabs and its cost on a large multi-select
  are both unverified — see `UNVERIFIED.md`.
- **No environment-variable token override.** Unlike the Unreal plugin's
  `T3_EDITOR_PRESENCE_TOKEN`, there is currently no way to provide a token
  to this package without going through the Preferences page — no CI path
  exists today.
- **The fixed 3-second reconnect interval has no backoff or jitter** for
  ordinary (non-credential-rejection) disconnects. Several Unity Editors
  reconnecting to the same freshly-restarted server will all retry on the
  same cadence rather than spreading out — flagged in this package's own
  code as deferred hardening, not attempted in this pass.
- **Multi-select beyond 64 items is silently truncated on the wire** (a
  Console warning is logged locally, but EPP v1 has no field to tell the
  server or the chat client "there were more than this" — see
  `docs/workbench/spec-editor-presence.md`'s "Deliberately left out"
  section).

## What this package does NOT do

Same "deliberately left out" list as the protocol itself: no transform,
component list, scene graph, asset bytes, thumbnails, or previews; no
cursor/caret position; no editor→chat command channel (this package only
ever sends, never receives anything meaningful back — `ReceiveUntilClosedAsync`
exists solely to detect a server-initiated close, not to act on content).

## Development

**This C# cannot be compiled or run here.** Unity is not installed. Every
change in this package — including the fixes from the cross-engine
contract audit described below — is reviewed by inspection against
`apps/server/src/editorPresence/protocol.ts` and the sibling Unreal
plugin's (independently testable) Python implementation, not proven by a
build. See `UNVERIFIED.md` for the complete, honest list of what that
means concretely for each change.

## Cross-engine contract audit (2026-08-03)

Found and fixed against the authoritative `protocol.ts` and
`docs/workbench/engine-credential-flow.md`:

1. **Unnamed object labels vanished silently.** `label` is the only field
   the server requires to be non-empty; Unity permits an empty
   `Object.name`, and an item with a blank label was dropped from the
   frame with no error anywhere. Fixed with a `"(unnamed)"` fallback —
   `EditorPresenceItemBuilder.cs`.
2. **Truncation at the 64-item cap was silent.** Now logs a Console
   warning, matching the choice made on the Unreal side (there is no wire
   field for this — see `docs/workbench/spec-editor-presence.md`) —
   `EditorPresenceSelectionWatcher.cs`.
3. **`session.id` and the `seq` counter both reset on every domain
   reload**, which fires on every script compile and every Play press in
   a project with domain reload enabled. This violated the protocol's
   "session.id stable per editor-process launch" design intent
   (transient duplicate chips) and could, in the general case, make the
   server's `seq <= existing.seq` guard silently drop post-reload
   selection updates. Both are now backed by `SessionState`, which
   survives a domain reload — `EditorPresenceConnection.cs`,
   `EditorPresenceSelectionWatcher.cs`.
4. **Close codes were read and discarded.** The receive loop always closed
   with `WebSocketCloseStatus.NormalClosure` regardless of what the server
   actually sent. Now reads `CloseStatus`/`CloseStatusDescription` and
   surfaces the reason verbatim, and stops auto-reconnecting specifically
   for a credential rejection (close code 4400 or 4401) rather than
   hammering the server with the same rejected credential —
   `EditorPresenceConnection.cs`, `EditorPresenceSettingsProvider.cs`,
   `EditorPresenceStatusOverlay.cs`. First landed with a too-coarse "any
   code ≥ 4000 halts" rule, corrected the same day per
   `docs/workbench/godot-probe-findings.md`'s "Correction: '>= 4000 means
   stop retrying' was too coarse" — an unrecognized code like 4500 (server
   internal error) now correctly keeps retrying instead of permanently
   disconnecting every editor on a momentary server fault. See
   "Credential-rejection handling" above.
5. **The redeem request was missing a required `scope` field.** Present in
   the real client's request (`packages/client-runtime/src/authorization/remote.ts`)
   and called out explicitly in `docs/workbench/engine-credential-flow.md`;
   `scope` is optional server-side so this was not a hard failure, but it
   left the granted scope set implicit rather than a stated fact of the
   request — `EditorPresenceSettings.cs`.
6. **This README did not exist**, and the credential-flow instructions
   that existed only in code comments pointed at the server's startup
   pairing code — the one credential source confirmed NOT to work for a
   headless client. Corrected throughout.

Not fixed, and why: the fixed 3-second reconnect interval / no
backoff-jitter for ordinary disconnects (flagged in this package's own
code as explicitly deferred "step 5" hardening in the original build, out
of scope for a contract-conformance audit); the CI/environment-variable
token path (a feature gap versus Unreal, not a protocol-conformance bug).
