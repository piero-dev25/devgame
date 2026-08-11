// @vitest-environment jsdom
//
// #89/#92 (independent audit, mutation-tested, 2026-08-04): this file used
// to be named PickPreload.test.ts but only ever tested computeLabelPosition
// (moved to PickLabelPosition.test.ts) — the real PickPreload.ts, 48KB, the
// actual Electron preload script that runs inside every preview webview,
// had ZERO coverage. A mutation deleting `if (!event.isTrusted) return;`
// from EITHER human-input handler survived all 463 tests in the suite,
// because the module was simply never loaded by anything. That guard is
// the exact control that defeated a live forged-input attack in the
// preview escalation study: a hostile page dispatching synthetic
// pointerdown/keydown events produced zero IPC specifically because of
// those two lines — delete either and a hostile preview page can forge
// "human" input, holding a tab in human-control indefinitely (denying the
// agent's own automation) and having forged signals mistaken for the
// agent's own expected input.
//
// This needed a real DOM to close honestly, not a hand-rolled shim: the
// module registers its listeners as an import-time side effect
// (`window.addEventListener(...)` at module scope), and `startAnnotation()`
// builds a real element tree (shadow root, SVG, form controls) the moment
// START_PICK_CHANNEL fires. jsdom (added as a devDependency scoped to this
// package) plus a per-file `@vitest-environment jsdom` override gets both,
// with zero effect on every other test in the repo, which stays on the
// default plain-node environment.
//
// `isTrusted` specifically can't be faked via a real dispatched Event —
// confirmed directly, not assumed: `Object.defineProperty(event,
// "isTrusted", { value: true })` on a jsdom PointerEvent THROWS (the DOM
// spec marks it `[LegacyUnforgeable]` and jsdom enforces that). So the
// "genuine human input" direction below is tested by capturing the REAL
// registered listener via a `window.addEventListener` spy and invoking it
// directly with a plain, duck-typed `{isTrusted: true, ...}` object — this
// still proves both halves: that the real registration (capture phase, the
// exact call site the guard sits next to) exists, AND that the guard lets
// a correctly-shaped trusted event through. The "forged" direction uses a
// REAL jsdom-dispatched event, which is untrusted by construction — no
// faking needed, that's the actual attack shape.
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import type { DesktopPreviewAnnotationTheme } from "@t3tools/contracts";

const ipcOn = vi.fn();
const ipcOff = vi.fn();
const ipcSend = vi.fn();

vi.mock("electron", () => ({
  ipcRenderer: { on: ipcOn, off: ipcOff, send: ipcSend },
}));

import {
  ANNOTATION_CAPTURED_CHANNEL,
  ANNOTATION_THEME_CHANNEL,
  CANCEL_PICK_CHANNEL,
  ELEMENT_PICKED_CHANNEL,
  HUMAN_INPUT_CHANNEL,
  START_PICK_CHANNEL,
} from "./GuestProtocol.ts";

const OVERLAY_SELECTOR = "[data-t3code-annotation-ui]";
// The overlay attribute is shared by MANY elements (host, the shadow root's
// internal `root`, hover/marquee boxes, the toolbar, ...), but only the
// outer `host` div and a `<style>` tag (`cursorStyle`) ever attach directly
// to `document.documentElement` — everything else lives inside `host`'s
// shadow root, invisible to a plain `document.querySelector`. Tag-qualified
// to land on `host` specifically, not whichever of the two happens to
// register first.
const HOST_SELECTOR = "div[data-t3code-annotation-ui]";

const FAKE_THEME: DesktopPreviewAnnotationTheme = {
  colorScheme: "dark",
  radius: "0.5rem",
  background: "#111",
  foreground: "#eee",
  popover: "#222",
  popoverForeground: "#eee",
  primary: "#7c3aed",
  primaryForeground: "#fff",
  muted: "#333",
  mutedForeground: "#999",
  accent: "#444",
  accentForeground: "#fff",
  border: "#555",
  input: "#555",
  ring: "#7c3aed",
  fontSans: "system-ui",
  fontMono: "monospace",
};

