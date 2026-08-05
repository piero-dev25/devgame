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

// Plain substring match on the literal attribute — none of these labels
// contain a double quote, so React's static attribute encoding never
// mangles them, and this sidesteps regex-escaping the reason string.
function hasAriaLabel(html: string, label: string): boolean {
  return html.includes(`aria-label="${label}"`);
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
