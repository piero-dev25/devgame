# Release Readiness Plan — `t3code-fork` → our product

**Prepared:** overnight audit synthesis, 5 audits + 3 build attempts, branch `workbench/dock-port`, repo `/Users/pieroherrera/Projects/t3code-fork`.
**Ask being answered:** "get the macOS, Windows and mobile applications ready, and TestFlight so we can publish."

---

## 1. The honest headline

You are **not close to publishable, and the reason is not code quality** — the mobile suite is green (607/607 tests, typecheck clean) and a full iOS app was compiled and launched on a simulator tonight with zero credentials. The gap is in three stacked layers: (a) **the fork still _is_ T3 Code** — bundle ID `com.t3tools.t3code`, Apple Team `ARK85ZXQ4Z`, Expo org `pingdotgg`, App Store app `6787819824`, npm package `t3` — every one of which is upstream's _live production identity_, not a placeholder; (b) **you have none of the accounts** — no Apple Developer Program, no Expo org, no Azure signing, no Vercel/Cloudflare/Clerk of our own; (c) **the machine can't build two of the three desktop targets** — the Rust `resource-monitor` native module has no toolchain installed, which kills local macOS _and_ Windows packaging before electron-builder is ever reached (verified: `spawn cargo ENOENT`). Realistically: **a TestFlight build in your hands is ~3–5 working days of engineering plus 1–7 days of Apple enrollment latency running in parallel**; **a signed macOS DMG is ~1 week**; **a Windows installer is ~1–2 weeks** and needs hardware or CI you don't have today; **a clean, legally safe public launch (marketing site, legal docs, telemetry) is 3–4 weeks calendar time**, dominated by waiting on account approvals and by one wide but mechanical rename sweep — not by architecture. There is also **one active defect class that would be embarrassing rather than merely incomplete**: as configured, our builds phone analytics into T3's PostHog project by default and would listen to T3's production OTA channel. Those are bugs, not branding.

---

## 2. Per platform

### 2.1 macOS (Electron, `apps/desktop`)

|                                          | Status                                                                                                                                                                                                                                                                                                                                                                               | Evidence                                                                                                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Packaging tool                           | `electron-builder` 26.15.6, config generated at runtime by `scripts/build-desktop-artifact.ts` (2157 lines) — **no** `electron-builder.yml`, no `build` key in package.json                                                                                                                                                                                                          | `find -iname "electron-builder*"` empty; config built in `createBuildConfig()` line 1524, written to a staged package.json line 1924                             |
| Local unsigned build supported?          | Yes by design — `pnpm dist:desktop:dmg:arm64`, scrubs `CSC_*`/`APPLE_API_*` from env, `--publish never`                                                                                                                                                                                                                                                                              | `scripts/build-desktop-artifact.ts:1996-2003`                                                                                                                    |
| Local unsigned build **actually works**? | **NO — hard blocker.** `stageResourceMonitor()` runs `cargo build --locked --release` unconditionally (even with `--skip-build`); Rust is not installed on this Mac                                                                                                                                                                                                                  | `which cargo` → not found; the Windows attempt died at exactly this line: `PlatformError: NotFound: ChildProcess.spawn (cargo build ...)` / `spawn cargo ENOENT` |
| Node version                             | Requires Node 24 (`engines: ^24.13.1`); shell default is v22.23.1                                                                                                                                                                                                                                                                                                                    | `export PATH=/opt/homebrew/opt/node@24/bin:$PATH` → v24.18.1                                                                                                     |
| Signing                                  | Developer ID cert (`CSC_LINK`/`CSC_KEY_PASSWORD`) + notarization via ASC API key (`APPLE_API_KEY`/`_ID`/`_ISSUER`) + `APPLE_TEAM_ID` (regex `^[A-Z0-9]{10}$`) + a **provisioning profile**                                                                                                                                                                                           | `.github/workflows/release.yml:521-575`                                                                                                                          |
| **Non-obvious signing trap**             | A _signed_ mac build additionally requires a resolvable **Clerk passkey RP domain**. `resolveMacPasskeySigningConfiguration()` runs unconditionally when `platform===mac && signed` and **throws** unless team ID + provisioning profile + Clerk RP domain are all present. You cannot produce a signed mac build without our own Clerk configuration wired to our signing identity. | `build-desktop-artifact.ts:1862-1868`, entitlement rendered as `<teamId>.<appId>` at 837-851                                                                     |
| Identity                                 | `appId = com.t3tools.t3code` (hardcoded const line 38), `productName = "T3 Code (Alpha)"`, icons regenerated **every build** from `assets/prod/black-macos-1024.png` (T3 wordmark) — the checked-in `resources/icon.icns` is overwritten and irrelevant                                                                                                                              | `stageMacIcons()` line 1293; `scripts/lib/brand-assets.ts`                                                                                                       |

**Broken / missing:** Rust toolchain; our own Apple identity; our own Clerk RP domain (blocks _signed_ builds specifically); our icon set.
**Notable:** the auto-update feed is _not_ hardcoded to upstream — it falls back to `GITHUB_REPOSITORY`, so a fork's CI self-corrects. See §6 for a conflicting claim on this.

### 2.2 Windows (Electron NSIS + WSL backend)