describe("PickPreload — the real preload module, loaded for real", () => {
  let addEventListenerSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    addEventListenerSpy = vi.spyOn(window, "addEventListener");
    // Import-time side effects (the two DOM listener registrations below,
    // and the three module-scope ipcRenderer.on registrations further
    // down) fire exactly once, here — matching how this module actually
    // loads in a real preload context, not something a per-test re-import
    // would reproduce faithfully.
    await import("./PickPreload.ts");
  });

  afterEach(() => {
    // Any session left open by a test would otherwise silently swallow the
    // next test's `startAnnotation()` call (it tears down the PREVIOUS
    // session first) and leak DOM nodes across tests. The module-scope
    // CANCEL_PICK_CHANNEL handler (first registered, always reads the
    // CURRENT `activeSession` dynamically) is a safe, real way to reset —
    // not a test-only backdoor.
    const moduleCancelHandler = ipcOn.mock.calls.find(
      ([channel]) => channel === CANCEL_PICK_CHANNEL,
    )?.[1] as (() => void) | undefined;
    moduleCancelHandler?.();
    // Deliberately NOT clearing ipcOn: the three module-scope registrations
    // (START_PICK/ANNOTATION_THEME/CANCEL_PICK) happened exactly once, in
    // beforeAll — clearing here would erase them permanently after the
    // first test, since nothing re-registers them. `latestIpcHandler`
    // picks the MOST RECENT match for a given channel, which is what makes
    // this safe: a fresh session's own CANCEL_PICK_CHANNEL/
    // ANNOTATION_CAPTURED_CHANNEL registrations are always found ahead of
    // any earlier session's now-torn-down ones.
    ipcOff.mockClear();
    ipcSend.mockClear();
  });

  const capturedListener = (type: string): ((event: unknown) => void) => {
    const call = addEventListenerSpy.mock.calls.find(([eventType]: [string]) => eventType === type);
    if (!call) throw new Error(`no window.addEventListener("${type}", ...) registration found`);
    return call[1] as (event: unknown) => void;
  };

  // `afterEach` clears `ipcOn` — every test that needs a channel handler
  // re-derives it fresh via THIS helper rather than caching one from
  // `beforeAll`, so it always reads the registration THIS test produced
  // (module-scope channels re-register nothing after import, but
  // session-scope ones — CANCEL_PICK_CHANNEL/ANNOTATION_CAPTURED_CHANNEL —
  // get a fresh closure every time `startAnnotation()` runs). Typed
  // `(...args: unknown[]) => void` rather than a narrower signature: the
  // handlers behind these five channels take different (0-2 argument)
  // shapes, and this helper's whole job is to hand back whatever function
  // ipcRenderer.on was actually given, not to re-declare its signature.
  const latestIpcHandler = (channel: string): ((...args: unknown[]) => void) => {
    const matches = ipcOn.mock.calls.filter((call) => call[0] === channel);
    const call = matches.at(-1);
    if (!call) throw new Error(`no ipcRenderer.on("${channel}", ...) registration found`);
    return call[1] as (...args: unknown[]) => void;
  };

  const startSession = (): void => {
    latestIpcHandler(START_PICK_CHANNEL)();
  };

  describe("HUMAN_INPUT_CHANNEL — the isTrusted guards (priority #1, per the audit)", () => {
    it("registers the pointerdown/keydown listeners in the CAPTURING phase", () => {
      // capture:true (the third argument) matters on its own: a hostile
      // page's own bubble-phase handler could otherwise call
      // stopPropagation and this preload would never see the event at
      // all. Asserted here rather than assumed — a mutation dropping the
      // capture flag is a real, separate way to defeat the same control.
      expect(addEventListenerSpy).toHaveBeenCalledWith("pointerdown", expect.any(Function), true);
      expect(addEventListenerSpy).toHaveBeenCalledWith("keydown", expect.any(Function), true);
    });

    it("blocks a forged (isTrusted: false) pointerdown — the real jsdom-dispatched shape of the attack", () => {
      const dispatched: boolean[] = [];
      window.addEventListener("pointerdown", () => dispatched.push(true), true);
      const forged = new PointerEvent("pointerdown", { clientX: 10, clientY: 20, button: 0 });
      expect(forged.isTrusted).toBe(false); // the load-bearing fact this test relies on
      window.dispatchEvent(forged);
      expect(dispatched).toEqual([true]); // the listener DID run
      expect(ipcSend).not.toHaveBeenCalled(); // but the guard stopped it before it could report anything
    });

    it("reports a genuine (isTrusted: true) pointerdown to the main process", () => {
      const listener = capturedListener("pointerdown");
      listener({ isTrusted: true, clientX: 10, clientY: 20, button: 1 });
      expect(ipcSend).toHaveBeenCalledWith(HUMAN_INPUT_CHANNEL, {
        kind: "pointer",
        x: 10,
        y: 20,
        button: 1,
      });
    });

    it("blocks a forged (isTrusted: false) keydown — the real jsdom-dispatched shape of the attack", () => {
      const dispatched: boolean[] = [];
      window.addEventListener("keydown", () => dispatched.push(true), true);
      const forged = new KeyboardEvent("keydown", { key: "Escape", code: "Escape" });
      expect(forged.isTrusted).toBe(false);
      window.dispatchEvent(forged);
      expect(dispatched).toEqual([true]);
      expect(ipcSend).not.toHaveBeenCalled();
    });

    it("reports a genuine (isTrusted: true) keydown to the main process", () => {
      const listener = capturedListener("keydown");
      listener({ isTrusted: true, key: "a", code: "KeyA" });
      expect(ipcSend).toHaveBeenCalledWith(HUMAN_INPUT_CHANNEL, {
        kind: "key",
        key: "a",
        code: "KeyA",
      });
    });
  });

  describe("the six GuestProtocol channels this module touches", () => {
    it("registers a handler for START_PICK_CHANNEL, ANNOTATION_THEME_CHANNEL, and the module-scope CANCEL_PICK_CHANNEL", () => {
      for (const channel of [START_PICK_CHANNEL, ANNOTATION_THEME_CHANNEL, CANCEL_PICK_CHANNEL]) {
        expect(ipcOn).toHaveBeenCalledWith(channel, expect.any(Function));
      }
    });

    it("ANNOTATION_THEME_CHANNEL is a safe no-op before any session exists", () => {
      expect(() => latestIpcHandler(ANNOTATION_THEME_CHANNEL)({}, FAKE_THEME)).not.toThrow();
    });

    it("module-scope CANCEL_PICK_CHANNEL is a safe no-op before any session exists", () => {
      expect(() => latestIpcHandler(CANCEL_PICK_CHANNEL)()).not.toThrow();
    });

    it("START_PICK_CHANNEL starts a real annotation session — the overlay attaches to the document", () => {
      startSession();
      expect(document.querySelector(OVERLAY_SELECTOR)).not.toBeNull();
      // Starting a session is also where the two SESSION-scoped channels
      // register — proven here, not assumed, closing the other half of
      // the six-channel surface.
      expect(ipcOn).toHaveBeenCalledWith(CANCEL_PICK_CHANNEL, expect.any(Function));
      expect(ipcOn).toHaveBeenCalledWith(ANNOTATION_CAPTURED_CHANNEL, expect.any(Function));
    });

    it("ANNOTATION_THEME_CHANNEL applies to a LIVE session — observable on the overlay host", () => {
      startSession();
      latestIpcHandler(ANNOTATION_THEME_CHANNEL)({}, FAKE_THEME);
      const host = document.querySelector(HOST_SELECTOR) as HTMLElement | null;
      expect(host?.style.colorScheme).toBe(FAKE_THEME.colorScheme);
    });

    it("module-scope CANCEL_PICK_CHANNEL tears an active session down silently (no ELEMENT_PICKED_CHANNEL) and unregisters the session-scoped listeners", () => {
      startSession();
      latestIpcHandler(CANCEL_PICK_CHANNEL)();
      expect(document.querySelector(OVERLAY_SELECTOR)).toBeNull();
      expect(ipcSend).not.toHaveBeenCalledWith(ELEMENT_PICKED_CHANNEL, expect.anything());
      expect(ipcOff).toHaveBeenCalledWith(CANCEL_PICK_CHANNEL, expect.any(Function));
      expect(ipcOff).toHaveBeenCalledWith(ANNOTATION_CAPTURED_CHANNEL, expect.any(Function));
    });

    it("session-scoped ANNOTATION_CAPTURED_CHANNEL tears the session down silently too", () => {
      startSession();
      latestIpcHandler(ANNOTATION_CAPTURED_CHANNEL)();
      expect(document.querySelector(OVERLAY_SELECTOR)).toBeNull();
      expect(ipcSend).not.toHaveBeenCalledWith(ELEMENT_PICKED_CHANNEL, expect.anything());
    });

    it("Escape tears the session down AND notifies the main process via ELEMENT_PICKED_CHANNEL(null) — a real dispatched keydown, not spy-captured (this listener isn't isTrusted-gated)", () => {
      startSession();
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      expect(document.querySelector(OVERLAY_SELECTOR)).toBeNull();
      expect(ipcSend).toHaveBeenCalledWith(ELEMENT_PICKED_CHANNEL, null);
    });
  });
});
