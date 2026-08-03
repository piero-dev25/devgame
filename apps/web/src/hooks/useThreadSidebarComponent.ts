import type { ComponentType } from "react";

import ThreadSidebar from "../components/Sidebar";
import ThreadSidebarV2 from "../components/SidebarV2";
import { useSidebarV2Enabled } from "./useSettings";

/**
 * Resolves WHICH of T3's two live sidebar content components to render —
 * `Sidebar.tsx` (v1) or `SidebarV2.tsx` — from the same `useSidebarV2Enabled()`
 * flag `AppSidebarLayout` already reads.
 *
 * Extracted here (spec-dock-step-2.md, owner correction) so `AppSidebarLayout`
 * and the dock's `SidebarPanel` share ONE component-selection decision
 * instead of each hardcoding/duplicating the same ternary. The owner's
 * ruling: both sidebars are live and stay live — v1 is the production
 * default (and is additionally forced on `/settings*`, independent of the
 * flag, because it carries the settings nav), v2 is T3's in-progress
 * redesign, on by default for dev/nightly build stages and user-overridable
 * in Settings → Beta. Neither gets deleted or hardcoded away; the dock hosts
 * whichever one the flag currently selects, same as `AppSidebarLayout`
 * already does everywhere except `/settings*`.
 *
 * `forceV1` is a parameter, not baked into this hook's own resolution,
 * because it is `AppSidebarLayout`'s own route-specific override (settings
 * nav lives only in v1), not part of what the flag itself means. The dock's
 * `SidebarPanel` never passes it — the dock never mounts on `/settings*`,
 * `AppSidebarLayout` still owns that route exclusively.
 */
export function useThreadSidebarComponent(options?: { forceV1?: boolean }): ComponentType {
  const sidebarV2Enabled = useSidebarV2Enabled();
  const useV2 = sidebarV2Enabled && !options?.forceV1;
  return useV2 ? ThreadSidebarV2 : ThreadSidebar;
}
