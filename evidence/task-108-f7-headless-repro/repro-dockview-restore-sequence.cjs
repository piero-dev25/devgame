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
// WHAT IT FOUND (scenarios A/B, round 4): F7 (the transient wrong top-level
// fire during `panel.group.api.setActive()`, carrying the group's OLD active
// panel) is REAL — see "group.api.setActive(): TOP-LEVEL fired" lines in
// scenario B's output below. But in EVERY scenario this script could
// construct, that transient is synchronously superseded within the SAME call
// by dockview-core's own guarded re-broadcast once the group becomes active
// — the store's FINAL value always comes out correct. This script did NOT
// reproduce round 4's persisting live leak. The suppression fix
// (isRestoringRef / recordActivePanelForKeyUnlessRestoring) was implemented
// anyway, per explicit instruction, because restore never legitimately needs
// to write to the store it's only applying.
//
// Round 5/6: the ACTUAL round-4/5 leak turned out to be a completely
// different mechanism (F7 was a red herring) — the thread-list sidebar is
// itself a dock panel, so navigating threads fired a real, unsuppressed
// panel activation misattributed to the OUTGOING thread's key. Fixed in
// 07a031926 (CHROME_PANEL_IDS). See
// evidence/task-108-round6-sidebar-diagnosis/ for that full diagnosis — this
// script's scenarios A/B never modeled a sidebar panel at all, which is
// exactly why they couldn't have caught it.
//
// WHAT IT FOUND (scenario C, round 7): round 6's fix gated CLEAN on all four
// pre-registered live criteria, but an ungated micro-replay found a STABLE
// residual in exactly one shape: A(click Files) -> B(click Diff) ->
// A(restored, PASS) -> B(restored, not clicked, PASS) -> A(restored AGAIN,
// FAIL — shows Diff, expected Files). The suspected mechanism: a real tab
// click and `restoreActivePanelForKey`'s `panel.api.setActive()` chain are
// NOT the same dockview-core code path (traced in dockview-core's own
// `tab.js`: a real click's `onPointerDown` calls
// `group.model.openPanel(panel)` DIRECTLY, with no separate
// `group.api.setActive()` wrapping it — confirmed this app's custom tab
// renderer doesn't change that, since `createTabComponent` only supplies
// content MOUNTED INSIDE dockview-core's own clickable `.dv-tab` element).
// Scenario C models BOTH paths distinctly (`realTabClick` vs
// `activatePanelInItsGroupWithSuppression`), models the sidebar as a real
// panel this time (the round-6 gap), and inspects ACTUAL DOM connectivity
// via tagged `[data-panel]` elements — not just `group.activePanel`, since
// dockview-core's `ContentContainer` tracks "currently rendered panel" as
// its OWN separate piece of state that could in principle diverge from the
// group model's `_activePanel`.
//
// RESULT: scenario C did NOT reproduce the round-7 residual — all three
// gated steps pass, model AND DOM agree at every checkpoint. This headless
// harness has now failed to reproduce TWO real, live-confirmed bugs (the
// sidebar-attribution leak, until it modeled the sidebar; and now this).
// The next most likely structural gap: this harness's panels are trivial
// synchronous DOM elements (`{element, init(), dispose()}`) with no React
// involved at all, while the real app's panel content mounts via React
// portals (`createReactContentRenderer` + `panelPortalStore.ts`). If a
// diagnostic-build loop shows the LIVE dockview-core model itself is already
// wrong at step 7 (not just the screen), the bug is inside dockview-core
// under conditions this harness still doesn't create. If the live MODEL is
// correct but the SCREEN is wrong, the bug is in the React portal rendering
// layer, which is entirely outside what dockview-core-only headless testing
// can ever reach.

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
    // Tags each panel's content element with data-panel="<id>" so scenario C
    // can inspect ACTUAL DOM presence (element.isConnected) after each step
    // — not just group.activePanel, which is model-level bookkeeping that
    // can diverge from what's really mounted (see ContentContainer.openPanel's
    // `this.panel === panel` guard in dockview-core's content.js: it tracks
    // "currently rendered panel" as a SEPARATE piece of state from the group
    // model's own `_activePanel`).
    createComponent: (options) => {
      const element = document.createElement("div");
      element.setAttribute("data-panel", options.id);
      return { element, init() {}, dispose() {} };
    },
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

/**
 * Task #108, round 6 verification / round 7 investigation — a faithful
 * `activatePanelInItsGroup` used by scenarios that ALSO need round 4's
 * suppression guard modeled (isRestoring), since scenario C exercises a
 * sequence where the write side must NOT record during restore, exactly
 * like the shipped code (commit eebb4c322 + 07a031926).
 */
function activatePanelInItsGroupWithSuppression(panel, isRestoringRef) {
  console.log(`  [RESTORE] group.api.setActive() panel=${panel.id} group=${panel.group.id}`);
  isRestoringRef.current = true;
  try {
    panel.group && panel.group.api.setActive();
    console.log(`  [RESTORE] panel.api.setActive() panel=${panel.id}`);
    panel.api.setActive();
  } finally {
    isRestoringRef.current = false;
  }
}

