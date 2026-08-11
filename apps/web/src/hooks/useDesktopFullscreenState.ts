import { useEffect, useState } from "react";

/**
 * dock-chrome-strip.md, Section A: extracted from `AppSidebarLayout.tsx`'s
 * own inline `isWindowFullscreen` state + effect so `_chat.tsx`'s hoisted
 * chrome strip can own the SAME live subscription
 * (`desktopBridge.onWindowFullscreenStateChange`, preload.ts:120 — a
 * global, per-window bridge, not scoped to any one component) instead of
 * duplicating it. `AppSidebarLayout` now calls this hook too — no behavior
 * change there.
 *
 * UNTESTABLE in this repo's harness: tests render via `renderToStaticMarkup`
 * (no jsdom/testing-library), so `useEffect` never runs and this hook's
 * subscription can't be exercised. Acceptance check 5 (macOS fullscreen:
 * traffic lights auto-hide and the strip's 90px inset drops) is an
 * owner-eye item for exactly this reason, stated plainly rather than
 * papered over with a fake test.
 */
export function useDesktopFullscreenState(isMacDesktop: boolean): boolean {
  const [isWindowFullscreen, setIsWindowFullscreen] = useState(() => {
    const getWindowFullscreenState = window.desktopBridge?.getWindowFullscreenState;
    return isMacDesktop && typeof getWindowFullscreenState === "function"
      ? getWindowFullscreenState()
      : false;
  });

  useEffect(() => {
    if (!isMacDesktop) return;
    const bridge = window.desktopBridge;
    if (!bridge) return;
    const { getWindowFullscreenState, onWindowFullscreenStateChange } = bridge;
    if (
      typeof getWindowFullscreenState !== "function" ||
      typeof onWindowFullscreenStateChange !== "function"
    ) {
      return;
    }

    const unsubscribe = onWindowFullscreenStateChange(setIsWindowFullscreen);
    setIsWindowFullscreen(getWindowFullscreenState());
    return unsubscribe;
  }, [isMacDesktop]);

  return isWindowFullscreen;
}
