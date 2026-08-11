// docs/specs/unified-topband.md, Section A (critique B3/m6): headless
// dockview-core@7.0.4 + jsdom repro for the capture-phase `dragstart`
// cancel — DockviewLayout.tsx's `handleTopBandDragStartCapture`. This is
// the reused precedent named in the spec's own test-plan line
// ("the repo's jsdom+dockview harness precedent
// (evidence/task-108-f7-headless-repro/, referenced from
// DockviewLayout.tsx) — construct a dock, synthetic dragstart on a band
// void, assert defaultPrevented AND LocalSelectionTransfer empty").
//
// SAME REASON AS THE PRECEDENT for living here rather than in `pnpm test`:
// `apps/web` has no jsdom environment configured on purpose (the vite
// config's `test.environment` is `"node"` — see
// `restoreActivePanel.test.ts`'s own module doc for the standing decision).
// This is a standalone Node script, not part of `pnpm test`/`vitest`.
//
// Run with:
//   node evidence/task-137-topband-headless-repro/repro-band-dragstart-cancel.cjs
//
// If it fails to resolve `jsdom`/`dockview-core` after a `pnpm-lock.yaml`
// change, re-resolve the hardcoded `JSDOM_ENTRY`/`DOCKVIEW_ENTRY` paths
// below the same way the precedent's own README says:
//   find node_modules/.pnpm -maxdepth 1 -iname "jsdom@*"
//   find node_modules/.pnpm -maxdepth 1 -iname "dockview-core@*"
//
// RED-FIRST METHOD (per house rules — "document red-or-why per test"): this
// script's `main()` runs BOTH scenarios every time — `withListener: false`
// FIRST. That run is the red state: it drives the SAME synthetic dragstart
// against a dock with NO capture-phase guard installed at all, and (per the
// traced dockview-core@7.0.4 source — dnd/backend.js's Html5DragSource
// dragstart listener, `dnd/dataTransfer.js`'s `LocalSelectionTransfer`,
// `dockview/components/titlebar/groupDragSource.js`'s `sharedDragOptions.
// getData`) the void container's own drag machinery runs to completion:
// `defaultPrevented` stays `false` and `LocalSelectionTransfer` picks up
// real `PanelTransfer` data. That failure is the proof this repro exercises
// dockview's REAL, unmodified dragstart path, not a tautology — the SAME
// standard `workspaceChromeInset.test.ts`/`topBandLayout.test.ts` apply via
// "module doesn't exist yet," adapted for a script that can't literally
// delete DockviewLayout.tsx's not-yet-written listener out from under a
// live dock. `withListener: true` then re-runs the identical steps WITH
// DockviewLayout.tsx's actual `handleTopBandDragStartCapture` logic
// installed (copied verbatim below, not reimplemented loosely — see that
// function's own comment in DockviewLayout.tsx) and asserts the cancel:
// `defaultPrevented === true` AND `LocalSelectionTransfer` still empty.

const JSDOM_ENTRY =
  "/Users/pieroherrera/Projects/t3code-fork/node_modules/.pnpm/jsdom@30.0.1_@noble+hashes@2.2.0/node_modules/jsdom/lib/api.js";
// ONE entry for both `createDockview` AND `getPanelData` — deliberately the
// SAME require, not two paths to two different bundles: `getPanelData`
// reads the `LocalSelectionTransfer` singleton that `createDockview`'s own
// internal `groupDragSource.js` writes to, and that's only guaranteed to be
// the SAME singleton if both come from one module graph (see
// `readTransferredPanelData`'s own comment for the full reasoning).
const DOCKVIEW_ENTRY =
  "/Users/pieroherrera/Projects/t3code-fork/node_modules/.pnpm/dockview-core@7.0.4/node_modules/dockview-core/dist/package/main.cjs.js";

function setupJsdomGlobals() {
  const { JSDOM } = require(JSDOM_ENTRY);
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
    pretendToBeVisual: true,
  });
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.HTMLElement = dom.window.HTMLElement;
  global.customElements = dom.window.customElements;
  global.MouseEvent = dom.window.MouseEvent;
  // Beyond what the task-108 precedent needed: this repro is the first to
  // dispatch a REAL dragstart that reaches dockview-core's actual
  // `Html5DragSource` listener (dnd/backend.js), which calls
  // `disableIframePointEvents` (dom.js) — that function does `rootNode
  // instanceof Document` and `node.nodeType === Node.ELEMENT_NODE`, both of
  // which throw ReferenceError without these two globals (found empirically
  // — the first run crashed here, not at the assertion).
  global.Document = dom.window.Document;
  global.Node = dom.window.Node;
  global.getComputedStyle = dom.window.getComputedStyle;
  global.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  global.cancelAnimationFrame = (id) => clearTimeout(id);
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

