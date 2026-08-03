import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { EditorPresenceChipRow } from "./EditorPresenceChipRow";
import type { EditorPresenceRenderChip } from "./store";

function chip(overrides: Partial<EditorPresenceRenderChip> = {}): EditorPresenceRenderChip {
  return {
    id: "obj-1",
    kind: "gameObject",
    label: "Player",
    path: null,
    detail: null,
    key: "session-1:obj-1",
    editorId: "unity",
    editorName: "Unity",
    sessionId: "session-1",
    pinned: false,
    ...overrides,
  };
}

describe("EditorPresenceChipRow", () => {
  it("renders nothing when there are no chips and no reason to report", () => {
    const markup = renderToStaticMarkup(
      <EditorPresenceChipRow chips={[]} disconnectReason={null} onTogglePin={() => {}} />,
    );
    expect(markup).toBe("");
  });

  it("renders an unpinned live chip as not pressed", () => {
    const markup = renderToStaticMarkup(
      <EditorPresenceChipRow chips={[chip()]} disconnectReason={null} onTogglePin={() => {}} />,
    );
    expect(markup).toContain("Player");
    expect(markup).toContain('aria-pressed="false"');
  });

  it("renders a pinned chip as pressed, with a pin indicator, visually distinguished from live chips", () => {
    const markup = renderToStaticMarkup(
      <EditorPresenceChipRow
        chips={[chip({ pinned: true })]}
        disconnectReason={null}
        onTogglePin={() => {}}
      />,
    );
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('data-testid="pin-indicator"');
    // Distinct styling from a plain live chip (see EditorPresenceChipRow.tsx).
    expect(markup).toContain("bg-blue-500/10");
  });

  it("renders live and pinned chips together, distinguishable from one another", () => {
    const markup = renderToStaticMarkup(
      <EditorPresenceChipRow
        chips={[
          chip({ key: "session-1:live", label: "Live Object", pinned: false }),
          chip({ key: "session-1:pinned", label: "Pinned Object", pinned: true }),
        ]}
        disconnectReason={null}
        onTogglePin={() => {}}
      />,
    );
    expect(markup).toContain("Live Object");
    expect(markup).toContain("Pinned Object");
    expect(markup).toContain('aria-pressed="false"');
    expect(markup).toContain('aria-pressed="true"');
  });

  it("renders an item with an unrecognized kind without throwing", () => {
    expect(() =>
      renderToStaticMarkup(
        <EditorPresenceChipRow
          chips={[chip({ kind: "a-brand-new-object-kind-nobody-has-seen" })]}
          disconnectReason={null}
          onTogglePin={() => {}}
        />,
      ),
    ).not.toThrow();
  });

  it("surfaces the disconnect reason verbatim", () => {
    const markup = renderToStaticMarkup(
      <EditorPresenceChipRow
        chips={[chip()]}
        disconnectReason="Session revoked"
        onTogglePin={() => {}}
      />,
    );
    expect(markup).toContain("Session revoked");
  });

  it("still renders the reason even with no chips, so a lingering pinned-only disconnect is visible", () => {
    const markup = renderToStaticMarkup(
      <EditorPresenceChipRow
        chips={[]}
        disconnectReason="Session revoked"
        onTogglePin={() => {}}
      />,
    );
    expect(markup).not.toBe("");
    expect(markup).toContain("Session revoked");
  });
});
