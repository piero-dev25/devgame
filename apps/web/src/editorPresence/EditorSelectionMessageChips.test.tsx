import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { EditorSelectionMessageChips } from "./EditorSelectionMessageChips";
import type {
  ExtractedEditorSelection,
  ExtractedEditorSelectionEntry,
} from "./editorSelectionContext";

function entry(
  overrides: Partial<ExtractedEditorSelectionEntry> = {},
): ExtractedEditorSelectionEntry {
  return {
    label: "Player",
    kind: "gameObject",
    pinned: false,
    id: "obj-1",
    path: null,
    detail: null,
    ...overrides,
  };
}

function selection(overrides: Partial<ExtractedEditorSelection> = {}): ExtractedEditorSelection {
  return { promptText: "", entries: [], truncatedCount: 0, ...overrides };
}

describe("EditorSelectionMessageChips", () => {
  it("renders nothing when the message carried no editor-selection block", () => {
    const markup = renderToStaticMarkup(
      <EditorSelectionMessageChips selection={selection({ entries: [] })} />,
    );
    expect(markup).toBe("");
  });

  it("renders a live entry plainly", () => {
    const markup = renderToStaticMarkup(
      <EditorSelectionMessageChips selection={selection({ entries: [entry()] })} />,
    );
    expect(markup).toContain("Player");
  });

  it("renders a pinned entry visually distinguished from a live one, consistent with the composer chips", () => {
    const markup = renderToStaticMarkup(
      <EditorSelectionMessageChips
        selection={selection({
          entries: [
            entry({ label: "Live Object", pinned: false }),
            entry({ label: "Pinned Object", pinned: true }),
          ],
        })}
      />,
    );
    expect(markup).toContain("Live Object");
    expect(markup).toContain("Pinned Object");
    // Same pinned tint used by the live composer chips (EditorPresenceChipRow.tsx).
    expect(markup).toContain("bg-blue-500/10");
  });

  it("surfaces the truncation count when present", () => {
    const markup = renderToStaticMarkup(
      <EditorSelectionMessageChips
        selection={selection({ entries: [entry()], truncatedCount: 3 })}
      />,
    );
    expect(markup).toContain("+3 more not shown");
  });

  it("renders an unrecognized kind without throwing", () => {
    expect(() =>
      renderToStaticMarkup(
        <EditorSelectionMessageChips
          selection={selection({ entries: [entry({ kind: "a-brand-new-object-kind" })] })}
        />,
      ),
    ).not.toThrow();
  });
});
