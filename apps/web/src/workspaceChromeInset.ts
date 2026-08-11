import type { CSSProperties } from "react";

/**
 * dock-chrome-strip.md, Section A: pure extraction of `AppSidebarLayout.tsx`'s
 * mac-inset mapping (its own inline `sidebarProviderStyle` computation,
 * pre-extraction), so `_chat.tsx`'s hoisted chrome strip and
 * `AppSidebarLayout` can both compute the same `--workspace-controls-left`
 * override from the same two inputs instead of each carrying its own copy.
 * `AppSidebarLayout` consumes this exact function too — no behavior change
 * there, see its own call site.
 */
export const MACOS_TRAFFIC_LIGHTS_LEFT_INSET = "90px";

/**
 * `isMacDesktop`: Electron + macOS (`isElectron && isMacPlatform(navigator.platform)`
 * at each caller). `isFullscreen`: the live macOS fullscreen state — macOS
 * hides the traffic lights in fullscreen, so the inset must drop with them
 * (critique m8/acceptance check 5). The 90px reservation is mac-only
 * (critique m11): Windows/Linux Electron gets its own inset via
 * `--workspace-native-controls-inset` on the strip itself, not this
 * function — see `_chat.tsx`'s strip for that half.
 */
export function resolveWorkspaceChromeInsetStyle(input: {
  readonly isMacDesktop: boolean;
  readonly isFullscreen: boolean;
}): CSSProperties {
  if (!input.isMacDesktop || input.isFullscreen) {
    return {};
  }
  return { "--workspace-controls-left": MACOS_TRAFFIC_LIGHTS_LEFT_INSET } as CSSProperties;
}
