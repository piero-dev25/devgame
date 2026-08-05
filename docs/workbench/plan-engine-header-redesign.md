# Plan — project-scoped engine header

Owner intent, from two mocks and the conversation:

1. Unity integration is **project-scoped**, not global — it belongs in the chat
   header next to `Mafia Game / New thread`, not in Settings → Connections.
2. The engine is **detected, never chosen**. The dropdown goes away.
3. **Before setup**: one loud CTA, `Setup Unity Integrations`, filled in the
   send-button colour, with `Play` disabled beside it.
4. **After setup**: it collapses to two quiet outline buttons — `Unity`
   (bring the Editor to the front) and `Play` (bring to front _and_ play).

The header should say what to do next: loud when setup is needed, quiet once
it works.

---

## What research settled

### The actions hypothesis fails — and it inverts the fork argument

The owner asked whether `+ Add action` is a script-runner we could reuse, with
the Unity buttons as "always-pinned actions". Tested; the answer is no.

- **Execution is terminal keystroke injection.** `runProjectScript`
  (`ChatView.tsx:2901`) opens a PTY and writes `` `${script.command}\r` ``
  (`:2984-2991`). It types the command and presses Enter. **No exit code or
  result is captured.** A setup flow with per-step outcomes cannot be expressed.
- **No dynamic state.** `ProjectScript`
  (`packages/contracts/src/orchestration.ts:195-213`) has 7 static fields — no
  enabled/disabled, no loading, no conditional visibility, no label variants.
  The entire "loud CTA → quiet pair" behaviour would live outside the model.
- **No pinning.** The "primary" script is `preferredScriptId`, derived from a
  client-side `useLocalStorage` map of _last script this browser ran_
  (`ChatView.tsx:1196`). Not a designed pin — a recency accident.
- **Icons are a closed enum** — `["play","test","lint","configure","build","debug"]`.
  No Unity glyph without editing the shared contract.
- **It is live upstream code.** Added by the upstream maintainer
  (`3537d4770`), and upstream has kept touching it _after_ our divergence point
  (`ad9bc6c1d`, `ce96ad0b6`, `f20bbdf26`, `dfe06261c`).

**That last point inverts the fork doctrine argument.** The instinct was
"build on upstream rather than diverge." But `ProjectScript` is upstream's
schema: adding a pin flag, dynamic state and a Unity icon means editing a file
upstream actively maintains — **permanent, recurring merge conflict**. Building
bespoke in our own component is _additive_ and conflicts with nothing. Here,
the doctrine argues **against** reuse.

And Unity Play already has a better mechanism: `EngineToolbar` +
`EngineDispatchBackend`, shipped with an engaged toggle, `aria-pressed`,
disabled-reasons from a live probe, permission-scope gating, and decoded
(not cast) dispatch responses. Retrofitting onto `ProjectScript` would trade
that for "type a shell command."

**One piece does hold**: programmatic seeding is trivial (`saveProjectScript`
is a plain write path, already used non-interactively by `importFileScript`).
Worth remembering if a _step_ is genuinely "run this shell command" — as
three.js Play already does.

### The header is already correctly scoped; Settings is not

