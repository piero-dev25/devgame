# Owner decisions: engine controls, dockable panels, Figma/Notion

Rulings made 2026-08-03 after the eight-lane research pass. Recorded so nobody
re-litigates them, and so the reasoning survives the conversation that produced
it. Research findings live in the workflow report; this file is decisions only.

## 1. Engine selector is scoped PER PROJECT

Asked as "per-tab or global?" and answered "per-project if that exists,
otherwise per-tab." It exists: threads carry a `projectId` (see
`packages/contracts/src/orchestration.ts`, and `createThread.projectId`), so
per-project is available and is the ruling.

This is also the semantically correct scope. A Unity project is a Unity project
regardless of which tab you are looking at, so the selector is really a
**per-project override of a detected default**, not an independent setting.
Selecting a tab that belongs to a project shows that project's engine.

Consequence: do NOT copy the agent-harness selector's state model. That one is
per-tab — every open chat mounts its own instance with its own state. Copy its
_appearance_, not its scoping.

## 2. Unreal 5.5+ only

No need to target 5.4 or below.

This removes real complexity. Below 5.5 the only script-reachable mode is
"Simulate", which runs the world without giving the player a character — a
materially different experience that would have needed either a second button
or a version-gated explanation. Neither is now required. If the minimum ever
drops, that decision comes back.

## 3. Dock layout: start with separate panels

Owner: "whatever you recommend, we will tune layouts later."

Ruling: ship Files / Diff / Terminal / Browser as **separate panels in a row**,
which the existing layout-migration code already handles. A single tabbed group
docked below or beside chat is a shape that code explicitly refuses to guess at
and would need extending. Since layouts are going to be tuned later anyway,
spending that work before anyone has used the panels is premature.

Build order stands: Diff (already reads its identity from the URL, ~80% ready),
then Files, then Browser, then Terminal (worst — it exists twice, as a tab and a
drawer, with two stores actively reconciled).

## 4. Figma AND Notion go in the browser panel

Owner ruling, and it corrects a research finding rather than overriding it.

One lane reported "Notion cannot be embedded" after confirming that
`notion.so` and `figma.com` both send `x-frame-options: SAMEORIGIN`. That test
is correct but measures the wrong thing for this app: **`X-Frame-Options` and
`frame-ancestors` govern nested browsing contexts (iframes).** Our browser panel
is an Electron `<webview>` (`ElectronWebview` in
`apps/web/src/browser/HostedBrowserWebview.tsx`) — a _separate top-level_
browsing context with its own WebContents, like a browser tab. There is no
`<iframe>` anywhere in `apps/web/src`.

Corroborating evidence sits in Notion's own header: its `frame-ancestors` list
includes `notion://app.notion.com` and `notion://www.notion.so` — custom-scheme
origins, which is how Notion's own Electron desktop app renders it.

So both products load in the panel, with the session persisting across restarts
(the partition is `persist:`-prefixed and shared, not per-thread — see
`apps/desktop/src/preview/BrowserSession.ts`). Identity for "add to chat" comes
from the panel's own URL, which is data we own: Figma encodes file key and
selected node in the URL, Notion encodes the page id.

**Still unverified, and it must be before this hardens:** nobody has yet watched
figma.com or notion.so actually load inside the webview. The reasoning is sound
and matches how Notion ships its own desktop app, but it is reasoning, not an
observation. One hands-on check settles it.

Consequence: no Figma plugin is required for a first version, and Notion is not
downgraded to agent-access-only. Both remain first-class. The plugin route stays
available later if pointing at the live canvas turns out to matter more than
reading the URL.

## 5. Clerk allowlist (done, not pending)

The scheme rename needed matching Clerk entries or desktop sign-in would break.
The allowlist was empty — upstream's `t3code://app/` was never on this instance,
because the instance is ours and new — so these were added rather than edited:

- `devgame://app/`
- `devgame-dev://app/`
- `devgame-preview://app/`

Instance: DevGame / Development (`ins_3HQAS9KyWzySuATNYzCaBYC8YPB`). Note this is
a **test** instance (`pk_test_`); a production release needs the same three
entries added to the production instance.

## Carried forward, not yet decided

- **Frame-step.** Unity-only through supported APIs; Godot and Unreal expose no
  scriptable equivalent. Recommendation stands: ship Play/Stop first, treat
  frame-step as a Unity-only follow-up.
- **Does the Terminal drawer survive** when Terminal becomes a real panel?
- **Editor-presence permissions.** The route performs no permission check today
  and sits outside the compile-time net that catches that elsewhere. Harmless
  for a read-only presence feed; not harmless once it can make an engine run
  code. This lands BEFORE command support, not after.
