import type { ComponentType } from "react";

import LegacyThreadSidebar from "../components/LegacySidebar";
import ThreadSidebar from "../components/Sidebar";
import { useLegacySidebarEnabled } from "./useSettings";

/**
 * Resolves WHICH of T3's two live sidebar content components to render —
 * `Sidebar.tsx` (the default; upstream #5672 promoted the v2 redesign to
 * this name) or `LegacySidebar.tsx` (the pre-redesign sidebar, opt-in via
 * Settings → General → Legacy features) — from the same
 * `useLegacySidebarEnabled()` flag `AppSidebarLayout` reads.
 *
 * Extracted here (spec-dock-step-2.md, owner correction) so `AppSidebarLayout`
 * and the dock's `SidebarPanel` share ONE component-selection decision
 * instead of each hardcoding/duplicating the same ternary. The owner's
 * ruling: both sidebars are live and stay live — the dock hosts whichever
 * one the flag currently selects, same as `AppSidebarLayout` does.
 *
 * The old `forceV1` option is gone with this upstream merge: `/settings*`
 * renders upstream's dedicated `SettingsSidebarNav` and mounts no thread
 * sidebar at all, so no route needs to override the flag any more.
 */
export function useThreadSidebarComponent(): ComponentType {
  const legacySidebarEnabled = useLegacySidebarEnabled();
  return legacySidebarEnabled ? LegacyThreadSidebar : ThreadSidebar;
}
