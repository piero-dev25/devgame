import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { EngineToolbar, type EngineToolbarProps } from "./EngineToolbar";
import type { EngineToolbarView } from "./EngineToolbar.logic";

// #111: the three.js Play button hand-wrote a second `aria-label` literal
// ("Run preview") instead of deriving it from the same value shown in the
// tooltip, so a screen reader (and our own computer-use QA driver, which
// reads the accessible NAME) never learned why Play was dead. This suite
// proves the accessible name tracks `unavailableReason` — it must fail
// against the old hardcoded literal.

const THREEJS_VIEW: EngineToolbarView = {
  engineType: "threejs",
  backend: "threejs-script",
  requiresPresenceCommandScope: false,
  hasConnectedEditor: false,
  availableActions: [],
  playState: null,
  disabledReason: null,
  unitySetupCheckFailed: false,
  unityInstallOffered: false,
  unitySetupPending: false,
};

function renderToolbar(overrides: Partial<EngineToolbarProps> = {}) {
  return renderToStaticMarkup(
    <EngineToolbar
      resolvedEngineType="threejs"
      view={THREEJS_VIEW}
      onAction={() => {}}
      hasPresenceCommandScope={false}
      {...overrides}
    />,
  );
}

// React's static renderer HTML-entity-encodes attribute values — verified
// directly against `react-dom/server` (an apostrophe in an aria-label
// becomes `&#x27;` in the rendered attribute). The classifier's own real S4/
// S5 sentences below have apostrophes ("doesn't"), so a plain substring
// match against the raw label would silently fail even when the feature is
// correct — found running this suite against a genuinely-passing
// implementation and getting two false failures. Only the characters that
// actually appear in this file's own fixtures need escaping; extend if a
// future fixture needs more.
function htmlEncodeAttributeValue(value: string): string {
  return value.replaceAll("'", "&#x27;").replaceAll('"', "&quot;");
}

function hasAriaLabel(html: string, label: string): boolean {
  return html.includes(`aria-label="${htmlEncodeAttributeValue(label)}"`);
}

// Whether `text` appears as descendant content of ANY `<button>...</button>`
// block, regardless of how many other tags sit between the button and the
// text (a `<span>` wrapper, in the pre-fix markup this guards against). A
// naive "no other tag directly before the text" regex passes against BOTH
// the buggy markup (text wrapped in a span inside a button) and the fixed
// one — this doesn't, which is why it's the one worth keeping.
function isInsideButton(html: string, text: string): boolean {
  const buttonBlocks = html.match(/<button[^>]*>.*?<\/button>/gs) ?? [];
  return buttonBlocks.some((block) => block.includes(text));
}

// React's static renderer emits a true boolean `disabled` prop as the
// literal attribute `disabled=""`, and OMITS it entirely when false —
// verified directly against `react-dom/server` (`disabled: true` ->
// `<button disabled="">`, `disabled: false` -> `<button>`, no attribute at
// all). A bare `.includes("disabled")` on a button's full outerHTML is
// NOT safe: `Button`'s own class list contains `disabled:pointer-events-none
// disabled:opacity-64` (Tailwind's `disabled:` variant) on EVERY button,
// disabled or not — that string match would report every button as
// disabled, catching nothing. Found by running this suite against the fix
// and getting a false failure on an ENABLED Play button.
function isDisabled(buttonHtml: string): boolean {
  return /\sdisabled=""/.test(buttonHtml);
}

describe("EngineToolbar three.js Play button accessible name (#111)", () => {
  it("uses 'Run preview' as the accessible name when playable", () => {
    const html = renderToolbar({ onPlayThreeJs: () => {} });

    expect(hasAriaLabel(html, "Run preview")).toBe(true);
  });

  it("makes the disabled reason the accessible name, not a generic literal", () => {
    const reason = "Preview only runs in the DevGame desktop app, not a browser tab.";
    const html = renderToolbar({ threeJsUnavailableReason: reason });

    // The bug: aria-label stayed "Run preview" no matter what. The fix: the
    // real reason IS the accessible name once the control is disabled.
    expect(hasAriaLabel(html, "Run preview")).toBe(false);
    expect(hasAriaLabel(html, reason)).toBe(true);
    // The tooltip body must be the SAME string, not an independent copy.
    expect(html).toContain(reason);
  });
});

