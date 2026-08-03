import { describe, expect, it } from "vite-plus/test";

import { decideImportedLayoutAction } from "./importDecision";
import type { LayoutFile } from "./types";

const VALID_FILE: LayoutFile = {
  version: 1,
  preset: "test-preset",
  dockview: {
    grid: {
      orientation: "HORIZONTAL",
      width: 100,
      height: 100,
      root: { type: "leaf", size: 100, data: { id: "g", views: [] } },
    },
    panels: {},
  } as unknown as LayoutFile["dockview"],
  floating: [],
  savedAt: "2026-01-01T00:00:00.000Z",
};

describe("decideImportedLayoutAction — fix-round finding #3", () => {
  it("ignores a valid parse result when the component has unmounted", () => {
    // This is the exact race: `file.text()` resolved AFTER the component
    // unmounted. Without the guard, this would return {action: "apply"} and
    // the caller would touch a disposed DockviewApi.
    const decision = decideImportedLayoutAction({
      isMounted: false,
      parseResult: { ok: true, file: VALID_FILE },
    });
    expect(decision).toEqual({ action: "ignore-unmounted" });
  });

  it("ignores an INVALID parse result too when unmounted — unmount wins regardless of content", () => {
    const decision = decideImportedLayoutAction({
      isMounted: false,
      parseResult: { ok: false, reason: "invalid-json", message: "bad json" },
    });
    expect(decision).toEqual({ action: "ignore-unmounted" });
  });

  it("applies a valid parse result while still mounted", () => {
    const decision = decideImportedLayoutAction({
      isMounted: true,
      parseResult: { ok: true, file: VALID_FILE },
    });
    expect(decision).toEqual({ action: "apply", file: VALID_FILE });
  });

  it("surfaces an invalid parse result while mounted", () => {
    const decision = decideImportedLayoutAction({
      isMounted: true,
      parseResult: { ok: false, reason: "invalid-shape", message: "missing dockview key" },
    });
    expect(decision).toEqual({ action: "invalid", message: "missing dockview key" });
  });
});
