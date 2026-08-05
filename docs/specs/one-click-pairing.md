# Spec — one click sets up EVERYTHING: auto-pairing via a Library handoff

Repo: `~/Projects/t3code-fork`, branch `workbench/dock-port`. Part of #129.
Owner ruling, verbatim: "setup integrations should setup everything. what is
the bottleneck? we don't want multiple setups."

## The design (ratified)

The manual mint-and-paste pairing step is a leftover of the pre-one-click
package design. Both halves of its replacement ALREADY EXIST:

- Server: the pairing-credential mint used by Connections' "Create link"
  (`EnvironmentAuth.createPairingLink`/`createPairingCredential` —
  `apps/server/src/auth/EnvironmentAuth.ts:769+`). Credentials minted there
  appear in the authorized-clients list and are revocable.
- Unity package: a full redemption flow — `EditorPresenceSettings.cs` "redeems
  a pasted credential (or the full pairing URL)" via
  `POST /api/auth/pairing-token` and stores the resulting bearer token in
  EditorPrefs (its own doc comment, "the one-time pairing flow"; see
  `docs/workbench/engine-credential-flow.md`).

The new work is ONLY the handoff between them:

1. **Server, during the install click** (the same
   `UnityPipelineInstallRoute` dispatch that installs both packages): mint a
   pairing credential scoped exactly as Connections' "Operate tasks" option
   does, labeled per project ("Unity selection — <project title>"), and write
   `<projectRoot>/Library/com.ironmind.editor-presence/pairing.json`:
   `{ "serverUrl": "<this backend's own base url>", "pairingCredential": "…" }`.
   - `Library/` because it is universally git-ignored (every Unity template)
     and per-machine — the credential structurally cannot be committed.
   - Idempotence: if the package is ALREADY paired (probe fact
     `selectionPublisherRegistered` true) skip minting entirely; if an
     unredeemed pairing.json already exists, replace it (mint fresh —
     credentials are one-time and may have expired).
   - The install result contract gains a pairing-outcome field (minted /
     already-paired / skipped-with-reason). Client toast copy mentions it
     briefly.

2. **Unity package (C#), on load** (editor initialization, same lifecycle
   that starts the connection): if `HasBearerToken` is false AND
   `Library/com.ironmind.editor-presence/pairing.json` exists under the
   CURRENT project → read it, set ServerUrl, run the EXISTING redemption
   code path with the credential, and on success DELETE the file. On
   redemption failure, leave the file (a fresh install click replaces it)
   and surface the existing failure state in the package's Preferences pane
   — do not invent new UI.
   - Bump the package version (0.2.0 → 0.3.0) so the server-side embedded
     copy's replace-on-version-difference triggers on the next click.
   - Follow the package's UNVERIFIED.md discipline: list any claim you
     could not verify without a live Editor.

3. **Messages**: S10's sentence changes from mint-and-paste instructions to
   the honest new reality — pairing is automatic on install; S10 should now
   only be reachable when auto-pairing failed, so say that and point at the
   one recovery action (click Setup Unity Integrations again).
   `EngineToolbar` gating is unchanged (S10 still never offers the CTA…
   ACTUALLY REVERSE THIS: with auto-pairing, a re-click IS now the recovery
   for S10 — `shouldOfferUnityPipelineInstall` should offer at S10 as well
   (selection installed but not paired ⇒ a click re-mints and re-hands off).
   Red-first test for that gating change; update the S10-withheld test.

## Security constraints (review will check these)

- The credential written to disk is the ONE-TIME, short-lived pairing
  credential — never the long-lived bearer token. The bearer stays where it
  already lives (EditorPrefs), written only by the existing redemption path.
- Mint through the SAME store Connections uses so every auto-minted
  credential is visible and revocable in the authorized-clients list.
  No new scope, no scope widening: exactly what the manual flow minted.
- The file is deleted on successful redemption; a stale unredeemed file is
  replaced on the next install click.
- No path from the wire chooses where pairing.json goes — the server derives
  it from the SAME projection-resolved workspaceRoot the install already
  uses (the #128 trust model, unchanged).

## Acceptance

1. Server tests (red-first): install with selection unpaired ⇒ credential
   minted + file written under the resolved root; install when
   `selectionPublisherRegistered` ⇒ NO mint; unreadable Library dir ⇒ typed,
   honest partial-failure in the result (install of packages still reported
   truthfully); the file's content decodes against a contract schema.
2. Gating test (red-first): S10 facts now OFFER the install CTA; S10-withheld
   test updated to a genuinely unfixable state.
3. C# compiles is NOT verifiable here — state that plainly; the package
   change lists its unverified claims per UNVERIFIED.md discipline. Keep the
   C# additive and small: config read + existing-redeem call + delete.
4. `pnpm typecheck` Found-line at baseline (Found 14 errors in 2 files);
   `pnpm test` green; verbatim outputs in the report.

## Non-goals

- No changes to EditorPresenceRoute scopes or the redemption endpoint.
- No new Unity UI. No deep links. No changes under apps/web/src/dock/\*\*.
- Do not migrate UnityCommandRoute (still separately tracked).