// Owner ruling: "it's not a 'pick your project', it's just detection of
// project type, so we should not have it selectable." Proves the DROPDOWN
// is gone from the rendered output, not just that ChatView.tsx stopped
// passing an `onSelectEngine` prop (TypeScript already enforces that half —
// the prop no longer exists on `EngineToolbarProps` at all). What a type
// error can't catch is a control that still LOOKS and BEHAVES like a picker
// even after its wiring is removed; this is the rendered-output half of
// that proof, same `renderToStaticMarkup` technique #111 used above for the
// identical "no jsdom in this repo" reason.
describe("EngineToolbar engine label is a static badge, not a picker", () => {
  it("renders no menu-trigger button for the engine — no 'Select engine' accessible name anywhere in the markup", () => {
    const html = renderToolbar();

    expect(hasAriaLabel(html, "Select engine")).toBe(false);
  });

  it("renders the detected engine as plain text content, not inside a <button>", () => {
    const html = renderToolbar({ resolvedEngineType: "unity" });

    expect(html).toContain(">Unity<");
    // A `Badge` with no `render` override is a plain `<span>` — this is the
    // structural proof that "Unity" isn't sitting inside a clickable
    // control of any kind, not just that its own click handler is gone.
    expect(isInsideButton(html, "Unity")).toBe(false);
  });

  it("still renders 'No engine' for the null case", () => {
    const html = renderToolbar({ resolvedEngineType: null });

    expect(html).toContain(">No engine<");
  });
});

// The two-state Unity header (owner's mock): not set up -> a loud CTA the
// header itself is asking you to click; set up -> a quiet pair. Both states
// are driven off `resolveEngineToolbarView`'s existing unity-cli branch
// (already covered by EngineToolbar.test.ts's own suite for READY vs
// NOT-READY, and by that file's own `shouldOfferUnityPipelineInstall`
// suite) — what's new and provable HERE is the RENDERED markup for each,
// which that pure-logic suite can't see.
//
// Owner ruling (mid-build revision): the CTA performs the install directly,
// so it must be gated on `unityInstallOffered` — TRUE only when the
// classifier's own facts say Pipeline is genuinely missing AND Unity is
// open and reachable (see EngineToolbar.logic.ts's own doc comment on that
// field). Two distinct not-ready fixtures below, matching the two distinct
// not-ready behaviours this build has to prove: one where the CTA is the
// right thing to show, one where it would be a lie.
const UNITY_NOT_READY_INSTALL_OFFERED_VIEW: EngineToolbarView = {
  engineType: "unity",
  backend: "unity-cli",
  requiresPresenceCommandScope: true,
  hasConnectedEditor: false,
  availableActions: [],
  playState: null,
  disabledReason:
    "Unity is open, but this project doesn't have Unity's Pipeline package — that's why Play doesn't work here. DevGame can add it to this project.",
  unitySetupCheckFailed: false,
  unityInstallOffered: true,
  unitySetupPending: false,
};

// The literal S5 sentence team-lead cited live as what to show INSTEAD of
// the CTA — Unity isn't open, so an install (which only writes the
// manifest) wouldn't fix the actual blocker here.
const UNITY_NOT_READY_NO_INSTALL_VIEW: EngineToolbarView = {
  engineType: "unity",
  backend: "unity-cli",
  requiresPresenceCommandScope: true,
  hasConnectedEditor: false,
  availableActions: [],
  playState: null,
  disabledReason:
    "This project doesn't have Unity's Pipeline package, and Unity isn't open. Add the package, then open the project in Unity.",
  unitySetupCheckFailed: false,
  unityInstallOffered: false,
  unitySetupPending: false,
};

const UNITY_READY_VIEW: EngineToolbarView = {
  engineType: "unity",
  backend: "unity-cli",
  requiresPresenceCommandScope: true,
  hasConnectedEditor: false,
  availableActions: ["play", "pause", "stop"],
  playState: null,
  disabledReason: null,
  unitySetupCheckFailed: false,
  unityInstallOffered: false,
  unitySetupPending: false,
};

