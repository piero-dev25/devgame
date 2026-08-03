import { describe, expect, it } from "vite-plus/test";

import { buildLayoutFile, parseLayoutValue } from "./serialization";
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
