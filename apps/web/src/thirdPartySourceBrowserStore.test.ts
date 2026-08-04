import { beforeEach, describe, expect, it } from "vite-plus/test";

import { useThirdPartySourceBrowserStore } from "./thirdPartySourceBrowserStore";

const initialState = useThirdPartySourceBrowserStore.getState();

beforeEach(() => {
  useThirdPartySourceBrowserStore.setState(initialState, true);
});

describe("useThirdPartySourceBrowserStore", () => {
  it("starts with no active source and no tab state", () => {
    const state = useThirdPartySourceBrowserStore.getState();
    expect(state.activeSource).toBeNull();
    expect(state.tabs.figma).toBeNull();
    expect(state.tabs.notion).toBeNull();
  });

  it("opening a source with no prior tab state seeds it at that product's default URL", () => {
    useThirdPartySourceBrowserStore.getState().open("figma");
    const state = useThirdPartySourceBrowserStore.getState();
    expect(state.activeSource).toBe("figma");
    expect(state.tabs.figma).toEqual({ url: "https://www.figma.com/files", title: null });
    expect(state.tabs.notion).toBeNull();
  });

  it("re-opening a source that already has tab state does not reset it", () => {
    useThirdPartySourceBrowserStore.getState().open("notion");
    useThirdPartySourceBrowserStore
      .getState()
      .setTabState("notion", { url: "https://www.notion.so/My-Page-abc123", title: "My Page" });
    useThirdPartySourceBrowserStore.getState().open("figma");
    useThirdPartySourceBrowserStore.getState().open("notion");

    expect(useThirdPartySourceBrowserStore.getState().tabs.notion).toEqual({
      url: "https://www.notion.so/My-Page-abc123",
      title: "My Page",
    });
  });

  it("switching the active source keeps both tabs' state independently", () => {
    useThirdPartySourceBrowserStore.getState().open("figma");
    useThirdPartySourceBrowserStore.getState().open("notion");

    const state = useThirdPartySourceBrowserStore.getState();
    expect(state.activeSource).toBe("notion");
    expect(state.tabs.figma).not.toBeNull();
    expect(state.tabs.notion).not.toBeNull();
  });

  it("setTabState updates only the named source's tab", () => {
    useThirdPartySourceBrowserStore.getState().open("figma");
    useThirdPartySourceBrowserStore.getState().open("notion");
    useThirdPartySourceBrowserStore
      .getState()
      .setTabState("figma", { url: "https://www.figma.com/design/abc/My-File", title: "My File" });

    const state = useThirdPartySourceBrowserStore.getState();
    expect(state.tabs.figma).toEqual({
      url: "https://www.figma.com/design/abc/My-File",
      title: "My File",
    });
    expect(state.tabs.notion?.url).toBe("https://www.notion.so/");
  });

  it("close clears the active source but preserves both tabs' state", () => {
    useThirdPartySourceBrowserStore.getState().open("figma");
    useThirdPartySourceBrowserStore.getState().close();

    const state = useThirdPartySourceBrowserStore.getState();
    expect(state.activeSource).toBeNull();
    expect(state.tabs.figma).not.toBeNull();
  });

  // F4 (owner ruling, relayed 2026-08-04): after a sign-out clears the
  // partition's storage for a source, its remembered URL/title must not
  // survive — a stale `tabs.figma.url` pointing at a page that required the
  // now-cleared login would just reload back into the logged-out state
  // looking like nothing happened. Resetting to `null` re-seeds the tab at
  // its default URL next time `open` runs (same mechanism a first-ever
  // `open` uses), which is exactly what a freshly signed-out tab should do.
  it("resetTab clears the named source's remembered tab state", () => {
    useThirdPartySourceBrowserStore.getState().open("figma");
    useThirdPartySourceBrowserStore
      .getState()
      .setTabState("figma", { url: "https://www.figma.com/design/abc/My-File", title: "My File" });

    useThirdPartySourceBrowserStore.getState().resetTab("figma");

    expect(useThirdPartySourceBrowserStore.getState().tabs.figma).toBeNull();
  });

  it("resetTab does not touch the other source's tab state", () => {
    useThirdPartySourceBrowserStore.getState().open("figma");
    useThirdPartySourceBrowserStore.getState().open("notion");
    useThirdPartySourceBrowserStore
      .getState()
      .setTabState("notion", { url: "https://www.notion.so/My-Page-abc123", title: "My Page" });

    useThirdPartySourceBrowserStore.getState().resetTab("figma");

    expect(useThirdPartySourceBrowserStore.getState().tabs.notion).toEqual({
      url: "https://www.notion.so/My-Page-abc123",
      title: "My Page",
    });
  });

  it("resetTab leaves activeSource untouched — resetting is not closing", () => {
    useThirdPartySourceBrowserStore.getState().open("figma");
    useThirdPartySourceBrowserStore.getState().resetTab("figma");

    expect(useThirdPartySourceBrowserStore.getState().activeSource).toBe("figma");
  });
});
