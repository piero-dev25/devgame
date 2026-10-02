import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { DiffPanelShell } from "./DiffPanelShell";

vi.mock("~/env", () => ({ isElectron: true }));

describe("DiffPanelShell", () => {
  // dock-chrome-strip.md, Section D: the hoisted chrome strip owns window
  // dragging, so a panel header inside the dock must not claim a drag region
  // (a drag region swallows clicks on the header's own controls).
  it.each(["inline", "sidebar"] as const)(
    "renders the %s desktop header row without a window drag region",
    (mode) => {
      const markup = renderToStaticMarkup(
        <DiffPanelShell mode={mode} header={<span>Diff</span>}>
          <div />
        </DiffPanelShell>,
      );

      expect(markup).toContain("h-[var(--workspace-topbar-height)]");
      expect(markup).not.toContain("drag-region");
    },
  );
});
