import type { DockviewApi, IDockviewPanel } from "dockview";
import { describe, expect, it } from "vite-plus/test";

import { restoreActivePanelForKey } from "./restoreActivePanel";

function fakePanel(id: string, onSetActive?: () => void): IDockviewPanel {
  return {
    id,
    api: { setActive: () => onSetActive?.() },
  } as unknown as IDockviewPanel;
}

function fakeApi(overrides: {
  getPanel?: (id: string) => IDockviewPanel | undefined;
}): DockviewApi {
  return {
    getPanel: overrides.getPanel ?? (() => undefined),
  } as unknown as DockviewApi;
}

// Task #108: the outer dock tab-selection leak. Repro was A(Browser) ->
// B(Diff) -> back to A, where A incorrectly showed Diff instead of Browser.
// This is the red case for that bug: proves the REMEMBERED panel wins over
// whatever fallback a caller names, not merely that a value was stored.
describe("restoreActivePanelForKey — a remembered panel is open in the live layout", () => {
  it("activates the remembered panel, not the fallback", () => {
    let browserActivated = false;
    let chatActivated = false;
    const api = fakeApi({
      getPanel: (id) => {
        if (id === "browser") return fakePanel("browser", () => (browserActivated = true));
        if (id === "chat") return fakePanel("chat", () => (chatActivated = true));
        return undefined;
      },
    });

    restoreActivePanelForKey(api, { rememberedPanelId: "browser", fallbackPanelId: "chat" });

    expect(browserActivated).toBe(true);
    expect(chatActivated).toBe(false);
  });
});

describe("restoreActivePanelForKey — nothing remembered yet (a thread visited for the first time)", () => {
  it("falls back to fallbackPanelId — preserves fix-round finding #5's original guarantee", () => {
    let chatActivated = false;
    const api = fakeApi({
      getPanel: (id) =>
        id === "chat" ? fakePanel("chat", () => (chatActivated = true)) : undefined,
    });

    restoreActivePanelForKey(api, { rememberedPanelId: null, fallbackPanelId: "chat" });

    expect(chatActivated).toBe(true);
  });
});

describe("restoreActivePanelForKey — the remembered panel was since closed", () => {
  it("falls back rather than silently no-oping on a panel id that's no longer open", () => {
    let chatActivated = false;
    const api = fakeApi({
      getPanel: (id) =>
        id === "chat" ? fakePanel("chat", () => (chatActivated = true)) : undefined,
    });

    restoreActivePanelForKey(api, { rememberedPanelId: "diff", fallbackPanelId: "chat" });

    expect(chatActivated).toBe(true);
  });
});

describe("restoreActivePanelForKey — nothing remembered, no fallback given", () => {
  it("no-ops silently rather than throwing", () => {
    const api = fakeApi({ getPanel: () => undefined });

    expect(() => restoreActivePanelForKey(api, { rememberedPanelId: null })).not.toThrow();
  });
});
