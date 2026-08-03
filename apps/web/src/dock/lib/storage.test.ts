import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { LayoutFile } from "./types";
import { createLocalStorageLayoutStorage } from "./storage";

// Same `vi.stubGlobal` pattern as `~/hooks/useLocalStorage.test.ts` — this
// repo's own convention for testing `window.localStorage`-touching code
// without jsdom (there is none configured; see that file for the precedent).
function stubLocalStorage(overrides: Partial<Storage> = {}): void {
  const store = new Map<string, string>();
  const storage: Storage = {
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, value);
    },
    ...overrides,
  };
  vi.stubGlobal("window", { localStorage: storage });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const SAMPLE_FILE: LayoutFile = {
  version: 1,
  preset: "test-preset",
  dockview: {
    grid: {
      orientation: "HORIZONTAL",
      width: 100,
      height: 100,
      root: { type: "leaf", size: 100, data: { id: "g", views: [] } },
    },
    panels: {},
  } as unknown as LayoutFile["dockview"],
  floating: [],
  savedAt: "2026-01-01T00:00:00.000Z",
};

describe("createLocalStorageLayoutStorage().save() — fix-round finding #2", () => {
  it("returns {status: 'ok'} when the write succeeds", async () => {
    stubLocalStorage();
    const storage = createLocalStorageLayoutStorage("test-ns");
    const result = await storage.save("workspace-1", SAMPLE_FILE);
    expect(result).toEqual({ status: "ok" });
  });

  it("returns {status: 'failed', message} instead of throwing or swallowing the error", async () => {
    stubLocalStorage({
      setItem: () => {
        throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      },
    });
    const storage = createLocalStorageLayoutStorage("test-ns");
    const result = await storage.save("workspace-1", SAMPLE_FILE);
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.message).toContain("quota");
    }
  });

  it("never throws even when the underlying write throws something that isn't an Error", async () => {
    stubLocalStorage({
      setItem: () => {
        // eslint-disable-next-line no-throw-literal -- proving the non-Error branch of the guard
        throw "a string, not an Error instance";
      },
    });
    const storage = createLocalStorageLayoutStorage("test-ns");
    const result = await storage.save("workspace-1", SAMPLE_FILE);
    expect(result.status).toBe("failed");
  });
});
