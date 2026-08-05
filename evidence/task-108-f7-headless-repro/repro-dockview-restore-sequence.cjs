// Task #108, round 4 (live QA, merge-gate finding F7) — headless
// dockview-core@7.0.4 + jsdom repro used to verify the F7 hypothesis before
// implementing the fix landed in commit eebb4c322 (see evidence/qa-round4/
// and this file's own directory's README.md for the full writeup).
//
// This is NOT part of the app's test suite (no jsdom is configured for
// apps/web on purpose — see restoreActivePanel.test.ts's own module doc)
// and is NOT run by `pnpm test`/`vitest`. It is a standalone diagnostic
// script, kept for round-5+ continuity: re-run it, or extend it with a new
// scenario(), if the leak resurfaces and F7 needs re-examining.
//
// Run with: node evidence/task-108-f7-headless-repro/repro-dockview-restore-sequence.cjs
//
// Requires `jsdom` resolvable from node_modules (present as a transitive
// dependency at the time this was written — check with
// `find node_modules/.pnpm -maxdepth 1 -iname "jsdom@*"` if this script
// fails to resolve it after a lockfile change; adjust JSDOM_ENTRY below to
// whatever path that turns up).
//
// WHAT IT DOES: wires up a REAL dockview-core instance (two groups: one
// with a "chat" panel, one shared by "files" and "diff" — mirroring the
// actual Files/Diff tab strip this app's ChatDock.tsx builds) against a
// minimal jsdom shim, then drives it through the restore/record logic
// EXACTLY as committed in DockviewLayout.tsx / restoreActivePanel.ts /
// dockActiveSelectionStore.ts at the time of round 3 (group-then-panel
// restore ordering, top-level + per-group record subscriptions — no
// suppression guard, so it reproduces what round 3's code actually did).
//
// WHAT IT FOUND: F7 (the transient wrong top-level fire during
// `panel.group.api.setActive()`, carrying the group's OLD active panel) is
// REAL — see "group.api.setActive(): TOP-LEVEL fired" lines in scenario B's
// output below. But in EVERY scenario this script could construct, that
// transient is synchronously superseded within the SAME call by dockview-core's
// own guarded re-broadcast once the group becomes active — the store's FINAL
// value always comes out correct. This script did NOT reproduce round 4's
// persisting live leak. The suppression fix (isRestoringRef /
// recordActivePanelForKeyUnlessRestoring) was implemented anyway, per
// explicit instruction, because restore never legitimately needs to write to
// the store it's only applying — but if round 5 shows the leak survives that
// fix too, F7 is very likely a red herring and the real mechanism is
// something this headless model can't see (candidates recorded in the
// README: real packaged-app fromJSON() load-path differences, React
// re-render/StrictMode timing, or a live click sequence that differs from
// what's modeled here).

const JSDOM_ENTRY =
  "/Users/pieroherrera/Projects/t3code-fork/node_modules/.pnpm/jsdom@30.0.1_@noble+hashes@2.2.0/node_modules/jsdom/lib/api.js";
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
  global.DragEvent = dom.window.MouseEvent; // jsdom has no real DragEvent; close enough for wiring
  global.getComputedStyle = dom.window.getComputedStyle;
  global.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  global.cancelAnimationFrame = (id) => clearTimeout(id);
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

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
  return createDockview(container, {
    createComponent: () => ({
      element: document.createElement("div"),
      init() {},
      dispose() {},
    }),
  });
}

/**
 * Builds one fresh dockview instance + store-equivalent + restore/record
 * wiring matching round 3's committed code EXACTLY (pre-round-4, no
 * suppression guard) — so each scenario starts from a clean slate and any
 * cross-scenario interference is impossible.
 */
function buildHarness() {
  const api = buildDockview();
  const byActivationKey = {};
  const activationKeyRef = { current: undefined };

  function recordActivePanelForKey(key, panelId) {
    if (key === undefined) return;
    console.log(`    [WRITE] byActivationKey[${key}] = ${panelId}`);
    byActivationKey[String(key)] = panelId;
  }

  // Mirrors restoreActivePanel.ts's activatePanelInItsGroup exactly:
  // group.api.setActive() BEFORE panel.api.setActive().
  function activatePanelInItsGroup(panel) {
    console.log(`  [RESTORE] group.api.setActive() panel=${panel.id} group=${panel.group.id}`);
    panel.group && panel.group.api.setActive();
    console.log(`  [RESTORE] panel.api.setActive() panel=${panel.id}`);
    panel.api.setActive();
  }
  function restoreActivePanelForKey(api, { rememberedPanelId, fallbackPanelId }) {
    if (rememberedPanelId !== null) {
      const panel = api.getPanel(rememberedPanelId);
      if (panel) {
        activatePanelInItsGroup(panel);
        return;
      }
    }
    if (fallbackPanelId !== undefined) {
      const panel = api.getPanel(fallbackPanelId);
      if (panel) activatePanelInItsGroup(panel);
    }
  }

  // Mirrors DockviewLayout.tsx's mount-effect wiring exactly (round 3: no
  // isRestoringRef guard yet).
  api.onDidActivePanelChange(({ panel }) => {
    console.log(`  (event) TOP-LEVEL fired panel=${panel && panel.id}`);
    recordActivePanelForKey(activationKeyRef.current, (panel && panel.id) || null);
  });
  function subscribeGroup(group) {
    group.api.onDidActivePanelChange(({ panel }) => {
      console.log(`  (event) GROUP[${group.id}] fired panel=${panel.id}`);
      recordActivePanelForKey(activationKeyRef.current, panel.id);
    });
  }

  function restoreForThread(key, fallbackId) {
    console.log(`\n=== switching to thread ${key} ===`);
    activationKeyRef.current = key;
    const remembered = byActivationKey[key] ?? null;
    console.log(`  remembered for ${key}: ${remembered}`);
    restoreActivePanelForKey(api, { rememberedPanelId: remembered, fallbackPanelId: fallbackId });
  }

  return { api, byActivationKey, subscribeGroup, restoreForThread };
}

