import { describe, expect, it } from "vite-plus/test";

import {
  appendThirdPartySourceAnnotationPrompt,
  buildThirdPartySourceChip,
  buildThirdPartySourceAnnotationPrompt,
} from "./thirdPartySourceAnnotation";

const figmaIdentity = {
  source: "figma" as const,
  fileKey: "abc123XYZ",
  frameNodeId: "123:456",
  fileName: "My Design File",
};

const figmaIdentityNoFrame = {
  source: "figma" as const,
  fileKey: "abc123XYZ",
  frameNodeId: null,
  fileName: "My Design File",
};

const notionIdentity = {
  source: "notion" as const,
  pageId: "1429989f-e8ac-4eff-bc8f-57f56486db54",
};

describe("buildThirdPartySourceChip", () => {
  it("labels a Figma chip with the file name and shows the frame id as detail", () => {
    expect(buildThirdPartySourceChip(figmaIdentity)).toEqual({
      kind: "figma",
      label: "My Design File",
      detail: "Frame 123:456",
    });
  });

  it("falls back to the file key as the label when Figma has no file name", () => {
    expect(buildThirdPartySourceChip({ ...figmaIdentity, fileName: null })).toEqual({
      kind: "figma",
      label: "abc123XYZ",
      detail: "Frame 123:456",
    });
  });

  it("omits the detail when Figma has no frame in context", () => {
    expect(buildThirdPartySourceChip(figmaIdentityNoFrame)).toEqual({
      kind: "figma",
      label: "My Design File",
      detail: null,
    });
  });

  it("labels a Notion chip with its page id (no page title is captured)", () => {
    expect(buildThirdPartySourceChip(notionIdentity)).toEqual({
      kind: "notion",
      label: "1429989f-e8ac-4eff-bc8f-57f56486db54",
      detail: null,
    });
  });
});

describe("buildThirdPartySourceAnnotationPrompt", () => {
  it("builds a Figma prompt block naming the frame, not a selection", () => {
    const prompt = buildThirdPartySourceAnnotationPrompt({
      identity: figmaIdentity,
      pageUrl: "https://www.figma.com/design/abc123XYZ/My-Design-File?node-id=123-456",
      pageTitle: "My Design File",
      comment: "Match this spacing",
      screenshot: {
        dataUrl: "data:image/png;base64,AAAA",
        width: 100,
        height: 100,
        cropRect: { x: 0, y: 0, width: 100, height: 100 },
      },
      createdAt: "2026-08-04T00:00:00.000Z",
    });
    expect(prompt).toBe(
      [
        "<third_party_source>",
        "Source: figma",
        "Page: My Design File",
        "URL: https://www.figma.com/design/abc123XYZ/My-Design-File?node-id=123-456",
        "File key: abc123XYZ",
        "Frame in context: 123:456 (the top-level frame the user is working in, not a specific layer selection)",
        "Comment: Match this spacing",
        "The attached screenshot shows what the user is currently looking at.",
        "</third_party_source>",
      ].join("\n"),
    );
  });

  it("builds a Notion prompt block with the page id and no comment line when empty", () => {
    const prompt = buildThirdPartySourceAnnotationPrompt({
      identity: notionIdentity,
      pageUrl: "https://www.notion.so/Project-Plan-1429989fe8ac4effbc8f57f56486db54",
      pageTitle: "Project Plan",
      comment: "",
      screenshot: null,
      createdAt: "2026-08-04T00:00:00.000Z",
    });
    expect(prompt).toBe(
      [
        "<third_party_source>",
        "Source: notion",
        "Page: Project Plan",
        "URL: https://www.notion.so/Project-Plan-1429989fe8ac4effbc8f57f56486db54",
        "Page id: 1429989f-e8ac-4eff-bc8f-57f56486db54",
        "</third_party_source>",
      ].join("\n"),
    );
  });
});

describe("appendThirdPartySourceAnnotationPrompt", () => {
  it("appends the block to a non-empty prompt with a blank line separator", () => {
    const result = appendThirdPartySourceAnnotationPrompt("Match this spacing please", {
      identity: notionIdentity,
      pageUrl: "https://www.notion.so/Project-Plan-1429989fe8ac4effbc8f57f56486db54",
      pageTitle: "Project Plan",
      comment: "",
      screenshot: null,
      createdAt: "2026-08-04T00:00:00.000Z",
    });
    expect(result).toBe(
      [
        "Match this spacing please",
        "",
        "<third_party_source>",
        "Source: notion",
        "Page: Project Plan",
        "URL: https://www.notion.so/Project-Plan-1429989fe8ac4effbc8f57f56486db54",
        "Page id: 1429989f-e8ac-4eff-bc8f-57f56486db54",
        "</third_party_source>",
      ].join("\n"),
    );
  });

  it("produces just the block when the prompt is empty, no leading blank line", () => {
    const result = appendThirdPartySourceAnnotationPrompt("", {
      identity: notionIdentity,
      pageUrl: "https://www.notion.so/Project-Plan-1429989fe8ac4effbc8f57f56486db54",
      pageTitle: "Project Plan",
      comment: "",
      screenshot: null,
      createdAt: "2026-08-04T00:00:00.000Z",
    });
    expect(result.startsWith("<third_party_source>")).toBe(true);
    expect(result.includes("\n\n<third_party_source>")).toBe(false);
  });

  it("trims trailing whitespace off the existing prompt before appending", () => {
    const result = appendThirdPartySourceAnnotationPrompt("Existing text   \n\n", {
      identity: notionIdentity,
      pageUrl: "https://www.notion.so/Project-Plan-1429989fe8ac4effbc8f57f56486db54",
      pageTitle: "Project Plan",
      comment: "",
      screenshot: null,
      createdAt: "2026-08-04T00:00:00.000Z",
    });
    expect(result.startsWith("Existing text\n\n<third_party_source>")).toBe(true);
  });
});
