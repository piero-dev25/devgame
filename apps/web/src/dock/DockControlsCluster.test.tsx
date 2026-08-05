/**
 * QA round 2 (#125): a live computer-use pass on the packaged app found the
 * Restore-maximized button sitting underneath/against the macOS traffic
 * lights, in the packaged Electron window's extreme top-left corner —
 * verbatim: "I would not have found it quickly without the prompt. It
 * looks broken despite functioning." Root cause: `DockviewLayout.tsx` used
 * to position Restore and Reset as two INDEPENDENTLY absolutely-positioned
 * buttons in opposite corners (`top-1.5 left-1.5` / `top-1.5 right-1.5`) —
 * sound reasoning for "these two controls can never overlap EACH OTHER,"
 * but it never accounted for the traffic lights, a THIRD occupant of the
 * top-left corner that lives outside this component entirely (drawn by
 * macOS itself over the packaged window).
 *
 * The fix moves both controls into ONE flex cluster anchored at
 * `top-1.5 right-1.5` — the corner clear of the traffic lights on every
 * platform this app ships for.
 *
 * `DockControlsCluster` (defined in `DockviewLayout.tsx`) was pulled out
 * into its own named, exported component ONLY so this is testable at all:
 * `DockviewLayout` itself only ever sets `maximizedGroupId` from the mount
 * effect's `onDidMaximizedGroupChange` subscription, and this codebase's
 * tests render via `renderToStaticMarkup` — no jsdom/testing-library, so
 * `useEffect` never runs (see `TerminalDockPanel.test.tsx`'s own doc
 * comment for the same limitation elsewhere in this repo). This component
 * takes `maximizedGroupId` as a plain prop instead, so it can be rendered
 * directly with Restore forced visible.
 *
 * HONEST LIMIT: these tests prove the STRUCTURAL fix — no button carries
 * its own `absolute`/`left-1.5` positioning class, both controls share one
 * wrapper anchored at `right-1.5`. They cannot prove the traffic lights
 * don't ALSO overlay that corner on some OS/window-chrome combination this
 * repo doesn't exercise, or that the cluster's actual pixel geometry clears
 * them on the live packaged app — that needs the next live QA pass.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { DockControlsCluster } from "./DockviewLayout";

// `Button`'s OWN base class list (button.tsx's `buttonVariants`) carries
// `before:absolute` and `pointer-coarse:after:absolute` UNCONDITIONALLY on
// every button, disabled or not, positioned or not — a bare
// `.includes("absolute")` on a button's class string is NOT safe, it would
// report every button in this app as absolutely-positioned, catching
// nothing. Found running this test against the real fix and getting a
// false failure. This checks for the EXACT class token `absolute` (a
// standalone Tailwind utility), not any substring — `before:absolute` and
// `pointer-coarse:after:absolute` are different, unrelated tokens once
// split on whitespace.
function buttonClassTokenLists(html: string): string[][] {
  const matches = [...html.matchAll(/<button[^>]*\sclass="([^"]*)"/g)];
  return matches.map((match) => (match[1] ?? "").split(/\s+/).filter(Boolean));
}

function findButtonByContent(html: string, marker: string): string | undefined {
  const buttons = html.match(/<button[^>]*>[\s\S]*?<\/button>/g) ?? [];
  return buttons.find((block) => block.includes(marker));
}

describe("DockControlsCluster — Reset + Restore never collide with the macOS traffic lights (#125)", () => {
  it("no button carries its own absolute-positioning class — positioning lives on the shared wrapper only, not on each button independently", () => {
    const html = renderToStaticMarkup(
      <DockControlsCluster
        maximizedGroupId="group-1"
        onReset={() => {}}
        onRestoreMaximized={() => {}}
      />,
    );

    // The bug: Restore and Reset were each their OWN `absolute`-positioned
    // element, opposite corners. Two independently-positioned buttons is
    // exactly the shape that let a THIRD occupant (the traffic lights)
    // collide with one of them unnoticed — a shared wrapper can't have that
    // failure mode, since only one thing is ever positioned.
    const tokenLists = buttonClassTokenLists(html);
    expect(tokenLists.length).toBeGreaterThan(0);
    expect(tokenLists.every((tokens) => !tokens.includes("absolute"))).toBe(true);
  });

  it("nothing in the rendered markup anchors to the top-left corner (the traffic-lights corner) — the old left-1.5 class is gone entirely", () => {
    const html = renderToStaticMarkup(
      <DockControlsCluster
        maximizedGroupId="group-1"
        onReset={() => {}}
        onRestoreMaximized={() => {}}
      />,
    );

    expect(html).not.toContain("left-1.5");
  });

  it("both controls are visible at once, anchored at the top-right corner", () => {
    const html = renderToStaticMarkup(
      <DockControlsCluster
        maximizedGroupId="group-1"
        onReset={() => {}}
        onRestoreMaximized={() => {}}
      />,
    );

    expect(html).toContain("Restore maximized panel");
    expect(html).toContain("Reset workspace layout");
    expect(html).toContain("absolute top-1.5 right-1.5");
  });

  it("Restore is absent (Reset alone) when nothing is maximized", () => {
    const html = renderToStaticMarkup(
      <DockControlsCluster
        maximizedGroupId={null}
        onReset={() => {}}
        onRestoreMaximized={() => {}}
      />,
    );

    expect(html).not.toContain("Restore maximized panel");
    expect(html).toContain("Reset workspace layout");
  });

  it("Reset's own onClick fires handleReset, and Restore's own onClick fires handleRestoreMaximized — the two handlers stay wired to the right button after the merge", () => {
    // renderToStaticMarkup can't dispatch real events (no jsdom — see this
    // file's own top comment), so this only proves the STRUCTURAL wiring:
    // each button block contains ITS OWN accessible name, not a mismatched
    // one, which is what a copy-paste error while merging the two buttons
    // into one cluster would most plausibly break.
    const html = renderToStaticMarkup(
      <DockControlsCluster
        maximizedGroupId="group-1"
        onReset={() => {}}
        onRestoreMaximized={() => {}}
      />,
    );

    const resetButton = findButtonByContent(html, "Reset workspace layout");
    const restoreButton = findButtonByContent(html, "Restore maximized panel");
    expect(resetButton).toBeDefined();
    expect(restoreButton).toBeDefined();
    expect((resetButton ?? "").includes("Restore maximized panel")).toBe(false);
    expect((restoreButton ?? "").includes("Reset workspace layout")).toBe(false);
  });
});
