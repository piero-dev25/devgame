# Where an engine plugin's credential actually comes from

Established by trying to get one and failing three times, then reading the
server. Written down because all three engine plugins tell a user how to
authenticate in their README, and getting this wrong sends people to a code
that cannot work.

## The wrong answer, and why it looks right

At boot the server prints a pairing URL with a 12-character code:

```
Authentication required. Open T3 Code using the pairing URL.
  pairingUrl: http://localhost:13790/pair#token=XXXXXXXXXXXX
```

It is extremely tempting to hand that code to a headless engine plugin and
exchange it at `POST /oauth/token`. That fails, every time, with
`{"code":"auth_invalid","reason":"invalid_credential"}` — and the failure is
identical for a fresh code redeemed within a second of issuance, so it does
not look like expiry and it is not.

**What is established, and what is not.** The server rejects it with
`invalid_credential`, which `toBootstrapExchangeError` produces from a
_credential-not-found_ result. So the lookup does not find the printed code —
that much is observed, reproducibly, on a freshly booted server with the code
redeemed a second after issuance.

The mechanism is NOT established, and three plausible explanations were each
checked and eliminated:

- Not truncation on my side. `PAIRING_TOKEN_ALPHABET` is uppercase and digits
  only and `PAIRING_TOKEN_LENGTH` is 12, matching exactly what was extracted.
- Not proof-key binding. `issueStartupPairingCredential` calls
  `issuePairingCredentialForSubject` with no `proofKeyThumbprint`, so a bearer
  exchange presenting none should not mismatch.
- Not a scope refusal. The startup grant carries `AuthAdministrativeScopes`, a
  superset of what was requested, and an insufficient-scope path returns
  `ServerAuthScopeNotGrantedError`, a different error.

The remaining candidate is that a `purpose: "startup"` link is not eligible for
`pairingLinks.consumeAvailable`, but that was not confirmed. **Do not cite a
cause for this until someone reads `consumeAvailable`'s filter.** The practical
guidance below does not depend on knowing the answer.

## The right answer

An engine plugin is a **bearer-paired device**, and its credential is minted
_by the already-paired app_:

1. The user pairs the app itself with the startup URL (DPoP). This is the
   normal first-run they already do.
2. From the paired app, mint a device credential — `POST
/api/auth/pairing-token`, which is authenticated and issues a grant with
   `method: "bearer-access-token"`.
3. The plugin redeems that credential at `POST /oauth/token`, form-urlencoded:
   - `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`
   - `subject_token=<the minted credential>`
   - `subject_token_type=urn:t3:params:oauth:token-type:environment-bootstrap`
   - `requested_token_type=urn:ietf:params:oauth:token-type:access_token`
   - `scope=orchestration:read orchestration:operate terminal:operate review:write relay:read`
   - `client_label=<something the user will recognise in the device list>`
4. It stores the returned `access_token` and sends it as
   `Authorization: Bearer …` on the WebSocket handshake.

Step 3 is exactly what the Unreal plugin's `redeem_pairing_credential()` and
the Unity package's settings flow already implement — **their code is right,
only the documented source of the credential needed pinning down.** Do not
change them; make sure their READMEs say "mint a device token from the paired
app", never "use the code the server printed at startup".

## The bit that is worth remembering

The body must also carry `scope` and `client_label`; the real client sends
both (`packages/client-runtime/src/connection/onboarding.test.ts`), and
`client_label` is what the user sees when deciding whether to revoke a device
later. A plugin that omits it shows up as an anonymous entry in the device
list, which is a bad thing to hand someone whose editor is now talking to
their machine.

The request is **form-urlencoded**, not JSON —
`AuthTokenExchangeRequest.pipe(HttpApiSchema.asFormUrlEncoded())` in
`packages/contracts/src/auth.ts`.
