// docs/specs/unified-topband.md, Section B, test plan ("Render: corner
// renders brand + toggle + `.drag-region`; full-width strip absent
// (anchored)"). `WorkspaceChromeStrip` itself cannot be rendered under this
// repo's `renderToStaticMarkup`-only harness — verified empirically (not
// assumed): its own `useSyncExternalStore` call throws with no
// `getServerSnapshot` argument, and even past that, `SidebarChromeHeader`
// unconditionally renders `SidebarBrand`'s router `<Link>`, which throws
// with no `RouterProvider` ancestor (the same limitation
// `SidebarChromeHeader.test.tsx` already documents for the pre-existing
// strip). `WorkspaceChromeCornerShell` was extracted specifically so the
// corner's OWN new behavior — position/size, replacing the old full-width
// strip's flex-row placement — has a real, renderable surface to test here.
// "Toggle" is proven by composing the ALREADY-renderable `SidebarChromeToggle`
// (SidebarChrome.test.tsx) as the shell's child, mirroring real usage
// (`WorkspaceChromeStrip` nests `SidebarChromeHeader`, which itself nests
// `SidebarChromeToggle`). "Brand" and the literal `.drag-region` class
// (both live inside `SidebarChromeHeader`, not the shell) stay outside what
// this harness can prove — the same accepted, pre-existing limitation
// `SidebarChromeHeader.test.tsx` documents, not a new gap this change
// introduces.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SidebarProvider } from "~/components/ui/sidebar";
import { SidebarChromeToggle } from "~/components/sidebar/SidebarChrome";

import { WorkspaceChromeCornerShell } from "./_chat";

function renderCorner() {
  return renderToStaticMarkup(
    <SidebarProvider>
      <WorkspaceChromeCornerShell>
        <SidebarChromeToggle
          backdropVariant={null}
          sidebarToggle={{ onToggle: () => {}, pressed: true }}
        />
      </WorkspaceChromeCornerShell>
    </SidebarProvider>,
  );
}

describe("WorkspaceChromeCornerShell — the corner cell (replaces the full-width strip, ffafc3728)", () => {
  it("is a fixed-width, absolutely-positioned top-left cell — not a full-width flex row", () => {
    const html = renderCorner();
    expect(html).toContain("absolute");
    expect(html).toContain("top-0");
    expect(html).toContain("left-0");
    expect(html).toContain("w-[var(--workspace-corner-width)]");
  });

  it("overlays above dock content (z-20, above DockControlsCluster's z-10)", () => {
    const html = renderCorner();
    expect(html).toContain("z-20");
  });

  it("locally overrides --workspace-topbar-height to the band's 36px, matching dockviewTheme.css's --dv-tabs-and-actions-container-height", () => {
    const html = renderCorner();
    expect(html).toMatch(/--workspace-topbar-height:\s*36px/);
  });

  it("does NOT carry the old full-width strip's wco right-edge accommodation (wco:pr-[...]) — the corner never reaches the window's right edge", () => {
    const html = renderCorner();
    expect(html).not.toContain("wco:pr-");
  });

  it("renders the sidebar toggle inside the shell, always-visible (no md:hidden — dock-chrome-strip.md's strip call site)", () => {
    const html = renderCorner();
    expect(html).toContain('data-slot="sidebar-trigger"');
    expect(html).not.toContain("md:hidden");
  });
});
