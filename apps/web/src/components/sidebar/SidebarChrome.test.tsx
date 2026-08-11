// dock-chrome-strip.md's own test-section budget warning: `SidebarChromeHeader`
// itself cannot be rendered under this repo's renderToStaticMarkup-only
// harness — it unconditionally renders `SidebarBrand`'s router `<Link>`,
// which throws with no `RouterProvider` ancestor (no in-repo router-mock
// precedent; verified empirically: `useLinkProps` throws "useRouter must be
// used inside a <RouterProvider>"). `SidebarChromeToggle` was extracted
// specifically so the strip's NEW behavior (the `sidebarToggle` prop) has a
// real, renderable, presentational surface to test — see its own doc
// comment on `SidebarChrome.tsx`.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SidebarProvider } from "../ui/sidebar";
import { SidebarChromeToggle } from "./SidebarChrome";

function renderToggle(props: Parameters<typeof SidebarChromeToggle>[0]) {
  return renderToStaticMarkup(
    <SidebarProvider>
      <SidebarChromeToggle {...props} />
    </SidebarProvider>,
  );
}

describe("SidebarChromeToggle — default (no sidebarToggle prop, e.g. AppSidebarLayout's settings nav call site)", () => {
  it("keeps the mobile-only md:hidden class — unchanged from before this prop existed", () => {
    const html = renderToggle({ backdropVariant: null });
    expect(html).toContain("md:hidden");
  });

  it("still renders a real toggle button with the accessible sidebar-trigger markers", () => {
    const html = renderToggle({ backdropVariant: null });
    expect(html).toContain('data-slot="sidebar-trigger"');
    expect(html).toContain("Toggle Sidebar");
  });
});

describe("SidebarChromeToggle — sidebarToggle prop provided (dock-chrome-strip.md's strip call site)", () => {
  it("drops md:hidden — the strip needs this ALWAYS visible, not mobile-only", () => {
    const html = renderToggle({
      backdropVariant: null,
      sidebarToggle: { onToggle: () => {}, pressed: true },
    });
    expect(html).not.toContain("md:hidden");
  });

  it("reflects pressed:true as aria-pressed=true", () => {
    const html = renderToggle({
      backdropVariant: null,
      sidebarToggle: { onToggle: () => {}, pressed: true },
    });
    expect(html).toContain('aria-pressed="true"');
  });

  it("reflects pressed:false as aria-pressed=false", () => {
    const html = renderToggle({
      backdropVariant: null,
      sidebarToggle: { onToggle: () => {}, pressed: false },
    });
    expect(html).toContain('aria-pressed="false"');
  });
});

describe("SidebarChromeToggle — backdropVariant styling carries through regardless of sidebarToggle", () => {
  it("applies the on-backdrop hover/focus classes when a backdrop variant is set, with or without sidebarToggle", () => {
    const withoutToggle = renderToggle({ backdropVariant: "nightly" });
    const withToggle = renderToggle({
      backdropVariant: "nightly",
      sidebarToggle: { onToggle: () => {}, pressed: true },
    });
    expect(withoutToggle).toContain("focus-visible:ring-white/90");
    expect(withToggle).toContain("focus-visible:ring-white/90");
  });
});
