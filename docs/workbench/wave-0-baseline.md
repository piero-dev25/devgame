# Wave 0 — the fork builds, tests green, and runs a real turn

First record of the Workbench fork. Everything here was measured on this
machine on 2026-08-02 against fork HEAD `69dfb7f0`. Numbers without a command
next to them are numbers nobody can re-check, so every claim below names how
it was produced.

## Toolchain: node 24 is required, and node 25 is actively wrong

`package.json` says `engines.node: ^24.13.1`. There is no `.nvmrc` and no
`engine-strict`, so nothing enforces it — you find out through failing tests.

| node    | `typeof localStorage`             | result                                             |
| ------- | --------------------------------- | -------------------------------------------------- |
| 22.23.1 | `undefined`                       | guard falls through to memory storage — tests pass |
| 24.18.1 | `undefined`                       | guard falls through to memory storage — tests pass |
| 25.2.1  | `object`, `setItem === undefined` | 8 failures in `promptStashStore.test.ts`           |

Node 25 enables Web Storage by default but leaves it inert without a backing
file (it warns `--localstorage-file was provided without a valid path`).
`resolveBaseStorage()` in `apps/web/src/promptStashStore.ts` asks
`typeof localStorage !== "undefined"` — a _shape_ check — and so hands back an
object with no `setItem`.

That is a latent robustness bug in its own right, independent of our
toolchain: the guard should ask whether the storage _works_, not whether the
global _exists_. Left alone for now; noted so the next person who sees those 8
failures does not go looking in the wrong place.

Worth being precise about the scope of that claim, because nothing in the repo
_rejects_ node 25. The only enforced version check is
`checkNodeSqliteCompat` (`apps/server/src/persistence/NodeSqliteClient.ts:77`),
which requires major >= 24 and so passes on 25; `apps/server/package.json:40`
declares an even looser `^22.16 || ^23.11 || >=24.10`. Node 25 will therefore
boot the server quite happily. It is the web test suite that breaks, silently
and for a reason that looks nothing like a node version problem. Use node 24.

Install with brew's node@24 explicitly; pnpm self-manages to 11.10.0 from
`packageManager`, so the ambient pnpm version does not matter:

```
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
pnpm install --frozen-lockfile
```

## Baseline (the numbers any later red must be measured against)

```
pnpm typecheck   exit 0    15 packages
pnpm test        exit 0    13 packages, 514 files, 4367 tests, 0 failures
```

The `TS377019` lines in typecheck output are `suggestion` severity, not
errors — the command still exits 0.

The zero-failure claim is not a silent grep: the same log yields 26 hits for
`passed` against 0 for `failed` and 0 for `FAIL`, so the search was working
when it found nothing.

## Running it

```
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
export T3CODE_HOME="$PWD/.t3-dev"     # see below — do not skip this
pnpm dev
```

Server on `127.0.0.1:13773`, web on `5733`, 35 migrations applied
automatically on first boot. The server prints a one-time pairing URL; open
it and paste the token.

**`T3CODE_HOME` is not optional.** `resolveWorktreeT3Home` returns
`<worktree>/.t3` only when the cwd is a _linked git worktree_. This fork is a
plain checkout, so it returns `undefined` and the server silently falls back
to `~/.t3/dev/state.sqlite` — shared with every other T3 dev instance on the
machine. Setting `T3CODE_HOME` gives the fork its own
`.t3-dev/{caches,userdata,worktrees}`.

## Two origins, one app

The server at `13773` serves a 302 to the vite dev origin at `5733`, so the
browser always ends up on `5733` and that is where the DPoP credential lives.
Pairing on one origin does not pair the other. Debugging from the wrong origin
looks exactly like a broken connection.

## Failure mode worth knowing

Stale client state survives a server restart and does not recover. The
environment picker sits on `Connecting…` forever while the app shell around it
is connected and serving projections. The state is in IndexedDB
`t3code:connection-runtime`, keyed by an `environmentId` that belonged to the
dead server.

Clearing that database and re-pairing fixes it. This is not a code defect —
the client is behaving as designed against a target that no longer exists —
but it presents as a hang with no error, and `catalog` sitting empty while
`server-config` holds a valid handshake is the tell.

## End-to-end proof

Added a scratch project, opened a thread, sent one prompt, and got a correct,
file-specific answer from the user's own logged-in Claude — no API key
anywhere in the loop.

Proof taken from the database rather than the screen:

```
projection_projects = 1   projection_threads = 1   projection_turns = 1

model_selection_json:
{"instanceId":"claudeAgent","model":"claude-fable-5",
 "options":[{"id":"effort","value":"high"},{"id":"contextWindow","value":"1m"}]}
```

`git status` in the scratch repo came back empty, so the prompt's "do not
modify any files" was actually honoured — the turn read and answered rather
than editing.

### What that JSON settles

