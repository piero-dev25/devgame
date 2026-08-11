// #115: `/unity` was missing from `DEV_PROXIED_PATH_PREFIXES`, so
// `unitySetupProbeAtom`'s request (and every other /unity/* route) 404'd in
// single-origin `pnpm dev:web` — Vite answered directly instead of
// forwarding to the backend. Found live at the network layer while
// verifying #106, invisible until that fix made the client reliably issue
// the request in the first place.
import { describe, expect, it } from "vite-plus/test";

import { isDevProxiedPath, isDevProxiedWebSocketPath } from "./devProxy.js";

describe("isDevProxiedPath", () => {
  it("covers all three Unity routes under the single /unity prefix", () => {
    expect(isDevProxiedPath("/unity/setup-probe")).toBe(true);
    expect(isDevProxiedPath("/unity/command")).toBe(true);
    expect(isDevProxiedPath("/unity/pipeline-install")).toBe(true);
    expect(isDevProxiedPath("/unity")).toBe(true);
  });

  it("still covers the pre-existing prefixes — regression guard, not just the new one", () => {
    expect(isDevProxiedPath("/api/orchestration/threads/abc")).toBe(true);
    expect(isDevProxiedPath("/oauth/callback")).toBe(true);
    expect(isDevProxiedPath("/.well-known/t3/environment")).toBe(true);
    expect(isDevProxiedPath("/ws")).toBe(true);
    expect(isDevProxiedPath("/editor-presence")).toBe(true);
    expect(isDevProxiedPath("/space-events")).toBe(true);
  });

  it("does not match an unrelated path, or a path that merely starts with the same letters", () => {
    expect(isDevProxiedPath("/foo")).toBe(false);
    // "/unityfoo" must NOT match "/unity" — only an exact segment boundary
    // counts, per this function's own `pathname === prefix ||
    // pathname.startsWith(prefix + "/")` check.
    expect(isDevProxiedPath("/unityfoo")).toBe(false);
  });
});

describe("isDevProxiedWebSocketPath", () => {
  it("/unity is plain HTTP, not a websocket upgrade — must stay off this list", () => {
    expect(isDevProxiedWebSocketPath("/unity")).toBe(false);
  });
});