/**
 * Task #108, round 6/7: what a REAL tab click does, traced against
 * dockview-core@7.0.4's own source — NOT the same code path as
 * `panel.api.setActive()`. `tab.js`'s `onPointerDown` handler (the actual
 * click listener on dockview-core's own `.dv-tab` element — this app's
 * custom `createTabComponent` only supplies the CONTENT mounted inside that
 * element, confirmed via `reactTabRenderer.tsx` + `Tab.setContent`, so real
 * clicks in the real app go through this exact dockview-core path) calls
 * `this.group.model.openPanel(panel)` DIRECTLY for a non-edge (regular grid)
 * group — no separate "activate the group" call wraps it, unlike
 * `activatePanelInItsGroup`'s `group.api.setActive()` THEN
 * `panel.api.setActive()`. `openPanel`'s OWN internal
 * `accessor.doSetGroupActive(this.groupPanel)` call, at the END of its own
 * body, is the only group-activation that happens for a real click.
 */
function realTabClick(panel) {
  console.log(`  [REAL CLICK] group.model.openPanel() panel=${panel.id}`);
  panel.group.model.openPanel(panel);
}

/** Every `[data-panel]` element currently connected to the live DOM tree — what's ACTUALLY rendered, independent of any model-level bookkeeping. */
function connectedPanelElements() {
  return Array.from(document.querySelectorAll("[data-panel]"))
    .filter((el) => el.isConnected)
    .map((el) => el.getAttribute("data-panel"));
}

function logDomVsModel(sharedGroup, label) {
  console.log(
    `  [STATE ${label}] model group.activePanel=${sharedGroup.activePanel && sharedGroup.activePanel.id} | DOM-connected [data-panel]=${JSON.stringify(connectedPanelElements())}`,
  );
}

/**
 * Task #108, round 6 gate result + round 7 residual: all four gated returns
 * PASSED live (A/files, B/diff at every gated switch). But an UNGATED
 * micro-replay with settle time found a STABLE fail in exactly one shape:
 * A -> click Files -> B -> click Diff -> [A, restored, PASS] -> [B,
 * RESTORED not clicked, PASS] -> [A, restored, FAIL: shows Diff, expected
 * Files]. The discriminating variable: step 5 (pass) follows a CLICK-driven
 * activation in B; step 7 (fail) follows a RESTORE-driven activation in B.
 *
 * This scenario models that exact 7-step sequence with the SIDEBAR as a
 * real panel/group (the modeling gap that hid round 6's bug — see that
 * round's evidence/README) and BOTH activation paths distinctly:
 * `realTabClick` for genuine clicks, `activatePanelInItsGroupWithSuppression`
 * (round 3's ordering + round 4's suppression) for restores. "Navigate to
 * thread" is modeled as a real click on the sidebar panel — round 6 traced
 * this as a genuine dockview panel/group activation, not a special case.
 */
