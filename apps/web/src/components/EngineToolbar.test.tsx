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
  unitySetupResolved: true,
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasAriaLabel(html: string, label: string): boolean {
  const encodedLabel = escapeRegExp(htmlEncodeAttributeValue(label));
  return new RegExp(`(?:^|\\s)aria-label="${encodedLabel}"(?:\\s|>)`).test(html);
}

function hasExactText(html: string, text: string): boolean {
  return new RegExp(`>${escapeRegExp(htmlEncodeAttributeValue(text))}<`).test(html);
}

function getButtons(html: string): ReadonlyArray<string> {
  return html.match(/<button[^>]*>[\s\S]*?<\/button>/g) ?? [];
}

function findButtonByAriaLabel(html: string, label: string): string | undefined {
  return getButtons(html).find((button) => hasAriaLabel(button, label));
}

function findButtonByExactText(html: string, text: string): string | undefined {
  const exactText = new RegExp(`>${escapeRegExp(htmlEncodeAttributeValue(text))}<`);
  return getButtons(html).find((button) => exactText.test(button));
}

function hasClass(html: string, className: string): boolean {
  const exactClass = escapeRegExp(className);
  return new RegExp(`class="(?:[^"]* )?${exactClass}(?: [^"]*)?"`).test(html);
}

function getUnityTransportGroup(html: string): string | undefined {
  const groups = html.match(/<div[^>]*role="group"[^>]*>[\s\S]*?<\/div>/g) ?? [];
  return groups.find((group) => hasAriaLabel(group, "Unity transport controls"));
}