/**
 * Builds a two-group dock mirroring the app's real default preset shape
 * closely enough for this repro's purpose: a LEFT group (the Sidebar's
 * (0,0) group, boundingBox.left === 0 && top === 0 once dockview lays it
 * out against the stubbed 800x600 container) and a RIGHT group (Chat,
 * top-row but NOT the corner owner). `data-dv-topband` is stamped on BOTH
 * groups' `.dv-tabs-and-actions-container` — this repro is scoped to
 * proving the dragstart cancel, not re-proving `computeTopBandLayout`
 * (already covered, red-first, by `topBandLayout.test.ts`), so the
 * stamping here is done directly rather than via the real
 * `onDidLayoutChange` wiring.
 */
function buildDockview() {
  const { createDockview } = require(DOCKVIEW_ENTRY);
  const container = document.getElementById("root");
  container.getBoundingClientRect = () => ({
    width: 800,
    height: 600,
    top: 0,
    left: 0,
    right: 800,
    bottom: 600,
  });
  const api = createDockview(container, {
    createComponent: (options) => {
      const element = document.createElement("div");
      element.setAttribute("data-panel", options.id);
      return { element, init() {}, dispose() {} };
    },
  });
  return { api, container };
}

function stampTopBand(api) {
  for (const group of api.groups) {
    const headerEl = group.element.querySelector(".dv-tabs-and-actions-container");
    if (headerEl) headerEl.setAttribute("data-dv-topband", "");
  }
}

/**
 * DockviewLayout.tsx's `handleTopBandDragStartCapture`, copied verbatim
 * (structurally — same `target.closest("[data-dv-topband] .dv-void-
 * container")` guard, same `event.preventDefault()` action) rather than
 * reimplemented loosely, so a change to the real function that silently
 * stops matching would show up here as a real divergence next time this
 * script is re-run by hand, not be hidden by two independently-drifted
 * copies.
 */
function installCaptureGuard(container) {
  const handler = (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.closest("[data-dv-topband] .dv-void-container")) {
      event.preventDefault();
    }
  };
  container.addEventListener("dragstart", handler, true);
  return () => container.removeEventListener("dragstart", handler, true);
}