function renderUnityToolbar(view: EngineToolbarView, overrides: Partial<EngineToolbarProps> = {}) {
  return renderToStaticMarkup(
    <EngineToolbar
      resolvedEngineType="unity"
      view={view}
      onAction={() => {}}
      hasPresenceCommandScope
      {...overrides}
    />,
  );
}

describe("EngineToolbar — Unity not-ready state renders the Setup CTA when an install would help", () => {
  it("renders the filled CTA and a disabled Play beside it", () => {
    const html = renderUnityToolbar(UNITY_NOT_READY_INSTALL_OFFERED_VIEW, {
      onSetupUnityIntegrations: () => {},
    });

    expect(html).toContain(">Setup Unity Integrations<");
    // Disabled is asserted structurally (the real `disabled=""` attribute,
    // via `isDisabled` — see its own doc comment for why a bare
    // `.includes("disabled")` is NOT safe here), not just "a Play-labelled
    // button exists somewhere" — a CTA next to an ENABLED Play would be a
    // materially different (and wrong) state.
    const playButtons = html.match(/<button[^>]*>[\s\S]*?<\/button>/g) ?? [];
    const disabledPlay = playButtons.find((block) => block.includes(">Play<") && isDisabled(block));
    expect(disabledPlay).toBeDefined();
  });

  it("does NOT render the CTA when the caller supplies no onSetupUnityIntegrations handler", () => {
    // Mirrors every other optional-callback gate in this file
    // (onOpenConnectionsSettings, onRetryUnitySetup): a control whose click
    // handler is absent must not render as if it were wired.
    const html = renderUnityToolbar(UNITY_NOT_READY_INSTALL_OFFERED_VIEW);

    expect(html).not.toContain("Setup Unity Integrations");
  });

  it("does NOT render the CTA once Unity is ready", () => {
    const html = renderUnityToolbar(UNITY_READY_VIEW, { onSetupUnityIntegrations: () => {} });

    expect(html).not.toContain("Setup Unity Integrations");
  });
});

// Owner ruling: "when the probe says Unity isn't open, or the CLI is
// missing, or Safe Mode — the CTA should not offer an install that won't
// help. Show the classifier's own sentence instead." Proves the OTHER half
// of the gate: a handler being present is not enough on its own — the CTA
// must stay absent when `view.unityInstallOffered` says installing wouldn't
// fix this project's actual blocker, even though nothing here is different
// from the offered case except that one field.
describe("EngineToolbar — Unity not-ready state withholds the CTA when an install would NOT help", () => {
  it("renders no CTA even with a handler provided, and shows the classifier's own sentence instead", () => {
    const html = renderUnityToolbar(UNITY_NOT_READY_NO_INSTALL_VIEW, {
      onSetupUnityIntegrations: () => {},
    });

    expect(html).not.toContain("Setup Unity Integrations");
    // "Show the classifier's own sentence instead" — the disabled Play's
    // accessible name (already fixed for #107 below) is where that
    // sentence lands; still present and unchanged by the CTA's absence.
    expect(hasAriaLabel(html, UNITY_NOT_READY_NO_INSTALL_VIEW.disabledReason ?? "")).toBe(true);
  });
});

// Task: F13 (merge-gate review, low) — the not-ready state used to show
// nothing but a static disabled Play + tooltip for the ENTIRE ~35s the
// connection-wait + probe fetch can take, with no visual sense of progress
// and no live region (a screen reader heard the reason once, on focus,
// never again if it changed without a refocus). Proves the rendered half
// of `unitySetupPending` — `EngineToolbar.test.ts`'s own suite proves the
// pure derivation.
describe("EngineToolbar — Unity not-ready state shows a live 'still checking' indicator while a fetch is in flight (F13)", () => {
  it("renders a role=status/aria-live=polite region with the checking text while pending", () => {
    const html = renderUnityToolbar({
      ...UNITY_NOT_READY_INSTALL_OFFERED_VIEW,
      unitySetupPending: true,
    });

    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("Checking Unity&#x27;s status…");
  });

  it("renders nothing extra while NOT pending — purely additive, not a replacement for the existing disabled button/CTA", () => {
    const html = renderUnityToolbar({
      ...UNITY_NOT_READY_INSTALL_OFFERED_VIEW,
      unitySetupPending: false,
    });

    expect(html).not.toContain('role="status"');
    expect(html).not.toContain("Checking Unity&#x27;s status…");
  });

  it("does not change the disabled Play's own accessible name or tooltip — the pending indicator is a SEPARATE region, not a substitute for the classifier's own reason", () => {
    const html = renderUnityToolbar({
      ...UNITY_NOT_READY_INSTALL_OFFERED_VIEW,
      unitySetupPending: true,
    });

    expect(hasAriaLabel(html, UNITY_NOT_READY_INSTALL_OFFERED_VIEW.disabledReason ?? "")).toBe(
      true,
    );
  });

  it("still renders alongside the CTA when both an install offer AND a pending refresh are true at once (e.g. Retry, or the post-install refresh, over already-classified data)", () => {
    const html = renderUnityToolbar(
      { ...UNITY_NOT_READY_INSTALL_OFFERED_VIEW, unitySetupPending: true },
      { onSetupUnityIntegrations: () => {} },
    );

    expect(html).toContain(">Setup Unity Integrations<");
    expect(html).toContain('role="status"');
  });
});