function scenarioA_naturalSequence() {
  console.log("\n########## SCENARIO A: natural A -> B -> A sequence ##########");
  console.log(
    "A visits (falls back to chat), A clicks Files, B visits (falls back to chat), B clicks Diff, back to A.",
  );
  const { api, byActivationKey, subscribeGroup, restoreForThread } = buildHarness();

  const chat = api.addPanel({ id: "chat", component: "default" });
  const files = api.addPanel({
    id: "files",
    component: "default",
    position: { direction: "right" },
  });
  const diff = api.addPanel({
    id: "diff",
    component: "default",
    position: { referencePanel: "files", direction: "within" },
  });
  for (const g of api.groups) subscribeGroup(g);
  console.log(
    "Setup: groups =",
    api.groups.map((g) => g.id),
    "files.group === diff.group:",
    files.group === diff.group,
  );

  restoreForThread("A", "chat");
  console.log("\n--- A clicks Files ---");
  files.api.setActive();

  restoreForThread("B", "chat");
  console.log("\n--- B clicks Diff (shared group) ---");
  diff.api.setActive();

  restoreForThread("A", "chat");

  console.log("\n=== SCENARIO A FINAL ===");
  console.log("byActivationKey:", JSON.stringify(byActivationKey));
  console.log(
    "Live group[shared].activePanel:",
    files.group.activePanel && files.group.activePanel.id,
  );
  console.log("Live api.activePanel:", api.activePanel && api.activePanel.id);
  const pass = byActivationKey.A === "files" && api.activePanel && api.activePanel.id === "files";
  console.log(pass ? "RESULT: correct (files)" : "RESULT: LEAK REPRODUCED");
  return pass;
}

function scenarioB_focusLeavesSharedGroupBeforeFinalRestore() {
  console.log(
    "\n########## SCENARIO B: focus leaves the shared group before the final restore (triggers F7) ##########",
  );
  console.log(
    "Same as A, but B ALSO clicks the Chat tab after Diff — so when A's restore runs, the shared group is NOT dockview's active group, which is what makes panel.group.api.setActive() transiently re-fire the top-level event with the group's OLD panel (F7).",
  );
  const { api, byActivationKey, subscribeGroup, restoreForThread } = buildHarness();

  const chat = api.addPanel({ id: "chat", component: "default" });
  const files = api.addPanel({
    id: "files",
    component: "default",
    position: { direction: "right" },
  });
  const diff = api.addPanel({
    id: "diff",
    component: "default",
    position: { referencePanel: "files", direction: "within" },
  });
  for (const g of api.groups) subscribeGroup(g);

  restoreForThread("A", "chat");
  console.log("\n--- A clicks Files ---");
  files.api.setActive();

  restoreForThread("B", "chat");
  console.log("\n--- B clicks Diff (shared group) ---");
  diff.api.setActive();
  console.log("\n--- B ALSO clicks Chat tab afterward ---");
  chat.api.setActive();

  restoreForThread("A", "chat");

  console.log("\n=== SCENARIO B FINAL ===");
  console.log("byActivationKey:", JSON.stringify(byActivationKey));
  console.log(
    "Live group[shared].activePanel:",
    files.group.activePanel && files.group.activePanel.id,
  );
  console.log("Live api.activePanel:", api.activePanel && api.activePanel.id);
  const pass = byActivationKey.A === "files" && api.activePanel && api.activePanel.id === "files";
  console.log(
    pass ? "RESULT: correct (files) — F7 fired but self-corrected" : "RESULT: LEAK REPRODUCED",
  );
  return pass;
}

setupJsdomGlobals();
const results = [scenarioA_naturalSequence(), scenarioB_focusLeavesSharedGroupBeforeFinalRestore()];
console.log("\n\n================ SUMMARY ================");
console.log(
  `Scenario A (natural sequence):                    ${results[0] ? "PASS (no leak)" : "FAIL (leak)"}`,
);
console.log(
  `Scenario B (focus leaves group, triggers F7):     ${results[1] ? "PASS (no leak)" : "FAIL (leak)"}`,
);
console.log(
  results.every(Boolean)
    ? "\nNeither scenario reproduces a persisting leak against round-3 code (pre-suppression-guard) — F7's transient self-corrects in both."
    : "\nAt least one scenario reproduced a persisting leak — investigate further.",
);