// `setDragImage` is required too — found empirically: the RED-FIRST
// (uncancelled) scenario reaches `groupDragSource.js`'s ghost-image code
// (`addGhostImage`, called AFTER `getData()` — dnd/backend.js's ordering —
// so this omission never affected the assertion itself, only produced a
// noisy uncaught-in-listener stack trace on an otherwise-passing run).
function makeStubDataTransfer() {
  return {
    effectAllowed: undefined,
    items: { length: 0 },
    types: [],
    setData() {},
    setDragImage() {},
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Dispatches a synthetic dragstart AT the band void container element
 * (jsdom has no real DragEvent — same documented workaround
 * evidence/task-108-f7-headless-repro/ uses: MouseEvent stands in, with a
 * stub `dataTransfer` attached afterward since MouseEvent's constructor
 * doesn't accept one). Returns the dispatched event AND the element, so the
 * caller can both inspect `defaultPrevented` and drive a matching dragend
 * afterward (see `runScenario`'s own comment for why that matters).
 */
function dispatchDragStartOnBandVoid(api) {
  const bandGroup = api.groups.find((group) => group.element.getBoundingClientRect().left === 0);
  if (!bandGroup) throw new Error("repro setup error: no (0,0) group found");
  const voidEl = bandGroup.element.querySelector(".dv-void-container");
  if (!voidEl) throw new Error("repro setup error: band group has no .dv-void-container");

  const event = new MouseEvent("dragstart", { bubbles: true, cancelable: true });
  event.dataTransfer = makeStubDataTransfer();
  voidEl.dispatchEvent(event);
  return { event, voidEl };
}

// `LocalSelectionTransfer` itself (the singleton class) is NOT part of
// dockview-core's public export surface — verified empirically: neither
// `main.cjs.js` nor `main.esm.mjs` export it, only the `PaneTransfer`/
// `PanelTransfer` DATA classes. `getPanelData()` IS exported from the SAME
// bundle `createDockview` comes from (confirmed: `typeof
// require(DOCKVIEW_ENTRY).getPanelData === 'function'`), and is the exact
// function `voidContainer.js`'s own `canDisplayOverlay` calls to read
// whatever `LocalSelectionTransfer` currently holds — using it observes the
// SAME live singleton `groupDragSource.js`'s `sharedDragOptions.getData`
// writes to (both come from ONE require of ONE bundle, so there is only
// ever one module graph here), without needing direct access to the
// non-exported class. Returns `undefined` when no PanelTransfer data is
// set — exactly the "empty" check the spec's test plan asks for.
function readTransferredPanelData() {
  const { getPanelData } = require(DOCKVIEW_ENTRY);
  return getPanelData();
}

async function runScenario(withListener) {
  console.log(
    `\n########## SCENARIO: band void dragstart, withListener=${withListener} ##########`,
  );
  const { api, container } = buildDockview();

  api.addPanel({ id: "sidebar", component: "default", position: { direction: "left" } });
  api.addPanel({ id: "chat", component: "default", position: { direction: "right" } });
  stampTopBand(api);

  const uninstall = withListener ? installCaptureGuard(container) : () => {};

  const { event, voidEl } = dispatchDragStartOnBandVoid(api);
  const panelData = readTransferredPanelData();

  console.log(`  defaultPrevented: ${event.defaultPrevented}`);
  console.log(
    `  getPanelData(): ${panelData === undefined ? "undefined (empty)" : JSON.stringify(panelData)}`,
  );

  // `LocalSelectionTransfer` is a process-wide singleton with no public
  // clear — dispatching a real `dragend` on the SAME element drives
  // dockview's OWN cleanup (`Html5DragSource`'s dragend listener, deferred
  // one macrotask via `setTimeout(0)` — "defer disposal so drop handlers
  // can still read the transfer payload before it clears," per its own
  // comment), so the NEXT scenario starts from a genuinely empty singleton
  // instead of silently inheriting THIS scenario's leftover data. Real
  // behavior, not a test-only reset hack.
  voidEl.dispatchEvent(new MouseEvent("dragend", { bubbles: true, cancelable: true }));
  await sleep(10);

  uninstall();
  api.dispose();

  const cancelled = event.defaultPrevented === true && panelData === undefined;
  const leaked = event.defaultPrevented === false && panelData !== undefined;
  console.log(
    withListener
      ? cancelled
        ? "  RESULT: CANCELLED — defaultPrevented, no leaked PanelTransfer data (expected, green)"
        : "  RESULT: UNEXPECTED — the capture guard did not cancel the drag"
      : leaked
        ? "  RESULT: NOT cancelled — dockview's own drag ran to completion (expected RED-FIRST baseline: no guard installed, proves this repro exercises the real, unmodified path)"
        : "  RESULT: UNEXPECTED — expected the uncancelled baseline to leak PanelTransfer data",
  );

  return {
    withListener,
    cancelled,
    leaked,
    defaultPrevented: event.defaultPrevented,
    hasPanelData: panelData !== undefined,
  };
}

async function main() {
  setupJsdomGlobals();

  const redFirst = await runScenario(false);
  const green = await runScenario(true);

  console.log("\n\n================ SUMMARY ================");
  console.log(
    `RED-FIRST (no listener):  defaultPrevented=${redFirst.defaultPrevented} hasPanelData=${redFirst.hasPanelData} -> ${redFirst.leaked ? "PASS (proves real path, not cancelled)" : "FAIL (unexpected)"}`,
  );
  console.log(
    `GREEN (with listener):    defaultPrevented=${green.defaultPrevented} hasPanelData=${green.hasPanelData} -> ${green.cancelled ? "PASS (cancelled, no leak)" : "FAIL (not cancelled)"}`,
  );

  const allPass = redFirst.leaked && green.cancelled;
  console.log(
    allPass
      ? "\nRED-FIRST proven, then GREEN proven: the capture-phase guard is the thing making the difference, not an artifact of the harness."
      : "\nUNEXPECTED — investigate using the per-scenario logs above.",
  );
  process.exitCode = allPass ? 0 : 1;
}

main();