describe("EngineToolbar — Unity ready state renders 'Unity' + the Play/Pause toggle + Stop", () => {
  it("renders 'Unity' (disabled, bring-to-front not wired up yet) and the toggle reading 'Play' when playState is unknown (null)", () => {
    const html = renderUnityToolbar(UNITY_READY_VIEW); // playState: null

    expect(html).toContain(">Unity<");
    const buttons = html.match(/<button[^>]*>[\s\S]*?<\/button>/g) ?? [];
    const unityButton = buttons.find((block) => block.includes(">Unity<"));
    expect(unityButton).toBeDefined();
    expect(isDisabled(unityButton ?? "")).toBe(true);

    const playButton = buttons.find((block) => block.includes(">Play<"));
    expect(playButton).toBeDefined();
    // Unlike the not-ready state's Play, THIS Play must be clickable.
    expect(isDisabled(playButton ?? "")).toBe(false);
    expect(hasAriaLabel(html, "Pause")).toBe(false);
  });

  it("does NOT render the old multi-action Group's play-target chevron for Unity — that stays editor-presence-only", () => {
    // The mock's pair collapses to a trio with this change (toggle + Stop),
    // still not the generic editor-presence Group with its trailing
    // play-target menu — that control has no Unity equivalent.
    const html = renderUnityToolbar(UNITY_READY_VIEW);

    expect(hasAriaLabel(html, "Play target options")).toBe(false);
  });

  // Task: Play/Stop toggle in one slot (owner ruling, 2026-08-05) + Stop as
  // its own always-visible, disabled-with-a-reason button — proves the
  // RENDERED markup for all three `EditorPresencePlayState` values, the
  // half `EngineToolbar.test.ts`'s `resolveUnityPlayToggleAction` suite
  // can't see (that suite proves the pure derivation; this proves the
  // component actually renders what it derives).
  it("playing: toggle reads 'Pause' and is pressed/engaged; Stop is enabled with no 'nothing to stop' reason", () => {
    const html = renderUnityToolbar({ ...UNITY_READY_VIEW, playState: "playing" });
    const buttons = html.match(/<button[^>]*>[\s\S]*?<\/button>/g) ?? [];

    // No plain "Play" button while playing — the SAME slot now says Pause,
    // not an ADDITIONAL button alongside it.
    expect(hasAriaLabel(html, "Play")).toBe(false);
    const pauseButton = buttons.find((block) => block.includes(">Pause<"));
    expect(pauseButton).toBeDefined();
    expect(isDisabled(pauseButton ?? "")).toBe(false);
    expect((pauseButton ?? "").includes('aria-pressed="true"')).toBe(true);

    const stopButton = buttons.find((block) => block.includes(">Stop<"));
    expect(stopButton).toBeDefined();
    expect(isDisabled(stopButton ?? "")).toBe(false);
    expect(hasAriaLabel(html, "Nothing is playing to stop.")).toBe(false);
  });

  it("paused: toggle reads 'Play' again (resuming is the same wire action as starting) but stays pressed/engaged; Stop stays enabled", () => {
    const html = renderUnityToolbar({ ...UNITY_READY_VIEW, playState: "paused" });
    const buttons = html.match(/<button[^>]*>[\s\S]*?<\/button>/g) ?? [];

    expect(hasAriaLabel(html, "Pause")).toBe(false);
    const playButton = buttons.find((block) => block.includes(">Play<"));
    expect(playButton).toBeDefined();
    expect(isDisabled(playButton ?? "")).toBe(false);
    expect((playButton ?? "").includes('aria-pressed="true"')).toBe(true);

    const stopButton = buttons.find((block) => block.includes(">Stop<"));
    expect(stopButton).toBeDefined();
    expect(isDisabled(stopButton ?? "")).toBe(false);
  });

  it("stopped explicitly (playState: \"stopped\"): Stop is present but disabled, with the stated 'nothing to stop' reason as its accessible name", () => {
    const html = renderUnityToolbar({ ...UNITY_READY_VIEW, playState: "stopped" });
    const buttons = html.match(/<button[^>]*>[\s\S]*?<\/button>/g) ?? [];

    const stopButton = buttons.find((block) => block.includes(">Stop<"));
    expect(stopButton).toBeDefined();
    expect(isDisabled(stopButton ?? "")).toBe(true);
    // Same #107/#111 discipline: the disabled reason IS the accessible name,
    // not a generic "Stop" a screen reader can't distinguish from working.
    expect(hasAriaLabel(html, "Nothing is playing to stop.")).toBe(true);
    expect((stopButton ?? "").includes('aria-label="Stop"')).toBe(false);
  });
});

