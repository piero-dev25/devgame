/**
 * Pure clamp/flip math for the floating label that follows the cursor while
 * the user is picking an element in the in-app browser. Lives in its own
 * electron-free module so the geometry can be unit-tested cheaply, without
 * a jsdom environment or an `electron` mock in the loop at all.
 *
 * CORRECTED (#89/#92, independent audit, 2026-08-04): this used to say
 * `PickPreload.ts` itself "can't load under vitest" because it imports
 * `electron` and `react-grab/primitives`. That was never actually tested —
 * it can: `vi.mock("electron", ...)` plus a per-file `@vitest-environment
 * jsdom` load and exercise it fully (see `PickPreload.test.ts`, which now
 * does). The real reason this file stays separate is unchanged and still
 * good: this geometry is pure, needs no DOM or IPC mock at all, and
 * splitting it out keeps ITS OWN tests running under the repo's default
 * plain-node environment rather than paying jsdom's setup cost for math
 * that never touches an Element.
 *
 * - Horizontally pins the label to `targetLeft`, clamped into
 *   `[VIEWPORT_MARGIN, viewportWidth - labelWidth - VIEWPORT_MARGIN]`.
 * - Vertically prefers above the target. If the label would overflow the
 *   top, flips below; if THAT also overflows the bottom, pins to the
 *   bottom margin (better to overlap the highlight than disappear).
 */

/** Distance in CSS pixels between the highlight and the floating label. */
export const LABEL_GAP = 4;
/** Minimum padding the label keeps from any viewport edge. */
export const VIEWPORT_MARGIN = 4;

export function computeLabelPosition(input: {
  targetLeft: number;
  targetTop: number;
  targetBottom: number;
  labelWidth: number;
  labelHeight: number;
  viewportWidth: number;
  viewportHeight: number;
}): { x: number; y: number } {
  const { targetLeft, targetTop, targetBottom, labelWidth, labelHeight } = input;
  const { viewportWidth, viewportHeight } = input;

  let x = targetLeft;
  const maxX = viewportWidth - labelWidth - VIEWPORT_MARGIN;
  if (x > maxX) x = maxX;
  if (x < VIEWPORT_MARGIN) x = VIEWPORT_MARGIN;

  let y = targetTop - labelHeight - LABEL_GAP;
  if (y < VIEWPORT_MARGIN) {
    y = targetBottom + LABEL_GAP;
    if (y + labelHeight > viewportHeight - VIEWPORT_MARGIN) {
      y = Math.max(VIEWPORT_MARGIN, viewportHeight - labelHeight - VIEWPORT_MARGIN);
    }
  }

  return { x, y };
}
