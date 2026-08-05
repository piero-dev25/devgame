import { beforeEach, describe, expect, it } from "vite-plus/test";

import { selectActivePanelForKey, useDockActiveSelectionStore } from "./dockActiveSelectionStore";

beforeEach(() => {
  useDockActiveSelectionStore.setState({ byActivationKey: {} });
});

describe("dockActiveSelectionStore — defaults", () => {
  it("defaults an unset key to null", () => {
    expect(
      selectActivePanelForKey(useDockActiveSelectionStore.getState().byActivationKey, "thread-A"),
    ).toBeNull();
  });

  it("defaults an undefined key to null, without touching the store", () => {
    expect(
      selectActivePanelForKey(useDockActiveSelectionStore.getState().byActivationKey, undefined),
    ).toBeNull();
  });
});

// Task #108's actual repro: A(Browser) -> B(Diff) -> back to A must read
// "browser" for A, never whatever B most recently wrote.
describe("dockActiveSelectionStore — is isolated per key", () => {
  it("recording B's selection does not change what A reads", () => {
    useDockActiveSelectionStore.getState().setActivePanel("thread-A", "browser");
    useDockActiveSelectionStore.getState().setActivePanel("thread-B", "diff");

    expect(
      selectActivePanelForKey(useDockActiveSelectionStore.getState().byActivationKey, "thread-A"),
    ).toBe("browser");
    expect(
      selectActivePanelForKey(useDockActiveSelectionStore.getState().byActivationKey, "thread-B"),
    ).toBe("diff");
  });
});

describe("dockActiveSelectionStore — setActivePanel", () => {
  it("overwrites a key's previous value on a later call", () => {
    useDockActiveSelectionStore.getState().setActivePanel("thread-A", "browser");
    useDockActiveSelectionStore.getState().setActivePanel("thread-A", "diff");

    expect(
      selectActivePanelForKey(useDockActiveSelectionStore.getState().byActivationKey, "thread-A"),
    ).toBe("diff");
  });

  it("clears the entry entirely when panelId is null", () => {
    useDockActiveSelectionStore.getState().setActivePanel("thread-A", "browser");
    useDockActiveSelectionStore.getState().setActivePanel("thread-A", null);

    expect("thread-A" in useDockActiveSelectionStore.getState().byActivationKey).toBe(false);
  });
});