// Whether `text` appears as descendant content of ANY `<button>...</button>`
// block, regardless of how many other tags sit between the button and the
// text (a `<span>` wrapper, in the pre-fix markup this guards against). A
// naive "no other tag directly before the text" regex passes against BOTH
// the buggy markup (text wrapped in a span inside a button) and the fixed
// one — this doesn't, which is why it's the one worth keeping.
function isInsideButton(html: string, text: string): boolean {
  const buttonBlocks = html.match(/<button[^>]*>.*?<\/button>/gs) ?? [];
  const exactText = new RegExp(`>${escapeRegExp(text)}<`);
  return buttonBlocks.some((block) => exactText.test(block));
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
//
// QA round 2 (#124): every disabled-with-a-tooltip button in this file now
// uses `aria-disabled="true"` instead of the native `disabled` attribute —
// native `disabled` makes a browser skip the element during hit-testing,
// which silently kills its Tooltip's hover trigger along with the click
// (see `ThreeJsPlayButton`'s own doc comment in EngineToolbar.tsx for the
// full root cause a live QA pass confirmed). "Disabled" in this file's
// markup can now mean either mechanism depending on which control it is —
// this helper checks both, so every EXISTING call site below keeps meaning
// "is this button disabled," not "does this button happen to use the OLD
// mechanism."
function isDisabled(buttonHtml: string): boolean {
  return /\sdisabled=""/.test(buttonHtml) || /\saria-disabled="true"/.test(buttonHtml);
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
    // `renderToStaticMarkup` omits a closed TooltipPopup, so this suite can
    // assert the exact accessible name but not duplicate the component's
    // shared `label` expression as observable tooltip text.
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

  it("keeps a non-Unity detected engine as plain text content, not inside a <button>", () => {
    const html = renderToolbar();

    expect(hasExactText(html, "three.js")).toBe(true);
    // A `Badge` with no `render` override is a plain `<span>` — this is the
    // structural proof that "three.js" isn't sitting inside a clickable
    // control of any kind, not just that its own click handler is gone.
    expect(isInsideButton(html, "three.js")).toBe(false);
  });

  it("still renders 'No engine' for the null case", () => {
    const html = renderToolbar({ resolvedEngineType: null });

    expect(hasExactText(html, "No engine")).toBe(true);
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
  unitySetupResolved: true,
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
  unitySetupResolved: true,
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
  unitySetupResolved: true,
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
  it("renders one filled icon-led 'Setup Integrations' control and a two-button disabled icon-only transport Group", () => {
    const html = renderUnityToolbar(UNITY_NOT_READY_INSTALL_OFFERED_VIEW, {
      onSetupUnityIntegrations: () => {},
    });

    const setupButton = findButtonByExactText(html, "Setup Integrations");
    expect(setupButton).toBeDefined();
    expect(hasClass(setupButton ?? "", "bg-primary")).toBe(true);
    expect(setupButton ?? "").toMatch(
      /<svg(?=[^>]*fill="currentColor")(?=[^>]*aria-hidden="true")[^>]*>/,
    );
    expect(hasExactText(html, "Setup Unity Integrations")).toBe(false);

    const transport = getUnityTransportGroup(html);
    expect(transport).toBeDefined();
    expect(getButtons(transport ?? "")).toHaveLength(2);
    const reason = UNITY_NOT_READY_INSTALL_OFFERED_VIEW.disabledReason ?? "";
    const playButton = findButtonByAriaLabel(transport ?? "", `Play — ${reason}`);
    const pauseButton = findButtonByAriaLabel(transport ?? "", `Pause — ${reason}`);
    expect(playButton).toBeDefined();
    expect(pauseButton).toBeDefined();
    expect(isDisabled(playButton ?? "")).toBe(true);
    expect(isDisabled(pauseButton ?? "")).toBe(true);
    expect(html).not.toMatch(/>(?:Play|Stop|Pause)</);
  });

  it("does NOT render the CTA when the caller supplies no onSetupUnityIntegrations handler", () => {
    // Mirrors every other optional-callback gate in this file
    // (onOpenConnectionsSettings, onRetryUnitySetup): a control whose click
    // handler is absent must not render as if it were wired.
    const html = renderUnityToolbar(UNITY_NOT_READY_INSTALL_OFFERED_VIEW);

    expect(hasExactText(html, "Setup Integrations")).toBe(false);
    const unityButton = findButtonByExactText(html, "Unity");
    expect(unityButton).toBeDefined();
    expect(
      hasAriaLabel(unityButton ?? "", UNITY_NOT_READY_INSTALL_OFFERED_VIEW.disabledReason ?? ""),
    ).toBe(true);
  });

  it("does NOT render the CTA once Unity is FULLY ready (nothing offered)", () => {
    const html = renderUnityToolbar(UNITY_READY_VIEW, { onSetupUnityIntegrations: () => {} });

    expect(hasExactText(html, "Setup Integrations")).toBe(false);
  });

  it("S9 (#129): replaces the quiet Unity control with the CTA while retaining the ready two-button transport Group", () => {
    const html = renderUnityToolbar(
      { ...UNITY_READY_VIEW, unityInstallOffered: true },
      { onSetupUnityIntegrations: () => {} },
    );

    expect(hasExactText(html, "Setup Integrations")).toBe(true);
    expect(hasExactText(html, "Unity")).toBe(false);
    const transport = getUnityTransportGroup(html);
    expect(transport).toBeDefined();
    expect(getButtons(transport ?? "")).toHaveLength(2);
    expect(hasAriaLabel(transport ?? "", "Play")).toBe(true);
    expect(hasAriaLabel(transport ?? "", "Nothing is playing to pause.")).toBe(true);
  });

  it("S9 render is handler-gated: without a handler the quiet Unity control and transport Group remain", () => {
    const html = renderUnityToolbar({ ...UNITY_READY_VIEW, unityInstallOffered: true });

    expect(hasExactText(html, "Setup Integrations")).toBe(false);
    expect(html.match(/>Unity</g) ?? []).toHaveLength(1);
    expect(getButtons(getUnityTransportGroup(html) ?? "")).toHaveLength(2);
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

    expect(hasExactText(html, "Setup Integrations")).toBe(false);
    const unityButton = findButtonByExactText(html, "Unity");
    expect(unityButton).toBeDefined();
    expect(
      hasAriaLabel(unityButton ?? "", UNITY_NOT_READY_NO_INSTALL_VIEW.disabledReason ?? ""),
    ).toBe(true);
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
  // Owner report (2026-08-05): the worded banner flashed "big and long" on
  // every window refocus. New contract — a re-check over a KNOWN state
  // renders nothing extra (the known controls stay, ChatView retains the
  // last classified result via resolveUnitySetupForView); the indicator
  // survives ONLY for a genuinely unresolved first load, compacted to a
  // spinner whose text lives in the accessible name, never on screen.
  it("re-checking over a KNOWN state renders NO indicator at all — the known controls stay put", () => {
    const html = renderUnityToolbar(
      {
        ...UNITY_NOT_READY_INSTALL_OFFERED_VIEW,
        unitySetupPending: true,
        unitySetupResolved: true,
      },
      { onSetupUnityIntegrations: () => {} },
    );

    expect(html).not.toMatch(/(?:^|\s)role="status"(?:\s|>)/);
    expect(hasExactText(html, "Checking Unity's status…")).toBe(false);
    // The known state's own controls are unchanged by the background check.
    expect(html).toContain("Setup Integrations");
  });

  it("a genuinely unresolved first load shows the compact spinner: role=status region, text in the ACCESSIBLE NAME only, never visible", () => {
    const html = renderUnityToolbar({
      ...UNITY_NOT_READY_INSTALL_OFFERED_VIEW,
      unitySetupPending: true,
      unitySetupResolved: false,
    });

    expect(html).toMatch(/(?:^|\s)role="status"(?:\s|>)/);
    expect(html).toMatch(/(?:^|\s)aria-live="polite"(?:\s|>)/);
    expect(html).toMatch(/aria-label="Checking Unity(?:&#x27;|')s status…"/);
    expect(hasExactText(html, "Checking Unity's status…")).toBe(false);
  });

  it("renders nothing extra while NOT pending — purely additive, not a replacement for the existing disabled button/CTA", () => {
    const html = renderUnityToolbar({
      ...UNITY_NOT_READY_INSTALL_OFFERED_VIEW,
      unitySetupPending: false,
    });

    expect(html).not.toMatch(/(?:^|\s)role="status"(?:\s|>)/);
    expect(hasExactText(html, "Checking Unity's status…")).toBe(false);
  });

  it("does not change the disabled Unity control's accessible name or tooltip — the pending indicator is a SEPARATE region, not a substitute for the classifier's own reason", () => {
    const html = renderUnityToolbar({
      ...UNITY_NOT_READY_INSTALL_OFFERED_VIEW,
      unitySetupPending: true,
    });

    expect(hasAriaLabel(html, UNITY_NOT_READY_INSTALL_OFFERED_VIEW.disabledReason ?? "")).toBe(
      true,
    );
  });

  it("a pending refresh over already-classified data (Retry, the post-install refresh) keeps the CTA and adds NOTHING — superseding this test's pre-2026-08-05 contract, which asserted a visible indicator alongside", () => {
    const html = renderUnityToolbar(
      {
        ...UNITY_NOT_READY_INSTALL_OFFERED_VIEW,
        unitySetupPending: true,
        unitySetupResolved: true,
      },
      { onSetupUnityIntegrations: () => {} },
    );

    expect(hasExactText(html, "Setup Integrations")).toBe(true);
    expect(html).not.toMatch(/(?:^|\s)role="status"(?:\s|>)/);
  });
});

describe("EngineToolbar — Unity ready state renders one Unity control + a two-button icon transport", () => {
  it("renders exactly one element carrying the exact Unity label", () => {
    const html = renderUnityToolbar(UNITY_READY_VIEW);

    expect(html.match(/>Unity</g) ?? []).toHaveLength(1);
  });

  it("unknown: renders the quiet disabled Unity control, Play, and disabled Pause with no visible transport words", () => {
    const html = renderUnityToolbar(UNITY_READY_VIEW); // playState: null

    const unityReason = "Bringing the Unity Editor to the front isn't wired up yet.";
    const unityButton = findButtonByExactText(html, "Unity");
    expect(unityButton).toBeDefined();
    expect(isDisabled(unityButton ?? "")).toBe(true);
    expect(hasAriaLabel(unityButton ?? "", unityReason)).toBe(true);

    const transport = getUnityTransportGroup(html);
    expect(transport).toBeDefined();
    expect(getButtons(transport ?? "")).toHaveLength(2);
    const playButton = findButtonByAriaLabel(transport ?? "", "Play");
    expect(playButton).toBeDefined();
    expect(isDisabled(playButton ?? "")).toBe(false);
    expect(hasClass(playButton ?? "", "lucide-play")).toBe(true);
    const pauseButton = findButtonByAriaLabel(transport ?? "", "Nothing is playing to pause.");
    expect(pauseButton).toBeDefined();
    expect(isDisabled(pauseButton ?? "")).toBe(true);
    expect(hasClass(pauseButton ?? "", "lucide-pause")).toBe(true);
    expect(html).not.toMatch(/>(?:Play|Stop|Pause)</);
  });

  it("enables the Unity control with the active accessible name when a raise handler exists", () => {
    const html = renderUnityToolbar(UNITY_READY_VIEW, { onBringUnityToFront: () => {} });
    const unityButton = findButtonByExactText(html, "Unity");

    expect(unityButton).toBeDefined();
    expect(isDisabled(unityButton ?? "")).toBe(false);
    expect(hasAriaLabel(unityButton ?? "", "Bring the Unity Editor to the front")).toBe(true);
    expect(
      hasAriaLabel(unityButton ?? "", "Bringing the Unity Editor to the front isn't wired up yet."),
    ).toBe(false);
  });

  it("does NOT render the old multi-action Group's play-target chevron for Unity — that stays editor-presence-only", () => {
    // The Unity transport is still not the generic editor-presence Group
    // with its trailing
    // play-target menu — that control has no Unity equivalent.
    const html = renderUnityToolbar(UNITY_READY_VIEW);

    expect(hasAriaLabel(html, "Play target options")).toBe(false);
  });

  // Task: Play/Stop toggle in one slot (owner ruling, 2026-08-05) + Pause as
  // its own always-visible latch — proves the
  // RENDERED markup for all three `EditorPresencePlayState` values, the
  // half `EngineToolbar.test.ts`'s `resolveUnityPlayToggleAction` suite
  // can't see (that suite proves the pure derivation; this proves the
  // component actually renders what it derives).
  it("playing: the first button is an engaged square labelled Stop and Pause is enabled but not latched", () => {
    const html = renderUnityToolbar({ ...UNITY_READY_VIEW, playState: "playing" });
    const transport = getUnityTransportGroup(html) ?? "";

    expect(getButtons(transport)).toHaveLength(2);
    const stopButton = findButtonByAriaLabel(transport, "Stop");
    expect(stopButton).toBeDefined();
    expect(isDisabled(stopButton ?? "")).toBe(false);
    expect(stopButton ?? "").toMatch(/(?:^|\s)aria-pressed="true"(?:\s|>)/);
    expect(hasClass(stopButton ?? "", "bg-primary")).toBe(true);
    expect(hasClass(stopButton ?? "", "lucide-square")).toBe(true);

    const pauseButton = findButtonByAriaLabel(transport, "Pause");
    expect(pauseButton).toBeDefined();
    expect(isDisabled(pauseButton ?? "")).toBe(false);
    expect(pauseButton ?? "").toMatch(/(?:^|\s)aria-pressed="false"(?:\s|>)/);
    expect(hasClass(pauseButton ?? "", "lucide-pause")).toBe(true);
    expect(hasAriaLabel(transport, "Play")).toBe(false);
    expect(html).not.toMatch(/>(?:Play|Stop|Pause)</);
  });

  it("paused: Play resumes in the first slot and the Pause button alone is visually latched", () => {
    const html = renderUnityToolbar({ ...UNITY_READY_VIEW, playState: "paused" });
    const transport = getUnityTransportGroup(html) ?? "";

    expect(getButtons(transport)).toHaveLength(2);
    const playButton = findButtonByAriaLabel(transport, "Play");
    expect(playButton).toBeDefined();
    expect(isDisabled(playButton ?? "")).toBe(false);
    expect(playButton ?? "").toMatch(/(?:^|\s)aria-pressed="false"(?:\s|>)/);
    expect(hasClass(playButton ?? "", "lucide-play")).toBe(true);

    const pauseButton = findButtonByAriaLabel(transport, "Pause");
    expect(pauseButton).toBeDefined();
    expect(isDisabled(pauseButton ?? "")).toBe(false);
    expect(pauseButton ?? "").toMatch(/(?:^|\s)aria-pressed="true"(?:\s|>)/);
    expect(hasClass(pauseButton ?? "", "bg-primary")).toBe(true);
    expect(hasAriaLabel(transport, "Stop")).toBe(false);
    expect(html).not.toMatch(/>(?:Play|Stop|Pause)</);
  });

  it("stopped: Play is enabled and Pause is aria-disabled with its exact reason", () => {
    const html = renderUnityToolbar({ ...UNITY_READY_VIEW, playState: "stopped" });
    const transport = getUnityTransportGroup(html) ?? "";

    expect(getButtons(transport)).toHaveLength(2);
    const playButton = findButtonByAriaLabel(transport, "Play");
    expect(playButton).toBeDefined();
    expect(isDisabled(playButton ?? "")).toBe(false);
    const pauseButton = findButtonByAriaLabel(transport, "Nothing is playing to pause.");
    expect(pauseButton).toBeDefined();
    expect(hasNativeDisabled(pauseButton ?? "")).toBe(false);
    expect(hasAriaDisabledTrue(pauseButton ?? "")).toBe(true);
    expect(hasAriaLabel(transport, "Pause")).toBe(false);
    expect(html).not.toMatch(/>(?:Play|Stop|Pause)</);
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
    expect(hasExactText(html, "Setup Integrations")).toBe(false);
  });
});

// #107: a disabled control's accessible name used to be the hard-coded literal
// "No editor connected" regardless of the REAL reason — so a screen reader
// (and a computer-use QA driver, which reads the accessible name, not the
// visible tooltip) always heard that generic sentence even when a specific
// classified reason (Unity's, or editor-presence's) was available.
describe("EngineToolbar — disabled Unity controls' accessible names (#107)", () => {
  it("uses Unity's specific classified reason on the Unity control and action-prefixed versions on both transport buttons", () => {
    const html = renderUnityToolbar(UNITY_NOT_READY_INSTALL_OFFERED_VIEW);
    const reason = UNITY_NOT_READY_INSTALL_OFFERED_VIEW.disabledReason ?? "";

    expect(hasAriaLabel(html, "No editor connected")).toBe(false);
    const unityButton = findButtonByExactText(html, "Unity");
    expect(unityButton).toBeDefined();
    expect(hasAriaLabel(unityButton ?? "", reason)).toBe(true);
    const transport = getUnityTransportGroup(html) ?? "";
    expect(hasAriaLabel(transport, `Play — ${reason}`)).toBe(true);
    expect(hasAriaLabel(transport, `Pause — ${reason}`)).toBe(true);
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

// QA round 2 (#124): a live computer-use pass hovered a disabled control
// button in the chat header for ~1.8s — the accessible name read correctly
// on focus, but no visible tooltip ever appeared. Root cause: a browser
// skips a natively `disabled` element during hit-testing, so it never
// receives pointer events (mouseenter/mouseover included) — a
// Tooltip/TooltipTrigger wrapped around a `disabled` button can therefore
// never open on hover, for ANY sighted pointer user, not just this one
// instance. The fix swaps every disabled-with-a-tooltip control in this
// file from the native `disabled` attribute to `aria-disabled`, which the
// browser does NOT exempt from hit-testing (and which leaves the control
// keyboard-focusable too — a genuine improvement, not a side effect).
//
// HONEST LIMIT (stated up front, not discovered after the fact): this
// codebase's tests render via `renderToStaticMarkup` — no jsdom, no real
// event dispatch (see `TerminalDockPanel.test.tsx`'s own doc comment).
// These tests can only prove the STRUCTURAL precondition for hover to work
// — the native `disabled` attribute is genuinely gone, `aria-disabled`
// genuinely present — not that hovering actually opens the tooltip, and
// not that a disabled transport button's click guard no-ops on a real click.
// Both remain open until the next live QA pass.
function hasNativeDisabled(buttonHtml: string): boolean {
  return /\sdisabled=""/.test(buttonHtml);
}

function hasAriaDisabledTrue(buttonHtml: string): boolean {
  return /\saria-disabled="true"/.test(buttonHtml);
}

describe("EngineToolbar — disabled-with-tooltip controls stay hoverable/focusable (#124)", () => {
  it("all three Unity controls in the not-ready/no-install state use aria-disabled, never the native attribute", () => {
    const html = renderUnityToolbar(UNITY_NOT_READY_NO_INSTALL_VIEW);
    const reason = UNITY_NOT_READY_NO_INSTALL_VIEW.disabledReason ?? "";
    const unityButton = findButtonByExactText(html, "Unity");
    const transport = getUnityTransportGroup(html) ?? "";
    const playButton = findButtonByAriaLabel(transport, `Play — ${reason}`);
    const pauseButton = findButtonByAriaLabel(transport, `Pause — ${reason}`);

    expect(unityButton).toBeDefined();
    expect(playButton).toBeDefined();
    expect(pauseButton).toBeDefined();
    expect(hasNativeDisabled(unityButton ?? "")).toBe(false);
    expect(hasAriaDisabledTrue(unityButton ?? "")).toBe(true);
    expect(hasNativeDisabled(playButton ?? "")).toBe(false);
    expect(hasAriaDisabledTrue(playButton ?? "")).toBe(true);
    expect(hasNativeDisabled(pauseButton ?? "")).toBe(false);
    expect(hasAriaDisabledTrue(pauseButton ?? "")).toBe(true);
  });

  it("the 'Bring Unity to the front' button uses aria-disabled, never the native attribute", () => {
    const html = renderUnityToolbar(UNITY_READY_VIEW);
    const unityButton = findButtonByExactText(html, "Unity");

    expect(unityButton).toBeDefined();
    expect(hasNativeDisabled(unityButton ?? "")).toBe(false);
    expect(hasAriaDisabledTrue(unityButton ?? "")).toBe(true);
  });

  it("Pause uses aria-disabled (never native) while stopped, and carries no disabled marker while playing", () => {
    const stoppedHtml = renderUnityToolbar({ ...UNITY_READY_VIEW, playState: "stopped" });
    const pauseButtonStopped = findButtonByAriaLabel(stoppedHtml, "Nothing is playing to pause.");
    expect(pauseButtonStopped).toBeDefined();
    expect(hasNativeDisabled(pauseButtonStopped ?? "")).toBe(false);
    expect(hasAriaDisabledTrue(pauseButtonStopped ?? "")).toBe(true);

    const playingHtml = renderUnityToolbar({ ...UNITY_READY_VIEW, playState: "playing" });
    const pauseButtonPlaying = findButtonByAriaLabel(playingHtml, "Pause");
    expect(pauseButtonPlaying).toBeDefined();
    expect(hasNativeDisabled(pauseButtonPlaying ?? "")).toBe(false);
    expect(hasAriaDisabledTrue(pauseButtonPlaying ?? "")).toBe(false);
  });

  it("the disabled three.js Play button uses aria-disabled, never the native attribute, and stays wrapped in its Tooltip", () => {
    const reason = "Preview only runs in the DevGame desktop app, not a browser tab.";
    const html = renderToolbar({ threeJsUnavailableReason: reason });
    const playButton = findButtonByExactText(html, "Play");

    expect(playButton).toBeDefined();
    expect(hasNativeDisabled(playButton ?? "")).toBe(false);
    expect(hasAriaDisabledTrue(playButton ?? "")).toBe(true);
    // The tooltip body is still present — the fix touches the attribute
    // mechanism, not whether the Tooltip wrapper is there at all.
    expect(html).toMatch(new RegExp(escapeRegExp(reason)));
  });

  it("the enabled three.js Play button carries no aria-disabled marker at all", () => {
    const html = renderToolbar({ onPlayThreeJs: () => {} });
    const playButton = findButtonByExactText(html, "Play");

    expect(playButton).toBeDefined();
    expect(hasAriaDisabledTrue(playButton ?? "")).toBe(false);
  });
});
