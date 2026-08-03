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
  it("renders nothing when there are no chips and the connection is healthy (connected, no reason)", () => {
    const markup = renderToStaticMarkup(
      <EditorPresenceChipRow
        chips={[]}
        phase="connected"
        disconnectReason={null}
        onTogglePin={() => {}}
      />,
    );
    expect(markup).toBe("");
  });

  it("renders an unpinned live chip as not pressed", () => {
    const markup = renderToStaticMarkup(
      <EditorPresenceChipRow
        chips={[chip()]}
        phase="connected"
        disconnectReason={null}
        onTogglePin={() => {}}
      />,
    );
    expect(markup).toContain("Player");
    expect(markup).toContain('aria-pressed="false"');
  });

  it("renders a pinned chip as pressed, with a pin indicator, visually distinguished from live chips", () => {
    const markup = renderToStaticMarkup(
      <EditorPresenceChipRow
        chips={[chip({ pinned: true })]}
        phase="connected"
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
        phase="connected"
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
          phase="connected"
          disconnectReason={null}
          onTogglePin={() => {}}
        />,
      ),
    ).not.toThrow();
  });

  it("surfaces the disconnect reason verbatim while disconnected", () => {
    const markup = renderToStaticMarkup(
      <EditorPresenceChipRow
        chips={[chip()]}
        phase="disconnected"
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
        phase="disconnected"
        disconnectReason="Session revoked"
        onTogglePin={() => {}}
      />,
    );
    expect(markup).not.toBe("");
    expect(markup).toContain("Session revoked");
  });

  describe("persistent connection indicator", () => {
    it("shows a connecting indicator even with zero chips (the dominant runtime state during a Unity domain reload)", () => {
      const markup = renderToStaticMarkup(
        <EditorPresenceChipRow
          chips={[]}
          phase="connecting"
          disconnectReason={null}
          onTogglePin={() => {}}
        />,
      );
      expect(markup).not.toBe("");
      expect(markup).toContain("connecting");
      expect(markup).toContain('role="status"');
    });

    it("prefers the connecting label over a stale reason from a previous attempt", () => {
      const markup = renderToStaticMarkup(
        <EditorPresenceChipRow
          chips={[]}
          phase="connecting"
          disconnectReason="cannot reach Workbench at https://environment.example"
          onTogglePin={() => {}}
        />,
      );
      expect(markup).toContain("connecting");
      expect(markup).not.toContain("cannot reach Workbench");
    });

    it("shows nothing while connected and healthy, even though phase transitions through connecting first", () => {
      const markup = renderToStaticMarkup(
        <EditorPresenceChipRow
          chips={[]}
          phase="connected"
          disconnectReason={null}
          onTogglePin={() => {}}
        />,
      );
      expect(markup).toBe("");
    });

    it("stays quiet when connected even if pinned chips are showing (no separate status noise once healthy)", () => {
      const markup = renderToStaticMarkup(
        <EditorPresenceChipRow
          chips={[chip({ pinned: true })]}
          phase="connected"
          disconnectReason={null}
          onTogglePin={() => {}}
        />,
      );
      expect(markup).toContain("Player");
      expect(markup).not.toContain('role="status"');
    });
  });
});
