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
      onSelectEngine={() => {}}
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
