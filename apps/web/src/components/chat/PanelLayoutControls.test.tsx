import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { PanelLayoutControls, type PanelLayoutControlsProps } from "./PanelLayoutControls";

// #111: "Toggle terminal drawer" / "Toggle right panel" were hand-written
// aria-label literals, static even when the tooltip explains the control is
// unavailable. Milder than the three.js case (the label stays true, it just
// omits WHY) but the same defect shape — this proves the accessible name
// now carries the same information as the tooltip.

const BASE_PROPS: PanelLayoutControlsProps = {
  terminalAvailable: true,
  terminalOpen: false,
  terminalShortcutLabel: null,
  rightPanelAvailable: true,
  rightPanelOpen: false,
  rightPanelShortcutLabel: null,
  onToggleTerminal: () => {},
  onToggleRightPanel: () => {},
};

function render(overrides: Partial<PanelLayoutControlsProps> = {}) {
  return renderToStaticMarkup(<PanelLayoutControls {...BASE_PROPS} {...overrides} />);
}

// Plain substring match on the literal attribute — avoids regex-escaping
// shortcut punctuation like `+`/`(`/`)`. None of these labels contain a
// double quote, so React's static attribute encoding never mangles them.
function hasAriaLabel(html: string, label: string): boolean {
  return html.includes(`aria-label="${label}"`);
}

describe("PanelLayoutControls accessible names (#111)", () => {
  it("labels the terminal toggle with its shortcut when available", () => {
    const html = render({ terminalShortcutLabel: "Ctrl+`" });

    expect(hasAriaLabel(html, "Toggle terminal drawer (Ctrl+`)")).toBe(true);
  });

  it("reflects unavailability in the terminal toggle's accessible name, not a static literal", () => {
    const html = render({ terminalAvailable: false, terminalShortcutLabel: "Ctrl+`" });

    expect(hasAriaLabel(html, "Toggle terminal drawer")).toBe(false);
    expect(hasAriaLabel(html, "Terminal drawer is unavailable")).toBe(true);
  });

  it("reflects unavailability in the right panel toggle's accessible name, not a static literal", () => {
    const html = render({ rightPanelAvailable: false, rightPanelShortcutLabel: "Ctrl+." });

    expect(hasAriaLabel(html, "Toggle right panel")).toBe(false);
    expect(hasAriaLabel(html, "Right panel is unavailable")).toBe(true);
  });
});
