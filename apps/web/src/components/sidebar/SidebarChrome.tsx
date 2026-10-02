import { ArrowLeftIcon, ChartNoAxesColumnIcon, SettingsIcon } from "lucide-react";
import type { ReactNode } from "react";
import { memo, useCallback } from "react";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";

import { APP_BASE_NAME } from "../../branding";
import { useEnvironmentIdentificationMode } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { useEnvironments } from "../../state/environments";
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
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import { DevGameMark } from "./DevGameMark";
import { isSidebarUtilityPage, useNavigateToMainApp } from "./mainAppLocation";
import { SidebarThreadUndoNotice } from "./SidebarThreadUndoNotice";
import { SidebarProviderUpdatePill } from "./SidebarProviderUpdatePill";
import { SidebarUpdateArchitectureWarning, SidebarUpdatePill } from "./SidebarUpdatePill";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";

/**
 * dock-chrome-strip.md, Section A/C: when `SidebarChromeHeader` is hoisted
 * into `_chat.tsx`'s chrome corner (as opposed to `AppSidebarLayout`'s call
 * site, where `sidebarToggle` stays `undefined`), the corner needs an
 * ALWAYS-visible sidebar toggle, not the mobile-only one. Reuses the SAME
 * trigger slot rather than adding a second button: when `sidebarToggle` is
 * provided, the trigger drops `md:hidden` and is wired to `onToggle`/
 * `pressed` (the dock-side sidebar GROUP hide/show; critique m13 forbids
 * wiring this to `SidebarProvider`'s own open state, which the trigger still
 * toggles when `sidebarToggle` is omitted).
 *
 * Exported on its own because `SidebarChromeHeader` renders `SidebarBrand`'s
 * router `<Link>`, which throws under the `renderToStaticMarkup` test harness
 * without a `RouterProvider`; this component only needs a `SidebarProvider`.
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
      // Over the stage artwork: the media viewer's control-on-imagery treatment.
      variant={backdropVariant ? "media-navigation" : "ghost"}
      className={cn("relative top-auto z-10 translate-y-0", !sidebarToggle && "md:hidden")}
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
  /** Set by `_chat.tsx`'s chrome corner; see `SidebarChromeToggle`. */
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

  // docs/specs/unified-topband.md, Section B: in the chrome corner
  // (`hasToggle`) the toggle is a VISIBLE flex sibling right before the brand,
  // so the container itself clears the traffic lights
  // (`pl-[var(--workspace-controls-left)]`) and spaces its children with
  // `gap-2`; the brand's own titlebar margin would double-count the toggle's
  // width there. The corner is content-sized (`WorkspaceChromeCornerShell`
  // measures it), so `min-w-[14rem]` is a static width floor that keeps the
  // corner geometry stable, and the brand and environment pill are shown
  // unconditionally: a width-driven reveal could never trigger in a
  // container whose width comes from what it reveals. `AppSidebarLayout`'s
  // call site is upstream's layout, unchanged.
  const hasToggle = sidebarToggle !== undefined;

  return (
    // The titlebar row, not a padded SidebarHeader: it aligns to the window controls.
    <div
      className={cn(
        "@container/sidebar-header relative flex h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center gap-2",
        hasToggle ? "min-w-[14rem] pr-5 pl-[var(--workspace-controls-left)]" : "px-3 md:px-0",
        isElectron && "drag-region",
      )}
    >
      {backdropVariant ? <SidebarStageBackdrop variant={backdropVariant} /> : null}
      <SidebarChromeToggle
        backdropVariant={backdropVariant}
        {...(sidebarToggle ? { sidebarToggle } : {})}
      />
      <SidebarBrand inCorner={hasToggle} onBackdrop={backdropVariant !== null} />
      {pillLabel ? (
        <Badge
          className={cn(
            "relative z-10 ml-1",
            hasToggle ? "inline-flex" : "hidden @[15rem]/sidebar-header:inline-flex",
          )}
          data-environment-identification="pill"
          size="sm"
          variant="secondary"
        >
          {pillLabel}
        </Badge>
      ) : null}
    </div>
  );
});

