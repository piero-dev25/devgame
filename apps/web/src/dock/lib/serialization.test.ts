import { describe, expect, it } from "vite-plus/test";

import { buildLayoutFile, findUnknownPanelIds, parseLayoutValue } from "./serialization";
import type { LayoutFile } from "./types";

const SAMPLE_DOCKVIEW = {
  grid: {
    orientation: "HORIZONTAL",
    width: 100,
    height: 100,
    root: { type: "leaf", size: 100, data: { id: "g", views: [] } },
  },
  panels: {},
} as unknown as LayoutFile["dockview"];

describe("buildLayoutFile — knownPanelIds (fix round after 7606dff45)", () => {
  it("includes knownPanelIds verbatim when supplied", () => {
    const file = buildLayoutFile({
      preset: "p",
      dockviewJson: SAMPLE_DOCKVIEW,
      knownPanelIds: ["sidebar", "chat", "files"],
      now: () => "2026-01-01T00:00:00.000Z",
    });
    expect(file.knownPanelIds).toEqual(["sidebar", "chat", "files"]);
  });

  it("omits the key entirely (not `knownPanelIds: undefined`) when not supplied — exactOptionalPropertyTypes", () => {
    const file = buildLayoutFile({
      preset: "p",
      dockviewJson: SAMPLE_DOCKVIEW,
      now: () => "2026-01-01T00:00:00.000Z",
    });
    expect(Object.hasOwn(file, "knownPanelIds")).toBe(false);
  });
});

describe("parseLayoutValue — knownPanelIds round-trip (fix round after 7606dff45)", () => {
  function validFileValue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      version: 1,
      preset: "p",
      dockview: SAMPLE_DOCKVIEW,
      floating: [],
      savedAt: "2026-01-01T00:00:00.000Z",
      ...overrides,
    };
  }

  it("reads back a valid knownPanelIds array", () => {
    const result = parseLayoutValue(validFileValue({ knownPanelIds: ["sidebar", "chat"] }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.file.knownPanelIds).toEqual(["sidebar", "chat"]);
  });

  it("parses successfully with knownPanelIds entirely absent — a real file saved before this field existed", () => {
    // The exact shape of the orphaned chat-dock-v2 key this whole fix round
    // is about. Absence must NOT be an invalid-shape rejection — that would
    // make every pre-existing saved layout in the wild unreadable overnight.
    const result = parseLayoutValue(validFileValue());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.file.knownPanelIds).toBeUndefined();
  });

  it("treats a malformed knownPanelIds (not an array) as absent rather than failing the whole parse", () => {
    const result = parseLayoutValue(validFileValue({ knownPanelIds: "not-an-array" }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.file.knownPanelIds).toBeUndefined();
  });

  it("treats a malformed knownPanelIds (array of non-strings) as absent rather than propagating bad data into migration logic", () => {
    const result = parseLayoutValue(validFileValue({ knownPanelIds: ["sidebar", 42, null] }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.file.knownPanelIds).toBeUndefined();
  });

  it("accepts an empty knownPanelIds array as a real, valid baseline (not absence)", () => {
    const result = parseLayoutValue(validFileValue({ knownPanelIds: [] }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.file.knownPanelIds).toEqual([]);
  });
});

// Task #91's sibling case, kept working deliberately: a panel that WAS
// registered when a layout was saved, then later removed from the catalog
// entirely (a real panel shipped, then deleted, is the general shape — the
// `third-party-source` panel this test originally used as its live example
// is itself gone now, owner ruling 2026-08-04, but the mechanism this
// proves is unrelated to that specific panel and still applies to any
// future one), is a DIFFERENT situation from `layoutMigration.test.ts`'s
// "on-demand panel absent from the default preset" case above — here the
// saved layout genuinely REFERENCES the panel, and the catalog no longer
// recognizes it. That deserves the quarantine-card notice DockviewLayout.tsx
// builds from this function's result, and this proves the detection half of
// that mechanism still fires on its own, independent of the migration fix.
describe("findUnknownPanelIds — a panel referenced by a saved layout that the current catalog no longer registers", () => {
  function dockviewWithPanels(
    panels: Record<string, { contentComponent?: string }>,
  ): LayoutFile["dockview"] {
    return {
      grid: SAMPLE_DOCKVIEW.grid,
      panels: Object.fromEntries(
        Object.entries(panels).map(([id, p]) => [
          id,
          { id, contentComponent: p.contentComponent, title: id },
        ]),
      ),
    } as unknown as LayoutFile["dockview"];
  }

  it("flags a panel id whose contentComponent isn't in the current catalog — a removed-panel case", () => {
    const dockview = dockviewWithPanels({
      sidebar: { contentComponent: "sidebar" },
      chat: { contentComponent: "chat" },
      "old-widget-panel": { contentComponent: "old-widget-panel" },
    });
    // The catalog no longer knows about a panel this saved layout still references.
    const knownComponentIds = new Set(["sidebar", "chat"]);
    expect(findUnknownPanelIds(dockview, knownComponentIds)).toEqual(["old-widget-panel"]);
  });

  it("reports nothing when every referenced panel is still in the catalog", () => {
    const dockview = dockviewWithPanels({
      sidebar: { contentComponent: "sidebar" },
      chat: { contentComponent: "chat" },
    });
    const knownComponentIds = new Set(["sidebar", "chat", "old-widget-panel"]);
    expect(findUnknownPanelIds(dockview, knownComponentIds)).toEqual([]);
  });
});
