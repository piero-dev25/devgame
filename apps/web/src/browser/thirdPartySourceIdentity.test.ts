import { describe, expect, it } from "vite-plus/test";

import {
  parseFigmaIdentity,
  parseNotionIdentity,
  parseThirdPartySourceIdentity,
  thirdPartySourceOrigin,
} from "./thirdPartySourceIdentity";

describe("parseFigmaIdentity", () => {
  it("extracts file key, frame node id, and file name from a /design/ URL with a frame in context", () => {
    expect(
      parseFigmaIdentity(
        "https://www.figma.com/design/abc123XYZ/My-Design-File?node-id=123-456&t=abcd",
      ),
    ).toEqual({
      source: "figma",
      fileKey: "abc123XYZ",
      frameNodeId: "123:456",
      fileName: "My Design File",
    });
  });

  it("extracts identity from the older /file/ URL form", () => {
    expect(
      parseFigmaIdentity("https://www.figma.com/file/abc123XYZ/My-Design-File?node-id=1-2"),
    ).toEqual({
      source: "figma",
      fileKey: "abc123XYZ",
      frameNodeId: "1:2",
      fileName: "My Design File",
    });
  });

  it("returns a null frame node id when the URL carries no frame context (file-level only)", () => {
    expect(parseFigmaIdentity("https://www.figma.com/design/abc123XYZ/My-Design-File")).toEqual({
      source: "figma",
      fileKey: "abc123XYZ",
      frameNodeId: null,
      fileName: "My Design File",
    });
  });

  it("returns null file name when the URL has no title segment", () => {
    expect(parseFigmaIdentity("https://www.figma.com/design/abc123XYZ")).toEqual({
      source: "figma",
      fileKey: "abc123XYZ",
      frameNodeId: null,
      fileName: null,
    });
  });

  it("returns null for a non-Figma URL", () => {
    expect(parseFigmaIdentity("https://www.notion.so/Some-Page-abc123")).toBeNull();
  });

  it("returns null for a Figma community/marketing URL with no file key", () => {
    expect(parseFigmaIdentity("https://www.figma.com/community/design-systems")).toBeNull();
  });
});

describe("parseNotionIdentity", () => {
  it("extracts and hyphenates the page id from a titled page URL", () => {
    expect(
      parseNotionIdentity(
        "https://www.notion.so/myworkspace/Project-Plan-1429989fe8ac4effbc8f57f56486db54",
      ),
    ).toEqual({
      source: "notion",
      pageId: "1429989f-e8ac-4eff-bc8f-57f56486db54",
    });
  });

  it("extracts the page id from a bare (no title) page URL", () => {
    expect(parseNotionIdentity("https://www.notion.so/1429989fe8ac4effbc8f57f56486db54")).toEqual({
      source: "notion",
      pageId: "1429989f-e8ac-4eff-bc8f-57f56486db54",
    });
  });

  it("strips query params and hash fragments before extracting the id", () => {
    expect(
      parseNotionIdentity(
        "https://www.notion.so/myworkspace/Project-Plan-1429989fe8ac4effbc8f57f56486db54?pvs=4#block-anchor",
      ),
    ).toEqual({
      source: "notion",
      pageId: "1429989f-e8ac-4eff-bc8f-57f56486db54",
    });
  });

  it("returns null when the trailing path segment isn't a 32-character id", () => {
    expect(parseNotionIdentity("https://www.notion.so/myworkspace")).toBeNull();
  });

  it("returns null for a non-Notion URL", () => {
    expect(parseNotionIdentity("https://www.figma.com/design/abc123XYZ")).toBeNull();
  });
});

describe("parseThirdPartySourceIdentity", () => {
  it("dispatches to the Figma parser for a Figma URL", () => {
    expect(
      parseThirdPartySourceIdentity("https://www.figma.com/design/abc123XYZ/My-File?node-id=1-2"),
    ).toEqual({
      source: "figma",
      fileKey: "abc123XYZ",
      frameNodeId: "1:2",
      fileName: "My File",
    });
  });

  it("dispatches to the Notion parser for a Notion URL", () => {
    expect(
      parseThirdPartySourceIdentity(
        "https://www.notion.so/Project-Plan-1429989fe8ac4effbc8f57f56486db54",
      ),
    ).toEqual({
      source: "notion",
      pageId: "1429989f-e8ac-4eff-bc8f-57f56486db54",
    });
  });

  it("returns null for a URL matching neither source", () => {
    expect(parseThirdPartySourceIdentity("https://example.com/whatever")).toBeNull();
  });
});

// F4 (owner ruling, relayed 2026-08-04): sign-out needs the ORIGIN a source
// lives at, to pass through to Electron's origin-scoped `clearStorageData`.
describe("thirdPartySourceOrigin", () => {
  it("returns Figma's canonical origin", () => {
    expect(thirdPartySourceOrigin("figma")).toBe("https://www.figma.com");
  });

  it("returns Notion's canonical origin", () => {
    expect(thirdPartySourceOrigin("notion")).toBe("https://www.notion.so");
  });
});