|                                 | Status                                                                                                                                                                                                                                                                                                                                                  | Evidence                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| WSL backend code                | Real and complete — 1,284 lines across `DesktopWslBackend.ts` / `DesktopWslEnvironment.ts` / `wslPathParsing.ts`, wired through IPC and the settings UI. Zero TODO/FIXME/unimplemented markers. **Inherited from upstream PR #2751, not built for this fork.**                                                                                          | `git log --oneline` → single commit `a9b1190a1` by `Jgratton24`                      |
| Tests                           | 55/55 pass                                                                                                                                                                                                                                                                                                                                              | `vp test run apps/desktop/src/wsl` → `Test Files 3 passed (3), Tests 55 passed (55)` |
| Test _value_                    | **100% mocked or pure-string.** `ensureNodePtyImpl` — the function that actually drives a live distro — has **zero coverage** (`grep -n "ensureNodePtyImpl\|ensureNodePty(" *.test.ts` → nothing). The suite passes identically on macOS, which has no `wsl.exe`.                                                                                       | as above                                                                             |
| Local cross-build from this Mac | **Impossible today.** Rust missing (same `cargo ENOENT`), and even with Rust there is **no MSVC cross-link path anywhere in the repo** — grep for `xwin\|cargo-xwin\|mingw\|lld-link` returns nothing, and the target is `x86_64-pc-windows-msvc`. Signed cross-build additionally needs Parallels+Windows (`prlctl` absent) or system `wine` (absent). | run + `which wine wine64` → not found                                                |
| CI path                         | Real and plausible: dedicated Linux job builds `pty.node`, then a **native `blacksmith-32vcpu-windows-2025` runner** packages NSIS. CI itself does not cross-build.                                                                                                                                                                                     | `release.yml:267-330, 337-373, 417-535`                                              |
| Signing                         | **Azure Trusted Signing** (cloud HSM), 7 secrets, plus a PowerShell `TrustedSigning` module install step. Silently skipped if absent → unsigned artifact still produced.                                                                                                                                                                                | `release.yml:456-535`                                                                |
| Post-build verification         | **None.** No smoke test on any platform. `apps/desktop/scripts/smoke-test.mjs` exists and is invoked by **no workflow at all**.                                                                                                                                                                                                                         | grep across `.github/workflows`                                                      |

**Verdict on the "Windows is a build+test problem, not architecture" framing:** directionally right about the _application_ layer, **wrong about the infrastructure layer**, and it understates the test gap. Nothing in this repo — past or present — has ever run this code against a real `wsl.exe`. That is a first-ever real-world exercise, not a re-run of a passing suite. And "build" is not a laptop step: it needs a Windows host plus a separate Linux host for `pty.node`.

### 2.3 iOS / TestFlight (Expo, `apps/mobile`)

