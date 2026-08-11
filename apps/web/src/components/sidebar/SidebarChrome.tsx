import { SettingsIcon } from "lucide-react";
import { memo, useCallback } from "react";
import { Link, useNavigate } from "@tanstack/react-router";

import { APP_BASE_NAME } from "../../branding";
import { useEnvironmentIdentificationMode } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import {
  resolveEnvironmentIdentificationPillLabel,
  resolveSidebarStageBackdropVariant,
  SidebarStageBackdrop,
  useEnvironmentStageLabel,
  type SidebarStageBackdropVariant,
} from "../SidebarStageBackdrop";
import { Badge } from "../ui/badge";
import {
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "../ui/sidebar";
import { SidebarProviderUpdatePill } from "./SidebarProviderUpdatePill";
import { SidebarUpdatePill } from "./SidebarUpdatePill";

/**
 * dock-chrome-strip.md, Section A/C: when `SidebarChromeHeader` is hoisted
 * into `_chat.tsx`'s route-level chrome strip (as opposed to its other,
 * unchanged call site — `AppSidebarLayout.tsx:211`'s settings nav — where
 * `sidebarToggle` stays `undefined`), the strip needs an ALWAYS-visible
 * sidebar toggle, not the mobile-only one below. Reuses the SAME trigger
 * slot rather than adding a second button: when `sidebarToggle` is
 * provided, this replaces the trigger's default `md:hidden`/`useSidebar()`-
 * driven behaviour with an always-visible one wired to `onToggle`/`pressed`
 * instead (the dock-side sidebar GROUP hide/show — critique m13 forbids
 * wiring this to `SidebarProvider`'s own open state, which this trigger
 * still does when `sidebarToggle` is omitted).
 *
 * Pulled out into its own named, EXPORTED component — same reasoning as
 * `DockviewLayout.tsx`'s `DockControlsCluster`: `SidebarChromeHeader` also
 * renders `SidebarBrand`'s router `<Link>`, which throws under this repo's
 * `renderToStaticMarkup`-only test harness with no `RouterProvider`
 * ancestor (no in-repo router-mock precedent — verified: `useLinkProps`
 * throws "useRouter must be used inside a <RouterProvider>"). This
 * component needs only a `SidebarProvider` ancestor (via `SidebarTrigger`'s
 * `useSidebar()`/`useSidebarVisibility()`), so it's the presentational
 * surface `SidebarChromeHeader.test.tsx` actually renders.
 */
export function SidebarChromeToggle({
  backdropVariant,
  sidebarToggle,
}: {
  backdropVariant: SidebarStageBackdropVariant | null;
  sidebarToggle?: { onToggle: () => void; pressed: boolean };
}) {
  return (
    <SidebarTrigger
      className={cn(
        "relative z-10",
        !sidebarToggle && "md:hidden",
        backdropVariant &&
          "[:hover,[data-pressed]]:bg-white/15 focus-visible:ring-white/90 focus-visible:ring-offset-blue-700 [&_svg]:stroke-white/90! [&_svg]:opacity-100! [&_svg]:hover:stroke-white!",
      )}
      {...(sidebarToggle
        ? { onToggle: sidebarToggle.onToggle, pressed: sidebarToggle.pressed }
        : {})}
    />
  );
}

export const SidebarChromeHeader = memo(function SidebarChromeHeader({
  isElectron,
  sidebarToggle,
}: {
  isElectron: boolean;
  sidebarToggle?: { onToggle: () => void; pressed: boolean };
}) {
  const stageLabel = useEnvironmentStageLabel();
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const backdropVariant = resolveSidebarStageBackdropVariant(
    stageLabel,
    environmentIdentificationMode === "artwork",
  );
  const pillLabel =
    environmentIdentificationMode === "pill"
      ? resolveEnvironmentIdentificationPillLabel(stageLabel)
      : null;

  // docs/specs/unified-topband.md, Section B, fix round 2 (owner mock, real
  // defect): `--workspace-titlebar-content-left`'s formula
  // (`--workspace-controls-left` + one control-size + one gap, index.css)
  // was NEVER designed for a toggle rendered as a normal flex sibling
  // immediately before brand — verified against its OTHER two call sites:
  // `AppSidebarLayout.tsx`'s own sidebar control is a SEPARATE `fixed`-
  // positioned element floating independently at `--workspace-controls-left`
  // (AppSidebarLayout.tsx:95), and the settings-nav usage of THIS component
  // passes no `sidebarToggle` at all, so `SidebarChromeToggle` renders
  // `md:hidden` on desktop — brand is the only visible content either way.
  // The corner/strip usage (`sidebarToggle` provided) is the ONE case where
  // a toggle is BOTH visible AND a normal flex sibling before brand — the
  // formula's baked-in "one control's width" gets added ON TOP of the
  // toggle's own real layout width, double-counting it. In a full-width
  // strip this went unnoticed (plenty of slack); in the ~220px corner it
  // consumed nearly the whole cell, leaving brand almost no room and no
  // trailing gap before the dock's first tab.
  //
  // Fix, gated on `hasToggle` (the same signal that already distinguishes
  // the corner/strip call site from settings-nav) so the settings-route
  // usage is UNCHANGED: the container itself gets `pl-[var(--workspace-
  // controls-left)]` (correctly clears the lights — the toggle used to
  // start at the header's flat `px-3`, UNDER the traffic lights on mac) and
  // a flex `gap` for uniform, non-double-counted spacing between toggle,
  // brand, and (if present) the pill; brand's own baked-in margin is
  // disabled via `applyContentInset={false}` since the container's padding
  // already does that job.
  //
  // FIX ROUND 3 (real regression, round-14 owner review — root cause found
  // by reading index.css, not guessed): this element establishes the named
  // CSS container `@container/sidebar-header` (the class right below).
  // `.sidebar-brand` (index.css) defaults to `display: none` and only
  // becomes `display: flex` inside `@container sidebar-header (min-width:
  // 13.5rem)` — a rule that predates this file's corner work entirely. In
  // the settings-nav usage this container's width comes from
  // `AppSidebarLayout`'s fixed `<Sidebar>` (`--sidebar-width`, 256px, an
  // INDEPENDENT source unrelated to this header's own content), so the
  // query was always satisfied there. `_chat.tsx`'s
  // `WorkspaceChromeCornerShell` fix round 2 made the corner CONTENT-SIZED
  // (`w-fit`, sized to what's INSIDE `SidebarHeader`) — which is brand
  // ITSELF, creating a genuine circular dependency: brand needs the
  // container to already be >= 216px to become visible, but with brand
  // hidden it contributes ZERO width, so the container never reaches
  // 216px, so brand stays hidden — a stable, self-perpetuating collapse
  // (empirically confirmed: round 13, BEFORE the w-fit change, still had
  // the OLD fixed-220px shell and brand rendered fine — "8 link
  // Description: Go to threads" in that round's own evidence; round 14,
  // AFTER the w-fit change, brand is gone). `min-w-[14rem]` (224px) below
  // is a STATIC floor, independent of brand's own content, that keeps the
  // corner's measured width consistent cross-platform.
  //
  // FIX ROUND 4 (round-15 live CDP evidence, 2026-08-11): the floor alone
  // did NOT satisfy the container query, because container size queries
  // measure the CONTENT box — and this branch's own padding (90px lights
  // inset + 20px trailing) leaves 224 − 110 = 114px of content box against
  // the 216px threshold. Live-measured on the packaged build: header used
  // width 224px, brand computed display still "none"; injecting a
  // display override painted the brand at exactly x=126 (inset 90 +
  // toggle 28 + gap 8) — the intended composition. A content-sized corner
  // can NEVER honestly satisfy a 216px CONTENT-box threshold that was
  // designed for the fixed-width sidebar context, so the corner stops
  // fighting the query: `forceVisible` below applies `flex!` directly on
  // the brand (important-suffixed — the `.sidebar-brand` base rule is
  // unlayered author CSS, which beats layered utilities UNLESS the
  // utility is !important). The settings-nav usage keeps the container
  // query untouched (its 256px fixed sidebar satisfies it for real).
  const hasToggle = sidebarToggle !== undefined;

  return (
    <SidebarHeader
      className={cn(
        "@container/sidebar-header relative h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center py-0",
        hasToggle ? "min-w-[14rem] gap-2 pr-5 pl-[var(--workspace-controls-left)]" : "px-3 md:px-0",
        isElectron && "drag-region",
      )}
    >
      {backdropVariant ? <SidebarStageBackdrop variant={backdropVariant} /> : null}
      <SidebarChromeToggle
        backdropVariant={backdropVariant}
        {...(sidebarToggle ? { sidebarToggle } : {})}
      />
      <SidebarBrand
        applyContentInset={!hasToggle}
        forceVisible={hasToggle}
        onBackdrop={backdropVariant !== null}
      />
      {pillLabel ? (
        <Badge
          className="relative z-10 ml-1 rounded-full px-1.5 text-muted-foreground"
          data-environment-identification="pill"
          size="sm"
          variant="secondary"
        >
          {pillLabel}
        </Badge>
      ) : null}
    </SidebarHeader>
  );
});

function SidebarBrand({
  onBackdrop,
  applyContentInset = true,
  forceVisible = false,
}: {
  onBackdrop: boolean;
  /**
   * Fix round 4 (round-15 live CDP evidence — see `SidebarChromeHeader`'s
   * own comment for the measurements): `.sidebar-brand` defaults
   * `display: none` behind a `@container sidebar-header (min-width:
   * 13.5rem)` query that measures the container's CONTENT box — which the
   * corner's own padding (lights inset + trailing gap) makes structurally
   * unsatisfiable there. `true` applies `flex!` directly: important-
   * suffixed because the base `.sidebar-brand` rule is unlayered author
   * CSS, which beats layered Tailwind utilities unless the utility is
   * `!important`. Defaults `false` so the settings-nav usage keeps the
   * container query it genuinely satisfies (256px fixed sidebar).
   */
  forceVisible?: boolean;
  /**
   * docs/specs/unified-topband.md, Section B, fix round 2: the built-in
   * `ml-[var(--workspace-titlebar-content-left)]` margin assumes brand is
   * the only visible content at this level — true for the settings-nav
   * usage (toggle hidden via `md:hidden` on desktop) — OR that a toggle
   * exists but is positioned SEPARATELY (`AppSidebarLayout.tsx`'s own
   * `fixed`-positioned control). Neither holds for `SidebarChromeHeader`'s
   * corner/strip usage, where the toggle is a normal, VISIBLE flex sibling
   * immediately before brand: the margin's baked-in "one control's width"
   * budget stacks ON TOP of the toggle's own real layout width, double-
   * counting it. `false` there — `SidebarChromeHeader` supplies the correct
   * spacing itself (container `pl-[var(--workspace-controls-left)]` +
   * `gap-2`) instead. Defaults `true` so every other existing caller is
   * unchanged.
   */
  applyContentInset?: boolean;
}) {
  return (
    <Link
      aria-label="Go to threads"
      className={cn(
        "sidebar-brand relative z-10 h-7 w-fit min-w-0 shrink-0 items-center gap-1 overflow-hidden rounded-md outline-hidden ring-ring focus-visible:ring-2",
        forceVisible && "flex!",
        applyContentInset && "ml-[var(--workspace-titlebar-content-left)]",
        onBackdrop ? "text-white" : "text-foreground",
      )}
      to="/"
    >
      <DevGameMark />
      <span
        className={cn(
          "truncate text-sm font-medium tracking-tight",
          onBackdrop ? "text-white/90" : "text-foreground",
        )}
      >
        {APP_BASE_NAME}
      </span>
    </Link>
  );
}

/**
 * The app mark: the `>` of a shell prompt and the play triangle of a game in
 * one glyph. Unlike the wordmark it replaced, this carries no letterforms, so
 * the product name beside it comes from branding rather than being drawn in.
 *
 * The viewBox is cropped to the chevron's stroked bounds (half the 118 stroke
 * width bleeds past the path on every side) so the glyph optically matches the
 * cap height of the name next to it instead of floating in its own padding.
 */
function DevGameMark() {
  return (
    <svg
      aria-hidden="true"
      className="h-3 w-auto shrink-0"
      viewBox="313 227 400 570"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M 372 286 L 654 512 L 372 738"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="118"
      />
    </svg>
  );
}

export const SidebarChromeFooter = memo(function SidebarChromeFooter() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const handleSettingsClick = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
    void navigate({ to: "/settings" });
  }, [isMobile, navigate, setOpenMobile]);

  return (
    <SidebarFooter className="p-[var(--sidebar-content-inset)]">
      <SidebarProviderUpdatePill />
      <SidebarUpdatePill />
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton onClick={handleSettingsClick}>
            <SettingsIcon />
            <span>Settings</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarFooter>
  );
});