`ChatView.tsx` computes `activeProjectRef` (`:1499-1503`) and probes with the
**thread's** `environmentId` — correct. `ConnectionsSettings` uses
`primaryEnvironmentId` — the local backend, regardless of what you are looking
at. Against a remote/paired environment the panel reports the **wrong
project** under a heading naming the right one (#110).

`ChatHeader.tsx:67-77` already guards this exact mismatch for `OpenInPicker`,
hiding it when environments diverge. The Unity panel has no such gate.

So the move is not cosmetic: **the header is the only correctly-scoped
surface.** The redesign deletes the wrong-scope caller by construction.

### Bring-to-front is free; Play does not do it today

- Nothing in the repo raises a native window. The Unity CLI has **no** focus
  verb (`unity --help`, `unity pipeline --help` — verified live).
- **`open -a "Unity"` costs no permission** — Launch Services, not Apple
  Events, so no TCC prompt ever. It extends `externalLauncher.ts:240-246`,
  already used for browsers. Known gap: targets by app name, so it cannot
  disambiguate two Editors on two projects. The precise alternative
  (`osascript` + pid) needs an Automation grant — **not worth buying yet**.
- **Play is headless today.** `unity command editor_play --project-path <root>
--json` flips play mode in place; no window management anywhere in that path.
  So "Play brings it forward _and_ plays" = existing dispatch + the new raise.
- **Play/Stop needs no backend work.** `UnityEditorStatus.playMode`
  (`stopped|playing|paused`) is already read by the same call play/stop use to
  confirm their own effect. A toggling button is a client decision.

### The probe never fires — everything else is unverifiable until this is fixed

`readPreparedConnection` (`state/session.ts:24-28`) is a **synchronous
one-shot snapshot**, not a subscription. Both probe effects bail on
`if (!prepared) return;` having set **neither result nor error**, and nothing
in their dependency arrays changes when the async auth handshake later
completes. Permanent give-up, rendered as an eternal spinner (#106).

A reactive `usePreparedConnection` already exists in the same file, unused by
both.

---

## Sequence

### Phase 0 — fix the probe (BLOCKING)

Nothing below is verifiable while the header renders states it never receives.

- Make both effects react to the prepared connection becoming ready.
- **The bail must stop being silent** — exit without a retry ⇒ set a stated
  reason.
- Add a timeout + retry affordance regardless of cause. An unbounded spinner
  with no escape is a defect on its own terms.
- Proof: mount with the connection atom at `Option.none()`, transition to
  `Some`, assert the probe **fires** and the panel **leaves** Checking.
  Asserting `readPreparedConnection` was called proves nothing — it is called
  today and returns null.

### Phase 1 — header states

- **Remove the dropdown and stop reading `overrideByProjectKey` in the same
  change.** Removing only the UI strands a localStorage override that still
  beats detection, with no way to correct it (`engineSelectorStore.ts:73-80`).
- Render the detected engine as a **static label**, not a control.
- Two states off the existing probe:
  - not ready ⇒ `Setup Unity Integrations`, filled `--primary`, + disabled Play
  - ready ⇒ `Unity` + `Play`, both outline
- **The CTA is the first filled button in that row** — every existing control
  is `variant="outline" size="xs"`. Deliberate, per the mock.
- **Reuse `postPipelineInstall.ts`** and keep `UnityPipelineInstallButton`'s
  consent dialog. Nothing writes to the project without a click — an existing
  owner ruling, not a default to drop in the move.

### Phase 2 — delete the Settings panel

Clean excision: ~450 lines, every helper file-local, zero external importers.
Resolves #110 by construction.

**Keep**: `setupProbeCache.ts`, `fetchSetupProbe.ts`, the contracts (ChatView
depends on them), and `postPipelineInstall.ts` — **adopt, don't delete**.

### Phase 3 — bring-to-front

`open -a "Unity"` via `ExternalLauncher`. Wire `Unity` = raise; `Play` =
raise + dispatch.

### Cross-cutting

- Fix the hardcoded `aria-label` (#107) wherever the control lands.
- **There is no component test that mounts this UI.** That is precisely why
  "stuck on Checking…" reached a live QA pass. Phase 0 should add the first.

---

## Owner decisions needed

1. **What does the CTA do in the states Install cannot fix?** There are 14
   non-ready states. Your case today is S4 (Editor open, package missing) —
   Install is exactly right. But S1 (no CLI), S6 (Unity closed), S7a (Safe
   Mode) are not fixable by installing a package. Does the CTA open a dialog
   that explains the specific blocker, or stay disabled with a reason?
2. **Pause.** Unity has three states; the mock has two buttons. Collapse pause,
   or keep a third affordance?
3. **Non-Unity projects.** Godot/Unreal/three.js exist in the current selector.
   Does the header show nothing for them, or an equivalent per-engine pair?
4. **Multi-instance.** Accept the `open -a` limitation (cannot disambiguate two
   Editors), or buy the Automation permission for pid-precise focus?