|                            | Status                                                                                                                                                                                                    | Evidence                                                                                                                                                                        |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Code health                | Green                                                                                                                                                                                                     | `tsc --noEmit` exit 0; `vp test run` → 98 files / 607 tests passed, 2.75s                                                                                                       |
| Workflow type              | **Managed** — `/ios` and `/android` are gitignored and absent; `expo prebuild` regenerates them from `app.config.ts` alone                                                                                | `.gitignore`; `test -d apps/mobile/ios` → absent before and after                                                                                                               |
| Prebuild needs an account? | **No.** `expo whoami` → `Not logged in`; prebuild completed with no prompt and no auth call                                                                                                               | run in an out-of-repo symlink mirror                                                                                                                                            |
| Local build proven?        | **Yes, fully.** `pod install` (142 pods) → `xcodebuild ... -sdk iphonesimulator` → `** BUILD SUCCEEDED **` → `simctl install` + `simctl launch com.t3tools.t3code: 32465` → screenshot of the running app | `/Users/pieroherrera/.claude/jobs/d1eda764/tmp/xcodebuild.log`, `t3code-sim-screenshot.png`, built `.app` at `.../derived-data/Build/Products/Debug-iphonesimulator/T3Code.app` |
| Signing used               | `Sign to Run Locally` — simulator ad-hoc only. A **device** build hits `DEVELOPMENT_TEAM = ARK85ZXQ4Z` baked from `app.config.ts:191` and fails without that team                                         | build log                                                                                                                                                                       |
| EAS binding                | `owner: "pingdotgg"`, `projectId: d763fcb8-d37c-41ea-a773-b54a0ab4a454`, `updates.url: https://u.expo.dev/d763fcb8-...`, `ascAppId: "6787819824"` (upstream's **live** App Store record)                  | `app.config.ts:368,371,177`; `eas.json` submit block                                                                                                                            |
| CI ability to run          | **Zero.** `gh api repos/piero-dev25/t3code/actions/secrets` → `{"total_count":0}`; `gh api .../actions/workflows` → `{"total_count":0}` — both EAS workflows exist only on this unmerged branch           | run                                                                                                                                                                             |
| TestFlight chain           | `eas build --platform ios --profile production --auto-submit --non-interactive --no-wait` → internal `eas submit` against `submit.production.ios.ascAppId`                                                | `mobile-eas-production.yml:106`                                                                                                                                                 |

**This is the shortest path to your ask.** Everything needed is either an account or a config edit in **one file** (`app.config.ts`) plus `eas.json` and the icon assets. There is no committed native project to hand-patch — prebuild picks up new identifiers automatically.

**Local-vs-CI caveat:** the repo's own CI comment says a local `production` build produces a different fingerprint than the Linux runner (platform-specific deps + pnpm version), so OTA runtime versions won't match. For a _first_ TestFlight build that is irrelevant; for ongoing OTA it matters.

### 2.4 Android (secondary)

Package `com.t3tools.t3code`, `production` profile → `.aab`, submit track `internal`. No Play service-account JSON anywhere in the repo. `apps/marketing/src/lib/site.ts` hardcodes upstream's live Play listing. **Nobody ran `expo prebuild --platform android` or any Android build tonight.** Treat Android as fully unverified and out of the critical path unless you want it in v1.

---

## 3. Blocked on the owner

Work through top to bottom. Items marked **PARALLEL** can be started immediately and run while engineering proceeds.

### 3.1 Decisions only you can make (do these first — everything else depends on them)

| #   | Decision                                                                                                                                            | Why it blocks                                                                                                                                                                                                                                                                                                                                                                         |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **Product name** (final, store-facing) — **DECIDED: `DevGame`.**                                                                                    | Drives `productName`, `appName`, window titles, installer names, GitHub Release titles, marketing copy. Apple rejects apps that appear to duplicate an existing one — it must not read as a T3 Code variant.                                                                                                                                                                          |
| D2  | **Reverse-DNS bundle identifier** — **DECIDED: `com.devgame.app`.**                                                                                 | Once registered with Apple it is **permanent and unchangeable** for that App Store record. Also derives the iOS widget/sharing extension IDs and App Group (`group.<bundleId>`), the Android package, the Windows AppUserModelID, and the Linux desktop entry. Get it right the first time.                                                                                           |
| D3  | **Apple enrollment: Organization or Individual**                                                                                                    | Organization requires a **D-U-N-S number** (free, typically 1–5 business days to obtain/verify) and lists the app under the company name. Individual is faster but publishes under your personal legal name. Not changeable later without a transfer process.                                                                                                                         |
| D4  | **npm CLI package name** — currently the unscoped `t3`, which is upstream's real published package                                                  | Any publish attempt from our CI targets their identity. Pick e.g. `@ironmind/<cli>` or an unscoped name we own.                                                                                                                                                                                                                                                                       |
| D5  | **Do we run "T3 Connect" (relay + Clerk) at all, or strip it for v1?**                                                                              | The entire `relay_public_config` CI job assumes a Cloudflare account + SST `t3code-relay` stack + a Clerk tenant. There is **no "stand up our own relay" path in this repo** — it's the first hard failure in CI. Standing it up is real infra work; ripping it out for v1 is a scoping decision. **This also gates signed macOS builds** (the passkey-entitlement coupling in §2.1). |
| D6  | **Windows signing route:** Azure Trusted Signing (matches existing CI) vs a traditional OV/EV cert (needs code changes) vs **ship unsigned for v1** | Unsigned Windows installers trigger SmartScreen warnings but _do_ build. This is a legitimate v1 option.                                                                                                                                                                                                                                                                              |
| D7  | **Android in v1: yes/no**                                                                                                                           | Nothing about it has been built or verified.                                                                                                                                                                                                                                                                                                                                          |
| D8  | **Auto-update in v1: yes/no**                                                                                                                       | Feed is GitHub Releases; works, but adds a whole release-hygiene surface. Manual download links are a valid v1.                                                                                                                                                                                                                                                                       |
| D9  | **Do we ship the marketing site at all in v1?**                                                                                                     | As-is it is a legal liability, not a cosmetic issue (see §4.6). Deleting it is faster than sanitising it.                                                                                                                                                                                                                                                                             |

### 3.2 Accounts, memberships and costs

> Costs stated from memory — **verify each at signup**, they change.

| #                              | What                                                                                                                  | Who/where                                          | Cost                                                                                                                    | Notes / lead time                                                                                                                                                                                                                                                                            |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1 **PARALLEL, START TONIGHT** | **Apple Developer Program** membership                                                                                | developer.apple.com, under the entity chosen in D3 | **99 USD/year**                                                                                                         | Required for TestFlight _and_ for macOS Developer ID signing + notarization. Approval: hours to ~1 week (org D-U-N-S path is the slow one). **This is the single longest-lead item on the critical path.**                                                                                   |
| A2                             | **App Store Connect app record** + bundle ID registration                                                             | App Store Connect, after A1                        | included                                                                                                                | Register the D2 bundle ID **plus** the `.widgets` and `.sharing` extension IDs and the `group.<bundleId>` App Group. Yields the new `ascAppId` that replaces `6787819824`.                                                                                                                   |
| A3                             | **App Store Connect API key** (`.p8`) — Key ID + Issuer ID                                                            | App Store Connect → Users & Access → Integrations  | included                                                                                                                | Used for notarization (`APPLE_API_KEY*`) and for EAS submit. Download the `.p8` **once** — Apple never shows it again.                                                                                                                                                                       |
| A4                             | **Developer ID Application certificate** (`.p12` export, with password)                                               | Apple Dev portal / Xcode → export from Keychain    | included                                                                                                                | Not "Apple Development" and not "Apple Distribution" — specifically **Developer ID Application** for a directly-distributed macOS app. Becomes `CSC_LINK` (base64) + `CSC_KEY_PASSWORD`.                                                                                                     |
| A5                             | **macOS provisioning profile** (`.provisionprofile`) carrying the Associated Domains entitlement                      | Apple Dev portal, after A2 + a Clerk domain exists | included                                                                                                                | Required for _any_ signed mac build (§2.1 trap). Base64 → `MACOS_PROVISIONING_PROFILE`.                                                                                                                                                                                                      |
| A6 **PARALLEL**                | **Expo account + organization**                                                                                       | expo.dev                                           | Free tier exists; EAS build credits are limited. Paid plans (Production ~19 USD/mo) or pay-per-build if you exceed them | Then `eas init` inside our org to mint a **new** `projectId`. `eas build --local` also requires login.                                                                                                                                                                                       |
| A7                             | **`EXPO_TOKEN`** (robot/access token) added to `piero-dev25/t3code` GitHub secrets                                    | expo.dev → access tokens                           | included                                                                                                                | **Do not add this until §4.1 is fixed.** Adding it against the current config points our CI at upstream's project.                                                                                                                                                                           |
| A8 (D6-dependent)              | **Azure subscription + Trusted Signing account**, certificate profile, and a service principal (tenant/client/secret) | portal.azure.com                                   | ~**9.99 USD/month** Basic tier + Azure subscription                                                                     | Requires **identity validation**: organizations normally need ~3 years of verifiable business history, otherwise the individual-validation path. This can take days–weeks. If that's a wall, D6 → unsigned or a traditional OV cert (~200–400 USD/yr on a hardware token, Sectigo/DigiCert). |
| A9 (D7)                        | **Google Play Console** developer account                                                                             | play.google.com/console                            | **25 USD one-time**                                                                                                     | Plus a Play service-account JSON for `eas submit` (not referenced anywhere in the repo today — new work). New personal accounts also face a closed-testing-before-production requirement; the `internal` track used here is not affected.                                                    |
| A10 (D5)                       | **Clerk** application/tenant + a passkey **relying-party domain** we own                                              | clerk.com                                          | Free to ~10k MAU                                                                                                        | Blocks signed macOS builds. Supplies `CLERK_PUBLISHABLE_KEY`, `CLERK_JWT_TEMPLATE`, `CLERK_CLI_OAUTH_CLIENT_ID`, `CLERK_PASSKEY_RP_DOMAINS`, and the mobile `relyingParty`/`associatedDomains`.                                                                                              |
| A11 (D5)                       | **Cloudflare** account + API token + a zone for the relay                                                             | cloudflare.com                                     | Workers paid ~5 USD/mo if used                                                                                          | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `RELAY_DOMAIN` / `RELAY_API_ZONE_NAME`.                                                                                                                                                                                                     |
| A12                            | **A domain we own** for the app + marketing + Clerk RP                                                                | any registrar                                      | ~15 USD/yr                                                                                                              | Replaces `app.t3.codes` / `latest.` / `nightly.` / `clerk.t3.codes` / `t3.codes`.                                                                                                                                                                                                            |
| A13                            | **Vercel** account/team + project                                                                                     | vercel.com                                         | Hobby free, Pro ~20 USD/seat/mo                                                                                         | `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, `VERCEL_TEAM_SLUG`.                                                                                                                                                                                                                    |
| A14                            | **npm account/org** owning the D4 name                                                                                | npmjs.com                                          | Free (org paid tiers exist)                                                                                             | Publishing `t3` today would 403 — or, worse, overwrite upstream if the account somehow had rights.                                                                                                                                                                                           |
| A15                            | **GitHub App** (ID + private key) installed on `piero-dev25/t3code` with contents+releases write                      | github.com settings                                | Free                                                                                                                    | `RELEASE_APP_ID`, `RELEASE_APP_PRIVATE_KEY`. Note this token pushes a version-bump commit **directly to `main`** and bypasses the workflow's read-only top-level permissions — confirm the install scope before enabling.                                                                    |
| A16                            | **PostHog** project (or the decision to disable telemetry)                                                            | posthog.com                                        | Free tier                                                                                                               | See §4.2 — today this defaults to _their_ project.                                                                                                                                                                                                                                           |
| A17                            | Discord webhook + role IDs                                                                                            | your server                                        | Free                                                                                                                    | Cosmetic; fails cleanly if unset.                                                                                                                                                                                                                                                            |
| A18                            | **A Windows machine** (physical, VM, Parallels, or hosted CI runner)                                                  | —                                                  | varies                                                                                                                  | Non-negotiable for Windows artifacts. This Mac cannot do it, and the project's own CI provisions a real Windows runner rather than cross-building.                                                                                                                                           |

### 3.3 Non-account prerequisites you should just approve

- **Install Rust** (`rustup`, stable) on this Mac, with the `aarch64-apple-darwin` and `x86_64-apple-darwin` targets. This is a hard blocker for _any_ local desktop build and needs no account. Everything about the macOS desktop path is untestable until it exists.
- Decide whether the **marketing site and legal pages** ship, are rewritten, or are deleted from the fork (§4.6, D9).

---

## 4. Identity and fork hygiene

**Defects first** — these are cases where our shipped binary would talk to upstream's infrastructure. They are not branding tasks.

### 4.1 DEFECT — mobile builds bind to upstream's live EAS project, OTA channel, App Store record and Apple Team

`app.config.ts:371 owner: "pingdotgg"`; `:368 extra.eas.projectId: "d763fcb8-d37c-41ea-a773-b54a0ab4a454"`; `:177 updates.url: "https://u.expo.dev/d763fcb8-..."` (same ID — one project serves builds _and_ OTA); `:191 appleTeamId: "ARK85ZXQ4Z"` (comment: "Pin code signing to the T3 Tools team"); `eas.json submit.production.ios.ascAppId: "6787819824"` (confirmed live via the App Store URL in `apps/marketing/src/lib/site.ts`).
With `updates.enabled: true, checkAutomatically: "ON_LOAD"`, any shipped build listens to **upstream's production OTA channel**. In the other direction, a valid `EXPO_TOKEN` in CI would attempt to push into their project/listing.
**Currently harmless only by absence of credentials** (0 secrets, 0 registered workflows on the fork). That is not a fix. Repoint `owner`, `projectId`, `updates.url`, `ascAppId`, `appleTeamId` **before** A7.

### 4.2 DEFECT — analytics phone home to T3's PostHog by default

`apps/server/src/telemetry/AnalyticsService.ts:31-38`: hardcoded fallback `posthogKey: "phc_XOWci4oZP4VvLiEyrFqkFjP4CZn55mjYYBMREK5Wd6m"`, host `https://us.i.posthog.com`, `enabled: withDefault(true)`. The server ships **inside the desktop app**, so every unmodified install reports usage into their project unless `T3CODE_TELEMETRY_ENABLED=false` or the key is overridden. Fix by replacing the fallback with our key or defaulting `enabled` to false.

### 4.3 DEFECT — passkey/WebAuthn relying party pinned to their Clerk domain

`app.config.ts:68,76,84` → `relyingParty: "clerk.t3.codes"` for **every** variant including production, feeding `associatedDomains: [applinks:clerk.t3.codes, webcredentials:clerk.t3.codes]`. This is independent of whichever Clerk publishable key we configure — the entitlement itself names their domain. (Credit where due: the Clerk _publishable key_ is genuinely env-only with no hardcoded default — verified by `rg "pk_(live|test)_"`.)

### 4.4 DEFECT — in-app "release notes" link goes to upstream's GitHub releases

`apps/web/src/components/desktopUpdate.logic.ts:6`: `const DESKTOP_RELEASE_TAG_URL = "https://github.com/pingdotgg/t3code/releases/tag"` — hardcoded, **no env override**. Surfaced in the update toast. Users of our build get sent to their release page.

### 4.5 DEFECT (latent) — hardcoded upstream domains as silent fallbacks

`apps/web/vercel.ts:3-6` and `release.yml:933-935`: `https://app.t3.codes`, `latest.app.t3.codes`, `nightly.app.t3.codes` as defaults. `packages/shared/src/connectAuth.ts:15`: `DEFAULT_HOSTED_APP_URL = "https://app.t3.codes"` — the CLI/desktop out-of-band OAuth flow points at their hosted app whenever `T3CODE_HOSTED_APP_URL` is unset. `scripts/mobile-showcase-environment.ts:110,286`: `repositoryUrl: "https://github.com/pingdotgg/t3code.git"`. Today the Vercel ones are unreachable (secrets are checked first), but a partial config — Vercel set, `T3CODE_WEB_*` unset — aliases our deploy onto their domains.

### 4.6 LEGAL EXPOSURE — marketing site and in-app legal links

- `apps/marketing/src/lib/site.ts`: their live App Store URL (`id6787819824`), their live Play URL (`id=com.t3tools.t3code`), their GitHub repo URL, and `MARKETING_STATS = { githubStars: "14k+", users: "100,000" }` — **their traction numbers rendered on our homepage**.
- `apps/marketing/src/lib/tweets.ts`: five-plus **real, named X/Twitter users' actual tweets** about T3 Code (@Shay_Benshabtay, @teja2495, @developedbyed, @tannerlinsley, @aronprins) hardcoded as testimonials. Shipping these misattributes third-party endorsements of someone else's product to ours. This is a false-endorsement problem entirely separate from trademark.
- `apps/marketing/src/pages/{privacy-policy,terms-of-service,security-policy}.astro` name **"T3 Tools, Inc."** as data controller and contracting party; `apps/mobile/src/features/settings/lib/legal-document-url.ts:1` defaults `DEFAULT_MARKETING_SITE_URL = "https://t3.codes"`, so in-app Settings links present users with their legal entity as counterparty.

**Fastest safe move: delete or fully rewrite the marketing app before anything ships. Do not sanitise it piecemeal.**

### 4.7 Trademark assets shipped as the app icon

`assets/prod/black-macos-1024.png` is T3's **wordmark** on a black rounded square — that is the icon that ships on macOS/iOS/Android/Windows today. Dev (`assets/dev/blueprint-*`) and nightly variants likewise. Single point of redirection: **`scripts/lib/brand-assets.ts`** (`BRAND_ASSET_PATHS`) — replace the files it points at and every consumer (desktop icon staging, mobile app.config, web favicons) follows.

### 4.8 Identifier and name inventory (full change surface)

| Surface                                    | Current                                                                                                                                                                        | Source                                                                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Electron `appId` / macOS+Windows bundle ID | `com.t3tools.t3code` (`.dev` variant)                                                                                                                                          | `scripts/build-desktop-artifact.ts:38`, `:821`, `:1539`; `DesktopEnvironment.ts:210`                                                         |
| Desktop product name                       | `T3 Code (Alpha)`                                                                                                                                                              | `apps/desktop/package.json:38`                                                                                                               |
| Desktop in-app brand                       | `APP_BASE_NAME = "T3 Code"`, legacy userData dirs `"T3 Code (Alpha)"/"(Dev)"`, new dirs `~/.t3/{dev,userdata}`                                                                 | `DesktopEnvironment.ts:81,~150,~164`                                                                                                         |
| URL schemes                                | `t3code` / `t3code-dev` — registered at OS level, consumed by web, mobile, server auth redirects                                                                               | `build-desktop-artifact.ts` protocols; `apps/web/src/components/clerk/authRedirect.ts`, `apps/mobile/src/App.tsx`, `apps/server/src/http.ts` |
| iOS / Android IDs                          | `com.t3tools.t3code[.dev                                                                                                                                                       | .preview]`+`.widgets`, `.sharing`, `group.<id>`                                                                                              | `app.config.ts:66,67,74,75,82,83` + plugin config |
| iOS app names / slug                       | `T3 Code` / `T3 Code Dev` / `T3 Code Preview`, `slug: "t3-code"`                                                                                                               | `app.config.ts:64,72,80`                                                                                                                     |
| Windows AppUserModelID                     | same string                                                                                                                                                                    | `DesktopEnvironment.ts:210`                                                                                                                  |
| Linux desktop entry                        | `t3code.desktop`                                                                                                                                                               | `DesktopEnvironment.ts:212`                                                                                                                  |
| Web title / branding                       | `<title>T3 Code (Alpha)</title>`, `APP_BASE_NAME = "T3 Code"`                                                                                                                  | `apps/web/index.html:87`, `apps/web/src/branding.ts:22`                                                                                      |
| CLI                                        | package name `t3`, `bin: { t3 }`, runtime strings ("T3 Code service", "Run `t3 service install`")                                                                              | `apps/server/package.json`, `src/cli/service.ts`                                                                                             |
| Repo metadata                              | `repository.url = github.com/pingdotgg/t3code`                                                                                                                                 | `apps/server/package.json:7`                                                                                                                 |
| Staged bundle manifest                     | `name: "t3code"`, `author: "T3 Tools"`                                                                                                                                         | `build-desktop-artifact.ts:1914-1922`                                                                                                        |
| **Leave alone**                            | `@t3tools/*` internal package names, `oxlint-plugin-t3code`, Effect service tags, `T3CODE_*` env prefixes, `t3.json` project-file convention, Android native-module namespaces | not user-visible                                                                                                                             |

Product-name text appears in 300+ files, but nearly all are test assertions against the handful of real sources above. Low-priority sweep: `README.md`, `CONTRIBUTING.md`, `t3.json` `$schema`, and the game-engine plugins' display names (`"T3 Editor Presence"` — already correctly authored to `Ironmind Studios`, only the display string lags).

### 4.9 MIT attribution — what you actually owe

`LICENSE` is standard MIT, `Copyright (c) 2026 T3 Tools Inc.` MIT requires that **the copyright notice and permission notice be retained in all copies or substantial portions of the software**. Practically: keep the `LICENSE` file (or its text) in the redistributed source; you may license your own additions as you like. MIT gives you **no rights to the "T3 Code" name, the wordmark, or the icon** — those are trademark, governed separately, and items 4.7/4.8 are what discharges that risk. There is no obligation to credit them in the UI. No `NOTICE`/`ATTRIBUTIONS` file exists; adding one crediting the upstream project is good practice but not required.

---

## 5. Recommended order of work

Optimised for **TestFlight-in-your-hands soonest**, since that was the explicit ask.

### Day 0 — tonight / first thing (owner, ~1 hour, unblocks everything)

1. **A1: start Apple Developer Program enrollment.** Longest lead item; nothing else on the iOS path can finish without it. Decide D3 (org vs individual) to start it.
2. **A6: create the Expo account/org.** Free, five minutes.
3. **A12: buy the domain.**
4. ~~Settle D1 (name) and D2 (bundle ID).~~ **Decided: `DevGame` / `com.devgame.app`.** Every engineering task below was blocked on these two strings; they are now fixed inputs to §4.8's change surface.

### Phase 1 — Identity repoint, mobile-only (engineering, ~0.5–1 day)

_Scope deliberately narrow: only what a TestFlight build touches._ 5. Rewrite `apps/mobile/app.config.ts`: `owner`, `extra.eas.projectId` (from `eas init` in our org), `updates.url`, all three variants' `iosBundleIdentifier`/`androidPackage`/`appName`/`scheme`, `appleTeamId`, `relyingParty`/`associatedDomains`. 6. Rewrite `eas.json` `submit.production.ios.ascAppId` once A2 exists. 7. Replace brand assets behind `scripts/lib/brand-assets.ts` (icons, splash, adaptive/monochrome/notification). Placeholder art is fine for a first TestFlight build — App Store _review_ is not involved in TestFlight internal testing. 8. Fix §4.2 (PostHog default) and §4.3 (Clerk RP) — small, and you do not want a TestFlight build reporting into their analytics. 9. Re-run the tonight-proven local loop as a regression gate: `expo prebuild --platform ios` → `pod install` → `xcodebuild -sdk iphonesimulator` → `simctl launch`, confirming the new bundle ID appears in the built `Info.plist`.
_Defer:_ everything desktop, marketing, CLI, Windows.

### Phase 2 — First TestFlight build (~0.5 day of work + Apple/EAS wait)

10. Once A1 lands: register bundle ID + extension IDs + App Group (A2), create the ASC app record, generate the ASC API key (A3).
11. `eas login` → `eas build --profile production -p ios` (or `preview` first for a faster internal-distribution smoke). Add `--auto-submit` only when you're ready to see it in TestFlight.
12. **First real device install.** Expect one or two rounds of entitlement/capability surprises — App Groups, Sign in with Apple, push. Budget for it.
    **Milestone: you have a TestFlight build. Everything below is after this point.**

### Phase 3 — macOS desktop (~2–4 days after Phase 2, or in parallel with a second engineer)

13. `rustup` install + the two darwin targets. Then run `node scripts/build-desktop-artifact.ts --platform mac --target dmg --arch arm64` and get an **unsigned** DMG. This has never succeeded here; treat the first attempt as discovery, not a formality.
14. Rebrand the desktop surface: `DESKTOP_APP_ID`, `productName`, `APP_BASE_NAME`, userData dir names, URL schemes (coordinated across desktop/web/mobile/server), staged package metadata, icons. Fix §4.4 and §4.5.
15. **Decide D5.** If T3 Connect stays: stand up Clerk (A10) + relay (A11) — this is the gate on _signed_ mac builds because of the passkey-entitlement coupling. If it goes: strip the passkey path from `resolveMacPasskeySigningConfiguration` so signing doesn't require it.
16. Signing: A4 (Developer ID `.p12`) + A5 (provisioning profile) + A3 key → first signed + notarized DMG. Verify with `spctl -a -vvv` and `stapler validate` on a _different_ Mac.

### Phase 4 — Release pipeline (~1–2 days)

17. Fix D4 (npm name) **before** any publish is attempted.
18. Set the `T3CODE_WEB_*` vars alongside Vercel secrets, never one without the other (§4.5).
19. Wire A15 (GitHub App) and confirm its scope — it pushes to `main`.
20. First end-to-end `workflow_dispatch` run of `release.yml`, **stable channel, prerelease**, on a throwaway version. Expect the first hard stop at `relay_public_config` unless D5 is resolved.

### Phase 5 — Windows (~1–2 weeks, or 3 days if you accept unsigned + have a Windows box)

21. Get a Windows host (A18). Fastest credible route: enable the existing `blacksmith-32vcpu-windows-2025` matrix leg in CI, since it is already written and already handles the Linux `pty.node` hand-off.
22. First **unsigned** NSIS artifact. Then D6/A8 for signing.
23. **First-ever real WSL exercise.** Budget genuine time here — no line of that 1,284-line backend has ever met a real `wsl.exe`. Also wire up `apps/desktop/scripts/smoke-test.mjs`, which no workflow currently runs.

### Safe to defer

Android entirely (D7); auto-update (D8); the marketing site (D9 — but **delete it from the shipping surface now**, don't defer the risk); the 300-file cosmetic name sweep; game-engine plugin display names; README/CONTRIBUTING.

**Rough totals:** TestFlight ~3–5 engineering days + Apple latency. Signed macOS ~1 week beyond that. Windows ~1–2 weeks beyond that. A clean public launch including legal/marketing ~3–4 weeks calendar.

---

## 6. What nobody has verified

Stated plainly, because tonight has already produced two claims that dissolved on contact with a shell.

**Never executed at all:**

- **No macOS artifact has ever been built in this repo, by anyone, tonight or previously.** The macOS build attempt (task `bdpcpudhy`) **never reported a result** — its only output was "standing by for the build monitor notification." Given `cargo` is absent and `stageResourceMonitor()` runs unconditionally, it almost certainly died at the same `spawn cargo ENOENT` the Windows attempt hit, but **that is inference, not evidence.** Nobody has seen a DMG.
- **No Windows artifact.** The attempt died before electron-builder was reached.
- **`release.yml` has never run** in this fork. The "first failure is `relay_public_config`" conclusion is static reading of `needs:` graphs and fail-fast blocks, explicitly not a live run.
- **electron-builder's Wine auto-bootstrap on macOS is untested** — read from `app-builder-lib/out/toolsets/wine.js`, never exercised here or in CI, and moot anyway because the Rust step fails first. The macOS and Windows audits differ in tone here (one says "nominally supported", the other says the point is unreachable); the build attempt settles it — unreachable today.
- **The WSL backend has never touched a real `wsl.exe`.** 55/55 green is 100% mocks and pure string functions; `ensureNodePtyImpl` has zero coverage. The failure-diagnosis code ("unsupported CPU architecture or incompatible glibc") has itself never seen a real failure.
- **No smoke test exists in any pipeline.** `apps/desktop/scripts/smoke-test.mjs` is invoked by no workflow.
- **No physical-device iOS build**, only simulator. Device signing is where `DEVELOPMENT_TEAM = ARK85ZXQ4Z` bites and where entitlements are actually validated.
- **No Android build or prebuild of any kind.**
- **`npm publish` collision is asserted, not tested** — "would 403" is reasoning about registry ownership, nobody attempted it (correctly).
- **Full-repo `vp check` / `vp run typecheck` / `vp run test` were never run.** Only `apps/mobile` (98 files/607 tests) and `apps/desktop/src/wsl` (55 tests) were executed. The `preflight` CI job runs the full suite; its state is unknown.
- **Nobody confirmed PostHog events actually leave the process.** §4.2 rests on reading the default values in `AnalyticsService.ts`, not on observing network traffic. High-confidence read, zero runtime proof.
- **The OTA-channel consequence in §4.1 is architectural inference.** No build was ever installed on a device to observe it polling `u.expo.dev/d763fcb8-...`.
- **Icon regeneration with _replacement_ art is unproven.** `stageMacIcons()` was read, not run with a new 1024px source.

**Conflicts between audits — stated, not silently resolved:**

1. **Desktop auto-update feed.** The mobile audit (§6 item 7, summary #4) states the desktop auto-updater "currently defaults to `pingdotgg/t3code` as its release repo." The macOS audit and the identity audit both contradict this with specifics: `resolveGitHubPublishConfig()` (`build-desktop-artifact.ts:1451-1475`) reads `T3CODE_DESKTOP_UPDATE_REPOSITORY` and falls back to GitHub Actions' own `GITHUB_REPOSITORY`, and `pingdotgg/t3code` appears only in a **test fixture** (`build-desktop-artifact.test.ts:124,135`); the identity audit separately confirms no checked-in `app-update.yml`. **Two independent audits against one; treat the feed as fork-safe — but the deciding evidence is a build we never produced.** Verify by inspecting the generated `app-update.yml` inside the first real DMG. Until then, do not tick this off.
2. **"Windows is a build+test problem, not architecture."** The Windows audit and the Windows build attempt agree it is right about the app layer and wrong about the infrastructure layer (no Windows host, no MSVC cross-link path, two-OS build by design). The framing in the original goal should be considered corrected.
3. **The `desktopUpdate.logic.ts` upstream releases link (§4.4)** was found only by the macOS audit; the identity audit's "no stale feed pointer" clean-bill covers `app-update.yml` specifically and does not contradict it. Both are true — different surfaces.

**Evidence artifacts on disk** (all outside the repo; repo confirmed clean, `git status --short` empty before and after every operation):
`/Users/pieroherrera/.claude/jobs/d1eda764/tmp/` → `mobile-typecheck.log`, `mobile-test.log`, `expo-prebuild.log`, `pod-install.log`, `xcodebuild.log` (`** BUILD SUCCEEDED **` at tail), `win-build-attempt.log`, `wsl-tests-verbose.log`, `t3code-sim-screenshot.png`, `mobile-prebuild-mirror/`, `derived-data/Build/Products/Debug-iphonesimulator/T3Code.app`.

---

## 7. Post-severance verification (added after the de-fork)

Run after `c2875b087` / `c2eef4346` removed upstream's network identity, to prove
the one build the audit had proven still works.

**Procedure:** `expo prebuild --platform ios --clean --no-install` with **no
configuration set at all** — the unconfigured-fork case — then `pod install`,
then `xcodebuild` for the simulator.

**Result: `** BUILD SUCCEEDED **`**, a 224 MB `T3Code.app`. The de-fork did not
regress the build.

What the generated native project and the built artifact contain:

| Check                                                            | Result                                                                |
| ---------------------------------------------------------------- | --------------------------------------------------------------------- |
| `DEVELOPMENT_TEAM` pinned in `project.pbxproj`                   | **Absent** — Xcode picks a team instead of hard-failing on upstream's |
| Entitlement naming an associated domain                          | **Absent entirely** — claims nothing rather than claiming theirs      |
| `t3.codes` / `ARK85ZXQ4Z` in generated `ios/`                    | **Zero occurrences**                                                  |
| Upstream domain, team, PostHog key or EAS id in the built `.app` | **Zero occurrences**                                                  |
| `CFBundleIdentifier`                                             | `com.t3tools.t3code` — **still upstream's, deliberately**             |
| `CFBundleDisplayName`                                            | `T3 Code` — **still upstream's, deliberately**                        |

So **network identity is severed and proven in the shipping artifact**, while
**product identity, at the time of this audit, was untouched** — §3.1 D1–D2
were still open. They are now decided (`DevGame` / `com.devgame.app`, see
§4.8) and the audit-night measurements above should be treated as a snapshot
of the pre-decision state, not the current one.
Those are different things and the distinction matters: nothing phones home,
but the app still presents as theirs until the §4.8 sweep lands.

### Build gotcha that costs an hour if you hit it cold

The iOS build **requires an arm64-pinned destination**:

```
xcodebuild -workspace T3Code.xcworkspace -scheme T3Code \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  ARCHS=arm64 ONLY_ACTIVE_ARCH=YES EXCLUDED_ARCHS=x86_64 CODE_SIGNING_ALLOWED=NO
```

Without the arch pin the build fails with:

```
modules/t3-terminal/ios/T3TerminalView.swift:3:8: error: no such module 'GhosttyKit'
```

The cause is not the module and not a missing dependency. The vendored
`GhosttyKit.xcframework` is checked in and ships **only** `ios-arm64` and
`ios-arm64-simulator` slices; a generic simulator destination also asks for
`x86_64`, which has no slice. The error names a Swift module rather than an
architecture, so it points away from the real cause — it reads exactly like
someone broke the terminal module.

### 7.1 What the fork WOULD have shipped — before/after, from generated projects

A stale pre-change prebuild mirror preserved the generated project as it stood
before the severance. That accident is the best evidence in this document,
because it shows the defect in the artifact rather than in the config:

**BEFORE** (generated from the pre-change `app.config.ts`):

```
project.pbxproj:719,757,788,811   DEVELOPMENT_TEAM = ARK85ZXQ4Z;   (4 build configurations)

T3Code.entitlements
  com.apple.developer.associated-domains
    applinks:clerk.t3.codes
    webcredentials:clerk.t3.codes

Expo.plist
  EXUpdatesEnabled  true
  EXUpdatesURL      https://u.expo.dev/d763fcb8-d37c-41ea-a773-b54a0ab4a454
```

Upstream's Apple team in four configurations, their passkey domain in the
entitlements, and OTA **enabled and pointed at their production channel**.

**AFTER**: zero `DEVELOPMENT_TEAM`, no associated-domains entitlement at all,
`EXUpdatesEnabled false` with **no `EXUpdatesURL` key**, and no match for any
upstream literal anywhere under `ios/`.

### 7.2 Correction: what the "running app" screenshot actually showed

The original audit reported a screenshot of the running app. That screenshot —
and the identical post-severance one — is the **expo-dev-client launcher**
("Development Build / No development servers found"), not the app's own UI. It
proves the process launches. It does not prove the app renders.

A **Release** simulator build was therefore made, which embeds the JS bundle
(23 MB `main.jsbundle`) and bypasses dev-client. That one shows the real home
screen — "T3 Code ALPHA" header, Add environment, search — rendering from its
own bundle, with `EXUpdatesEnabled false`, no `EXUpdatesURL`, and no upstream
literal in the bundle.

So the claim is now stronger than the audit's, and stated accurately: the app
**renders**, from a Release artifact that is provably severed.

### 7.3 Constraint: Apple Silicon only, today

The vendored `GhosttyKit.xcframework` ships `ios-arm64` and
`ios-arm64-simulator` and **no x86_64 slice**. Debug builds only the active
architecture and so passes; **Release defaults to `ONLY_ACTIVE_ARCH=NO` and
fails** with `no such module 'GhosttyKit'` — an error that names a Swift module
rather than an architecture and sends you to the wrong file.

Consequences: an Intel Mac cannot build this app, an x86_64 simulator target
cannot be built, and a fat Release build fails unless `ONLY_ACTIVE_ARCH=YES` is
passed. Pre-existing, unrelated to the severance, and not blocking for
TestFlight since device builds are arm64 — but it is a real constraint on who
can build this and should be in the build docs rather than rediscovered.

---

## 8. Apple account path — DECIDED

**DevGame is published by Ironmind Studios Inc.** (owner decision, 2026-08-03).

This supersedes §3.1 D3 and materially shortens §3.2 A1: an Apple Developer
membership already exists on this machine — team `A865JH62VP`, used by the
WellnessCompanion project via a `ZELA_DEV_TEAM` variable, with an App Store
Connect API key already on disk there. So enrolment is not a cold start.

### The constraint that decides the sequence

**Bundle identifiers are globally unique across Apple, and the team that
creates the App Store Connect record owns it.** Apple's transfer criteria
require an app to have had **at least one version released to the App Store**
before it can move between accounts, and TestFlight-only apps that never
shipped publicly may not be transferable at all.

So "TestFlight under the existing team now, move to Ironmind later" is **not a
safe plan**. It risks binding `com.devgame.app` to the wrong team with no clean
exit.

### What that does and does not block

| Activity                        | Needs the Ironmind team first?                                    |
| ------------------------------- | ----------------------------------------------------------------- |
| Simulator builds                | **No**                                                            |
| Local device builds and signing | **No** — creates no App Store Connect record, locks no identifier |
| Internal iteration              | **No**                                                            |
| **TestFlight**                  | **YES** — requires the ASC record, which binds the bundle id      |

### The path

1. **Start the Ironmind Studios Inc. Organization enrolment now.** It needs a
   D-U-N-S number; an incorporated entity often already has one, but issuance
   takes several days otherwise. This is the only long-lead item left and it
   runs unattended.
2. **Meanwhile use the existing team for local work**, via
   `T3CODE_APPLE_TEAM_ID`. That variable already drives both mobile
   (`app.config.ts`, absent-when-unset) and desktop
   (`scripts/build-desktop-artifact.ts`, format-validated), so switching teams
   later is one environment variable and no code change.
3. **Do not create the App Store Connect record until the Ironmind team
   exists.** That is the point of no return.

### Worth copying rather than reinventing

WellnessCompanion's `ios-native-testflight-release` skill and its release
script are a better starting point than anything in this fork's pipeline. Its
refusals are the valuable part: dirty checkout, mismatched SHA, expired or
wrong provisioning profile, missing distribution identity, failed export
verification — and it runs a no-upload archive/export lane before any upload,
copies the `.p8` into a mode-600 temp dir removed on exit, and treats
TestFlight upload and App Review submission as separate deliberate actions.

### Confidence

The transfer rules above come from Apple's published criteria and developer
forum reports, not from anything testable here. Before relying on "we can move
it later" — which this plan deliberately does not — confirm with Apple.
