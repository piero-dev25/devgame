import type { DockviewApi } from "dockview";

import { selectActivePanelForKey } from "~/dockActiveSelectionStore";

/**
 * The core decision behind restoring a thread's remembered dock selection
 * (task #108, "dock tab selection leaks across chats") — extracted the same
 * way `openPanel.ts`'s functions are, since this repo has no jsdom/mounted-
 * component test infra to drive `DockviewLayout`'s own effects end-to-end
 * (see that file's module doc, and `openPanel.ts`'s own doc comment).
 *
 * Root cause this closes: `DockviewLayout.tsx`'s persisted layout
 * (`ChatDock.tsx`'s `CHAT_DOCK_WORKSPACE_ID`) is deliberately ONE shared blob
 * across every thread — correct for the split/arrangement, but dockview's
 * `activeGroup`/per-group `activeView` travel in that SAME blob, so "which
 * tab is front-most" inherited a global scope it never should have. This
 * function is what gives selection its own, per-thread answer instead.
 *
 * Prefers the remembered panel — but ONLY when it's still actually open in
 * the LIVE layout right now (a thread whose remembered panel was since
 * closed, e.g. the user closed Diff entirely, has nothing meaningful left to
 * restore to) — falling back to `fallbackPanelId` (the caller's
 * `activateOnChangeId`, e.g. always Chat) exactly when there's nothing
 * better. That fallback is what keeps fix-round finding #5's original
 * guarantee ("a thread switch always shows you something relevant, never a
 * stale leftover panel") true for a thread with no remembered selection yet
 * — a brand-new thread falls straight through to the same behaviour that
 * existed before this fix.
 */
export function restoreActivePanelForKey(
  api: DockviewApi,
  {
    rememberedPanelId,
    fallbackPanelId,
  }: { rememberedPanelId: string | null; fallbackPanelId?: string },
): void {
  if (rememberedPanelId !== null) {
    const panel = api.getPanel(rememberedPanelId);
    if (panel) {
      panel.api.setActive();
      return;
    }
  }
  if (fallbackPanelId !== undefined) {
    api.getPanel(fallbackPanelId)?.api.setActive();
  }
}

/**
 * Combines `selectActivePanelForKey` (dockActiveSelectionStore.ts) with
 * `restoreActivePanelForKey` above into the ONE decision `DockviewLayout.tsx`
 * needs at BOTH of its call sites — the activation-key-change effect (a
 * thread switch on an already-mounted dock) and `loadInitialLayout`'s own
 * post-mount correction (F3, 2026-08-05 merge-gate review: neither
 * `api.fromJSON(...)` nor `applyPreset`'s own `fromJSON` know about
 * per-thread selection — they apply whatever `activeGroup`/`activeView` the
 * shared layout blob or the static preset happened to carry — so the dock's
 * initial mount needs the identical correction a later thread switch
 * already gets, or the very first thread shown after a reload never has its
 * remembered selection applied).
 *
 * Extracted here (not left as a component-local closure) specifically so
 * BOTH the `String(activationKey)` conversion and the `undefined` guard —
 * neither previously exercised by a test, since the pre-F3 test suite only
 * ever called `restoreActivePanelForKey` with an already-computed
 * `rememberedPanelId` — have one tested home instead of two untested
 * inline copies.
 *
 * `activationKey === undefined` (no thread yet) is a silent no-op, matching
 * `DockviewLayout.tsx`'s own `onDidActivePanelChange` write-side guard for
 * the identical case.
 */
export function restoreActivePanelForThread(
  api: DockviewApi,
  {
    byActivationKey,
    activationKey,
    fallbackPanelId,
  }: {
    byActivationKey: Record<string, string>;
    activationKey: string | number | undefined;
    fallbackPanelId?: string;
  },
): void {
  if (activationKey === undefined) return;
  const rememberedPanelId = selectActivePanelForKey(byActivationKey, String(activationKey));
  restoreActivePanelForKey(api, {
    rememberedPanelId,
    ...(fallbackPanelId !== undefined ? { fallbackPanelId } : {}),
  });
}