function SidebarBrand({ onBackdrop, inCorner }: { onBackdrop: boolean; inCorner: boolean }) {
  return (
    <Link
      aria-label="Go to threads"
      className={cn(
        "relative z-10 h-7 w-fit min-w-0 shrink-0 items-center overflow-hidden rounded-md outline-hidden ring-ring focus-visible:ring-2",
        // The corner spaces the brand itself (see SidebarChromeHeader) and
        // always shows it; elsewhere it keeps upstream's titlebar margin and
        // desktop-only reveal.
        inCorner ? "flex" : "ml-[var(--workspace-titlebar-content-left)] hidden md:flex",
        onBackdrop ? "text-white" : "text-foreground",
      )}
      to="/"
    >
      {/* Center the visible capitals, without the font's ascender/descender space. */}
      <span className="inline-flex min-w-0 items-baseline gap-1 text-sm font-medium tracking-tight">
        <DevGameMark className="h-[1cap] w-auto shrink-0" />
        <span
          className={cn(
            "truncate [text-box:trim-both_cap_alphabetic]",
            onBackdrop ? "text-white/90" : "text-foreground",
          )}
        >
          {APP_BASE_NAME}
        </span>
      </span>
    </Link>
  );
}

function SidebarUtilityItem({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <SidebarMenuItem className="shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton aria-label={label} onClick={onClick} size="icon">
              {icon}
            </SidebarMenuButton>
          }
        />
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}

export const SidebarUtilityMenu = memo(function SidebarUtilityMenu() {
  const navigate = useNavigate();
  const navigateToMainApp = useNavigateToMainApp();
  const { isMobile, setOpenMobile } = useSidebar();
  const isOnUtilityPage = useLocation({
    select: (location) => isSidebarUtilityPage(location.pathname),
  });
  const { environments } = useEnvironments();
  // The page reads every connected server, so one of them offering pull requests is enough for
  // the link to lead somewhere.
  const pullRequestsSupported = environments.some(
    (environment) => environment.serverConfig?.environment.capabilities.pullRequests === true,
  );
  const closeMobileSidebar = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
  }, [isMobile, setOpenMobile]);
  const handlePullRequestsClick = useCallback(() => {
    closeMobileSidebar();
    void navigate({
      to: "/pull-requests",
      search: readPullRequestListPreferences(),
    });
  }, [closeMobileSidebar, navigate]);
  const handleSettingsClick = useCallback(() => {
    closeMobileSidebar();
    void navigate({ to: "/settings" });
  }, [closeMobileSidebar, navigate]);

  const handleUsageClick = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
    void navigate({ to: "/usage" });
  }, [isMobile, navigate, setOpenMobile]);

  const handleBackClick = useCallback(() => {
    closeMobileSidebar();
    void navigateToMainApp();
  }, [closeMobileSidebar, navigateToMainApp]);

  return (
    <SidebarMenu className="flex-row items-center">
      {isOnUtilityPage ? (
        <SidebarMenuItem className="min-w-0 flex-1">
          <SidebarMenuButton onClick={handleBackClick}>
            <ArrowLeftIcon />
            <span>Back</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ) : (
        <>
          <SidebarUtilityItem
            icon={<SettingsIcon />}
            label="Settings"
            onClick={handleSettingsClick}
          />
          {pullRequestsSupported ? (
            <SidebarUtilityItem
              icon={<PullRequestGlyph.pullRequest />}
              label="Pull Requests"
              onClick={handlePullRequestsClick}
            />
          ) : null}
          <SidebarUtilityItem
            icon={<ChartNoAxesColumnIcon />}
            label="Usage"
            onClick={handleUsageClick}
          />
        </>
      )}
      <SidebarUpdatePill />
    </SidebarMenu>
  );
});

export const SidebarChromeFooter = memo(function SidebarChromeFooter() {
  return (
    <SidebarFooter>
      <SidebarThreadUndoNotice />
      <SidebarProviderUpdatePill />
      <SidebarUpdateArchitectureWarning />
      <SidebarUtilityMenu />
    </SidebarFooter>
  );
});