function scenarioC_restoreThenRestoreAcrossThreads() {
  console.log(
    "\n########## SCENARIO C: A(click Files) -> B(click Diff) -> A(restore) -> B(restore) -> A(restore) ##########",
  );
  console.log(
    "Round-7 investigation: does TWO CONSECUTIVE restore-driven activations on the shared group (B's restore, then A's restore) diverge from a click-driven precedent?",
  );

  const api = buildDockview();
  const isRestoringRef = { current: false };
  const byActivationKey = {};
  const activationKeyRef = { current: undefined };

  // Round 6's CHROME_PANEL_IDS filter, modeled faithfully on both sides.
  const CHROME_PANEL_IDS = new Set(["sidebar"]);

  function recordActivePanelForKeyUnlessRestoring(key, panelId) {
    if (isRestoringRef.current) return;
    if (panelId !== null && CHROME_PANEL_IDS.has(panelId)) return;
    if (key === undefined) return;
    console.log(`    [WRITE] byActivationKey[${key}] = ${panelId}`);
    byActivationKey[String(key)] = panelId;
  }

  function restoreActivePanelForKey(api, { rememberedPanelId, fallbackPanelId }) {
    const effective =
      rememberedPanelId !== null && CHROME_PANEL_IDS.has(rememberedPanelId)
        ? null
        : rememberedPanelId;
    if (effective !== null) {
      const panel = api.getPanel(effective);
      if (panel) {
        activatePanelInItsGroupWithSuppression(panel, isRestoringRef);
        return;
      }
    }
    if (fallbackPanelId !== undefined) {
      const panel = api.getPanel(fallbackPanelId);
      if (panel) activatePanelInItsGroupWithSuppression(panel, isRestoringRef);
    }
  }

  api.onDidActivePanelChange(({ panel }) => {
    console.log(`  (event) TOP-LEVEL fired panel=${panel && panel.id}`);
    recordActivePanelForKeyUnlessRestoring(activationKeyRef.current, (panel && panel.id) || null);
  });
  function subscribeGroup(group) {
    group.api.onDidActivePanelChange(({ panel }) => {
      console.log(`  (event) GROUP[${group.id}] fired panel=${panel.id}`);
      recordActivePanelForKeyUnlessRestoring(activationKeyRef.current, panel.id);
    });
  }

  function navigateToThread(key, fallbackId) {
    console.log(`\n=== navigate (real sidebar click) to thread ${key} ===`);
    // Round 6's actual mechanism: a real click WITHIN the sidebar panel's
    // content activates the sidebar's own group — modeled here as a real
    // click on the sidebar panel itself (round 6 established this is a
    // genuine group/panel activation, not a special-cased event).
    realTabClick(sidebar);
    activationKeyRef.current = key;
    const remembered = byActivationKey[key] ?? null;
    console.log(`  remembered for ${key}: ${remembered}`);
    restoreActivePanelForKey(api, { rememberedPanelId: remembered, fallbackPanelId: fallbackId });
  }

  const sidebar = api.addPanel({
    id: "sidebar",
    component: "default",
    position: { direction: "left" },
  });
  const chat = api.addPanel({
    id: "chat",
    component: "default",
    position: { referencePanel: sidebar.id, direction: "right" },
  });
  const files = api.addPanel({
    id: "files",
    component: "default",
    position: { referencePanel: chat.id, direction: "right" },
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
  const sharedGroup = files.group;

  navigateToThread("A", "chat");
  console.log("\n--- A: REAL CLICK Files ---");
  realTabClick(files);
  logDomVsModel(sharedGroup, "after A clicks Files");

  navigateToThread("B", "chat");
  console.log("\n--- B: REAL CLICK Diff ---");
  realTabClick(diff);
  logDomVsModel(sharedGroup, "after B clicks Diff");

  console.log("\n--- step 5: navigate back to A (restore-driven, click precedent in B) ---");
  navigateToThread("A", "chat");
  logDomVsModel(sharedGroup, "after step 5 (A restore)");
  const step5Pass =
    connectedPanelElements().includes("files") && sharedGroup.activePanel?.id === "files";
  console.log(step5Pass ? "  step 5: PASS (files)" : "  step 5: FAIL");

  console.log("\n--- step 6: navigate back to B (RESTORE-driven — no click on Diff this time) ---");
  navigateToThread("B", "chat");
  logDomVsModel(sharedGroup, "after step 6 (B restore)");
  const step6Pass =
    connectedPanelElements().includes("diff") && sharedGroup.activePanel?.id === "diff";
  console.log(step6Pass ? "  step 6: PASS (diff)" : "  step 6: FAIL");

  console.log(
    "\n--- step 7: navigate back to A AGAIN (restore-driven precedent from step 6 — the reported failure shape) ---",
  );
  navigateToThread("A", "chat");
  logDomVsModel(sharedGroup, "after step 7 (A restore, 2nd time)");
  const step7Pass =
    connectedPanelElements().includes("files") && sharedGroup.activePanel?.id === "files";
  console.log(
    step7Pass ? "  step 7: PASS (files)" : "  step 7: FAIL — matches the live-reported residual",
  );

  console.log("\n=== SCENARIO C FINAL ===");
  console.log("byActivationKey:", JSON.stringify(byActivationKey));
  console.log(
    "Live group[shared].activePanel:",
    sharedGroup.activePanel && sharedGroup.activePanel.id,
  );
  console.log("DOM-connected [data-panel]:", JSON.stringify(connectedPanelElements()));

  const allPass = step5Pass && step6Pass && step7Pass;
  console.log(
    allPass
      ? "RESULT: all three gated steps pass — scenario C did NOT reproduce the live residual headlessly."
      : "RESULT: REPRODUCED — see which step(s) failed above.",
  );
  return allPass;
}

setupJsdomGlobals();
const results = [
  scenarioA_naturalSequence(),
  scenarioB_focusLeavesSharedGroupBeforeFinalRestore(),
  scenarioC_restoreThenRestoreAcrossThreads(),
];
console.log("\n\n================ SUMMARY ================");
console.log(
  `Scenario A (natural sequence):                    ${results[0] ? "PASS (no leak)" : "FAIL (leak)"}`,
);
console.log(
  `Scenario B (focus leaves group, triggers F7):     ${results[1] ? "PASS (no leak)" : "FAIL (leak)"}`,
);
console.log(
  `Scenario C (restore-then-restore, round 7):       ${results[2] ? "PASS (no leak)" : "FAIL (leak)"}`,
);
console.log(
  results.every(Boolean)
    ? "\nAll three scenarios pass headlessly — if the live residual persists, it's something this jsdom model still can't see (real Chromium rendering/layout timing is the next suspect)."
    : "\nAt least one scenario reproduced a leak — investigate further using the [STATE]/[WRITE]/[REAL CLICK]/[RESTORE] trace above.",
);