`instanceId` is **populated by T3's own picker**. Our SDK seam carried a
workaround for it because `ClaudeAdapter` compares `instanceId` and silently
discards the model selection when it does not match — which is what shipped a
picker that opened a menu and changed nothing.

That workaround is **moot in the fork** and should be deleted rather than
ported. The bug only ever existed because _our_ web client drove _their_
vendored adapter without setting the field. Forking wholesale removes the
cause.

So the standing claim of "three seam workarounds verified absent upstream" is
really two. The absence was measured against a client that no longer exists.
`cancelRequested` is still genuinely absent (0 occurrences at HEAD, against
105 hits for `ClaudeAdapter` proving the search worked). `runKeepAlive`
remains unanswered — the label is ours, so its absence proves nothing about
the underlying fiber behaviour, and only a live Codex turn can settle it.

## The desktop shell

`pnpm dev:desktop` builds and launches on macOS. Electron runs as
`apps/desktop/.electron-runtime/T3 Code (Dev).app`, registers its own
`t3code-dev` URL scheme, and **spawns its own backend** — the built
`apps/server/dist/bin.mjs` (4.3 MB) — which then listens on `13773`.

It is not the same shape as `pnpm dev`, and the difference costs time daily:

```
desktop#dev  dependsOn  t3#build  dependsOn  @t3tools/web#build
```

So a full _production_ web build plus a server CLI pack runs before Electron
ever opens. And because Electron launches the built bundle rather than a
watched process, **a backend change is not live-reloaded under `dev:desktop`**
the way `node --watch` gives you under `dev`. Expect to iterate the server
under `pnpm dev` and only switch to `dev:desktop` when the shell itself is
what you are working on.

Nothing outside the npm world is needed for either. `cargo` is not required —
a missing `native/resource-monitor` binary surfaces as a typed Effect failure
that degrades telemetry rather than blocking boot. Electron's and node-pty's
postinstalls are allow-listed in `pnpm-workspace.yaml`, so pnpm's
supply-chain script blocking does not need a manual approval step. The
Ghostty WASM build is not wired into any `dev` task.

## Providers: five drivers, all spawning your own CLIs

`claudeAgent`, `codex`, `cursor`, `opencode`, `grok` — with Grok and Cursor
going over ACP (`apps/server/src/provider/acp/GrokAcpSupport.ts`,
`CursorAcpSupport.ts`) and Claude/Codex on native paths. That is the
native-where-it-exists, ACP-for-the-rest split we wanted, already built.
Gemini is the only one missing, which is exactly what we reserved as ours.

Adding it is additive: `ProviderDriverKind` is an **open branded slug, not a
closed union** (`packages/contracts/src/providerInstance.ts:70`), so a new
driver needs no contract surgery.

None of them take an API key. Searching `apps/server/src/provider` and
`apps/server/src/textGeneration` for `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` /
`*_API_KEY` returns nothing. Each provider's `binaryPath` defaults to a bare
command name resolved from PATH — `"claude"`, `"codex"`, `"cursor-agent"`,
`"grok"`, `"opencode"` (`packages/contracts/src/settings.ts:203-360`) — so it
runs whatever you already installed and logged into. Codex is spawned as
`codex app-server` speaking JSON-RPC over stdio.

## Clerk: removable cleanly, and not load-bearing for pairing

The server boots, issues a pairing token, completes DPoP pairing and runs a
full agent turn **with no Clerk keys set anywhere**. Source audit agrees with
the live result:

- `apps/server` has **zero** `@clerk/*` imports. It only derives OAuth URLs
  from a publishable-key _string_ (`cloud/publicConfig.ts:176`).
- The whole local pairing path is Clerk-free: `auth/EnvironmentAuth.ts`,
  `auth/dpop.ts`, `startupAccess.ts`, `cli/pair.ts`,
  `packages/shared/src/dpop.ts`.
- All 25 Clerk files belong to **T3 Connect**, their hosted relay-linking
  feature. Clerk governs who may link a _remote_ device through their cloud;
  it has no say over who may pair a _local_ client, which needs only the token
  the server prints to stdout.

The `@clerk` chunks that show up in the network log are static top-level
imports in `main.tsx`, so they are always bundled and fetched — but
`<ClerkProvider>` only mounts when `clerkPublishableKey && hasCloudPublicConfig()`
(`main.tsx:39`). Bundle weight, not runtime initialisation. No Clerk network
call happens without a key.

One asymmetry to remember: `apps/desktop` wires `DesktopClerk.layer`
**unconditionally** into the Electron main-process runtime
(`main.ts:194-212`, `DesktopApp.ts:225`, `preload.ts:12`). No key is needed —
`createClerkBridge` takes none and makes no network call — but
`@clerk/electron` must stay installed and importable for desktop to boot.

**Decision: leave it dormant.** Running local-only costs zero code changes
today. Physical deletion is bounded (~25 files, 3 package.json deps, and
`infra/relay`) and can wait until it actually gets in the way.
