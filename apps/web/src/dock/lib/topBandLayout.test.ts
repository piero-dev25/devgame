// docs/specs/unified-topband.md, Section A: the ONE pure helper the band
// design hangs off of — computes, from `api.groups` + each group's
// `group.api.boundingBox` (dockview-root-relative, per
// DockviewGroupPanelApiImpl.boundingBox in the installed dockview-core@7.0.4
// dist/esm), (1) which groups sit in the top row (`boundingBox.top === 0`)
// and (2) which one of those owns the (0,0) corner — the target
// DockviewLayout.tsx stamps `data-dv-topband` on and applies the corner
// padding to.
//
// RED-FIRST METHOD (workspaceChromeInset.test.ts's own precedent): this file
// was written and run against a repo with no `topBandLayout.ts` module at
// all — `pnpm test topBandLayout` fails at import resolution ("Cannot find
// module './topBandLayout'"), proving these assertions exercise real,
// not-yet-built code rather than a tautology. `topBandLayout.ts` is written
// immediately afterward to turn this green, with no other change to make it
// pass.
import { describe, expect, it } from "vite-plus/test";

import { computeTopBandLayout, type TopBandGroupInput } from "./topBandLayout";

const CORNER_WIDTH = 220;

function group(id: string, boundingBox: TopBandGroupInput["boundingBox"]): TopBandGroupInput {
  return { id, boundingBox };
}

describe("computeTopBandLayout — owns-(0,0)", () => {
  it("identifies every top-row group (boundingBox.top === 0) and picks the one at (0,0) as the corner owner", () => {
    const result = computeTopBandLayout(
      [
        // Sidebar: top-row, owns (0,0).
        group("sidebar", { left: 0, top: 0, width: 256, height: 600 }),
        // Chat: top-row, to the right of Sidebar — NOT the corner owner.
        group("chat", { left: 256, top: 0, width: 640, height: 600 }),
        // A bottom-docked group (e.g. a split terminal pane): not top-row.
        group("terminal-bottom", { left: 256, top: 400, width: 640, height: 200 }),
      ],
      CORNER_WIDTH,
    );

    expect([...result.topRowGroupIds].sort()).toEqual(["chat", "sidebar"]);
    expect(result.cornerOwnerGroupId).toBe("sidebar");
    // Sidebar (256px) is wider than the corner (220px) — padding is the
    // full corner width, uncapped.
    expect(result.cornerPaddingPx).toBe(CORNER_WIDTH);
  });
});

describe("computeTopBandLayout — hidden first group (boundingBox undefined)", () => {
  it("skips a group with no boundingBox (popout/unsized — DockviewGroupPanelApiImpl.boundingBox returns undefined for those) without crashing, and still finds the real corner owner", () => {
    const result = computeTopBandLayout(
      [
        // Listed FIRST but popped out — no boundingBox at all.
        group("popped-out", undefined),
        group("sidebar", { left: 0, top: 0, width: 256, height: 600 }),
      ],
      CORNER_WIDTH,
    );

    expect(result.topRowGroupIds.has("popped-out")).toBe(false);
    expect(result.topRowGroupIds.has("sidebar")).toBe(true);
    expect(result.cornerOwnerGroupId).toBe("sidebar");
  });
});

describe("computeTopBandLayout — narrower-than-corner cap", () => {
  it("caps the corner padding at the (0,0) group's own width so the tab strip never renders fully off-canvas", () => {
    const result = computeTopBandLayout(
      [
        // Sidebar sashed narrower than the corner cell (220px).
        group("sidebar", { left: 0, top: 0, width: 140, height: 600 }),
        group("chat", { left: 140, top: 0, width: 640, height: 600 }),
      ],
      CORNER_WIDTH,
    );

    expect(result.cornerOwnerGroupId).toBe("sidebar");
    expect(result.cornerPaddingPx).toBe(140);
  });
});

describe("computeTopBandLayout — empty groups", () => {
  it("returns an empty top-row set, no corner owner, and zero padding when there are no groups", () => {
    const result = computeTopBandLayout([], CORNER_WIDTH);

    expect(result.topRowGroupIds.size).toBe(0);
    expect(result.cornerOwnerGroupId).toBeNull();
    expect(result.cornerPaddingPx).toBe(0);
  });
});
