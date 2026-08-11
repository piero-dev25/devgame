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
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

// docs/specs/unified-topband.md, Section B, fix round 3 (round-14
// regression: the corner's SidebarBrand vanished entirely, and nothing
// under this repo's renderToStaticMarkup-only harness could catch it,
// because nothing could render SidebarBrand's router `<Link>` at all —
// SidebarChromeHeader.test.tsx's own precedent comment called this
// permanently unprovable). FIRST `vi.mock` of `@tanstack/react-router` in
// this repo (grep-verified — `/usr/bin/grep -rln "vi\.mock(\"@tanstack"
// apps/web/src` returned nothing before this file) — kept deliberately
// narrow: `importOriginal` preserves every other export (`createFileRoute`,
// `Outlet`, `redirect`, etc.) that `_chat.tsx` and its own transitive
// imports still need; only `Link` is replaced, with a plain `<a>` that
// maps `to` -> `href` and passes everything else through unchanged. This
// unlocks a REAL, if PARTIAL, regression guard — see the "HONEST LIMIT"
// comment on the new describe block below for exactly what it does and
// does not catch.
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({
      to,
      children,
      ...rest
    }: {
      to: string;
      children?: ReactNode;
    } & Record<string, unknown>) => (
      <a href={to} {...rest}>
        {children}
      </a>
    ),
  };
});

import { SidebarProvider } from "~/components/ui/sidebar";
import { SidebarChromeHeader, SidebarChromeToggle } from "~/components/sidebar/SidebarChrome";

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

// docs/specs/unified-topband.md, Section B, fix round 3: exercises the
// REAL corner composition — `SidebarChromeHeader` with `sidebarToggle`
// provided, exactly how `WorkspaceChromeStrip` calls it (that component
// itself still can't render here — its own `useSyncExternalStore` call has
// no `getServerSnapshot` — so this composes `SidebarChromeHeader` directly,
// the same substitution `WorkspaceChromeStrip`'s own doc comment already
// documents).
function renderCornerHeader() {
  return renderToStaticMarkup(
    <SidebarProvider>
      <SidebarChromeHeader isElectron sidebarToggle={{ onToggle: () => {}, pressed: true }} />
    </SidebarProvider>,
  );
}

describe("WorkspaceChromeCornerShell — the corner cell (replaces the full-width strip, ffafc3728)", () => {
  it("is an absolutely-positioned top-left cell — not a full-width flex row", () => {
    const html = renderCorner();
    expect(html).toContain("absolute");
    expect(html).toContain("top-0");
    expect(html).toContain("left-0");
  });

  it("is CONTENT-sized (w-fit), fix round 2 — no fixed --workspace-corner-width reference on the shell itself, which is what this element measures and writes, not reads (NO FEEDBACK LOOP, per the shell's own doc comment)", () => {
    const html = renderCorner();
    expect(html).toContain("w-fit");
    expect(html).not.toContain("w-[var(--workspace-corner-width)]");
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

// docs/specs/unified-topband.md, Section B, fix round 3: round-14 found the
// corner's brand had vanished entirely — root cause (SidebarChrome.tsx's
// own doc comment has the full mechanism): `SidebarHeader` establishes the
// CSS container `@container/sidebar-header`, and `.sidebar-brand`
// (index.css) is `display: none` by DEFAULT, only becoming `display: flex`
// once that container reaches 13.5rem/216px. Fix round 2's `w-fit` shell
// made the corner's width DEPEND ON brand's own content, while brand's
// VISIBILITY depended on the corner already being wide enough — a stable
// collapse with nothing to break it.
//
// HONEST LIMIT on what these two tests actually prove, stated explicitly
// rather than left to be discovered later: `renderToStaticMarkup` produces
// HTML STRINGS ONLY — it never loads a stylesheet, never evaluates a media
// query or a `@container` query, never computes layout. It is therefore
// STRUCTURALLY INCAPABLE of reproducing the actual round-14 bug (a CSS
// `display: none`), red-or-green, no matter what markup assertion is
// written against it. The two tests below are chosen for what each ACTUALLY
// covers:
//   - "SidebarHeader carries a static width floor..." IS red-first against
//     the real bug: it asserts the `min-w-[14rem]` utility SidebarChrome.tsx
//     added is present. Verified red (removed the class, re-ran, got a real
//     failure) before restoring it — see this round's report for the
//     verbatim red output. This is a deliberate, documented PROXY (assert
//     the static CSS floor exists, since the computed visibility it
//     guarantees can't be asserted directly here) — the same class of
//     accepted substitution this repo already uses elsewhere for what
//     `renderToStaticMarkup` structurally cannot reach.
//   - "SidebarBrand is structurally present..." is a REAL, if narrower,
//     regression guard: with `@tanstack/react-router`'s `Link` now mocked,
//     this proves brand is not conditionally EXCLUDED from the JSX tree
//     (e.g. a future `{someCondition && <SidebarBrand ... />}` mistake) —
//     but it was ALREADY passing before either the round-14 bug existed or
//     was fixed, since the bug was never a markup-presence problem. It does
//     NOT, on its own, prove brand is visually rendered.
describe("SidebarChromeHeader (corner usage) — brand presence and the width floor that makes it visible, fix round 3", () => {
  it("SidebarHeader carries a static width floor (min-w-[14rem]) that unconditionally clears the .sidebar-brand container query's 13.5rem/216px threshold — RED-FIRST proven against the real round-14 regression", () => {
    const html = renderCornerHeader();
    expect(html).toContain("min-w-[14rem]");
  });

  it("SidebarBrand is structurally present in the corner's rendered markup (not conditionally excluded) — aria-label, brand text, and the sidebar-brand class all appear", () => {
    const html = renderCornerHeader();
    expect(html).toContain('aria-label="Go to threads"');
    expect(html).toContain("sidebar-brand");
    expect(html).toContain(">DevGame<");
  });
});