describe("EngineToolbar — non-Unity editor-presence toolbar is untouched", () => {
  const GODOT_READY_VIEW: EngineToolbarView = {
    engineType: "godot",
    backend: "editor-presence",
    requiresPresenceCommandScope: true,
    hasConnectedEditor: true,
    availableActions: ["play", "pause", "stop"],
    playState: null,
    disabledReason: null,
    unitySetupCheckFailed: false,
    unityInstallOffered: false,
    unitySetupPending: false,
  };

  it("still renders the full Play/Pause/Stop cluster and play-target chevron for Godot", () => {
    const html = renderToStaticMarkup(
      <EngineToolbar
        resolvedEngineType="godot"
        view={GODOT_READY_VIEW}
        onAction={() => {}}
        hasPresenceCommandScope
      />,
    );

    expect(hasAriaLabel(html, "Play")).toBe(true);
    expect(hasAriaLabel(html, "Pause")).toBe(true);
    expect(hasAriaLabel(html, "Stop")).toBe(true);
    expect(hasAriaLabel(html, "Play target options")).toBe(true);
    // And no Unity-only affordances leak into this path.
    expect(html).not.toContain("Setup Unity Integrations");
  });
});

// #107: Play's accessible name used to be the hard-coded literal
// "No editor connected" regardless of the REAL reason — so a screen reader
// (and a computer-use QA driver, which reads the accessible name, not the
// visible tooltip) always heard that generic sentence even when a specific
// classified reason (Unity's, or editor-presence's) was available.
describe("EngineToolbar — disabled Play's accessible name (#107)", () => {
  it("uses Unity's specific classified reason as the accessible name, not the generic literal", () => {
    const html = renderUnityToolbar(UNITY_NOT_READY_INSTALL_OFFERED_VIEW);

    expect(hasAriaLabel(html, "No editor connected")).toBe(false);
    expect(hasAriaLabel(html, UNITY_NOT_READY_INSTALL_OFFERED_VIEW.disabledReason ?? "")).toBe(
      true,
    );
  });

  it("still falls back to a stated generic reason for editor-presence with nothing connected (never the old literal)", () => {
    const godotNotConnected: EngineToolbarView = {
      engineType: "godot",
      backend: "editor-presence",
      requiresPresenceCommandScope: true,
      hasConnectedEditor: false,
      availableActions: [],
      playState: null,
      disabledReason: null,
      unitySetupCheckFailed: false,
      unityInstallOffered: false,
      unitySetupPending: false,
    };
    const html = renderToStaticMarkup(
      <EngineToolbar
        resolvedEngineType="godot"
        view={godotNotConnected}
        onAction={() => {}}
        hasPresenceCommandScope
      />,
    );

    expect(hasAriaLabel(html, "No editor connected")).toBe(false);
    expect(hasAriaLabel(html, "No editor is connected for this project.")).toBe(true);
  });
});
