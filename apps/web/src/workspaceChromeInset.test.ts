// dock-chrome-strip.md, Section A: `resolveWorkspaceChromeInsetStyle` is a
// PURE extraction of `AppSidebarLayout.tsx`'s inline mac-inset mapping
// (its own `sidebarProviderStyle` computation, pre-extraction:
//   {
//     "--sidebar-width": `${sidebarWidth}px`,
//     ...(isMacosDesktop && !isWindowFullscreen
//       ? { "--workspace-controls-left": MACOS_TRAFFIC_LIGHTS_LEFT_INSET }
//       : {}),
//   }
// — minus the unrelated `--sidebar-width` entry, which AppSidebarLayout
// still adds itself). These four cases are asserted BYTE-EQUAL to that
// original mapping's four branches (mac/non-mac x fullscreen/not).
//
// RED-FIRST METHOD: this test file was written and run against a repo with
// no `workspaceChromeInset.ts` module at all — `pnpm test workspaceChromeInset`
// failed at import resolution ("Cannot find module './workspaceChromeInset'"),
// proving the test exercises real, not-yet-built code rather than asserting
// a tautology. `workspaceChromeInset.ts` was written immediately afterward
// to turn this green, with no other change to make it pass.
import { describe, expect, it } from "vite-plus/test";

import {
  MACOS_TRAFFIC_LIGHTS_LEFT_INSET,
  resolveWorkspaceChromeInsetStyle,
} from "./workspaceChromeInset";

describe("resolveWorkspaceChromeInsetStyle", () => {
  it("mac desktop, not fullscreen: reserves the traffic-lights inset — byte-equal to AppSidebarLayout's original mapping", () => {
    expect(resolveWorkspaceChromeInsetStyle({ isMacDesktop: true, isFullscreen: false })).toEqual({
      "--workspace-controls-left": MACOS_TRAFFIC_LIGHTS_LEFT_INSET,
    });
  });

  it("mac desktop, fullscreen: no inset — the traffic lights themselves are hidden by macOS in fullscreen", () => {
    expect(resolveWorkspaceChromeInsetStyle({ isMacDesktop: true, isFullscreen: true })).toEqual(
      {},
    );
  });

  it("non-mac desktop (e.g. Windows/Linux Electron, or web): no inset regardless of fullscreen — the 90px reservation is mac-only (critique m11)", () => {
    expect(resolveWorkspaceChromeInsetStyle({ isMacDesktop: false, isFullscreen: false })).toEqual(
      {},
    );
    expect(resolveWorkspaceChromeInsetStyle({ isMacDesktop: false, isFullscreen: true })).toEqual(
      {},
    );
  });

  it("MACOS_TRAFFIC_LIGHTS_LEFT_INSET is exactly AppSidebarLayout's original literal value", () => {
    expect(MACOS_TRAFFIC_LIGHTS_LEFT_INSET).toBe("90px");
  });
});
