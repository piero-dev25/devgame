// docs/specs/unified-topband.md, Section A: the ONE helper computing the
// unified top band's structural facts, pure and DOM-free (like every other
// helper in this directory — see `openPanel.ts`'s own doc comment on why:
// this repo has no jsdom/mounted-component test infra, so anything worth
// asserting against gets extracted to something callable from a plain
// object literal instead).
//
// DockviewLayout.tsx calls this from an `onDidLayoutChange` subscription
// with `api.groups.map((g) => ({ id: g.id, boundingBox: g.api.boundingBox
// }))` — `boundingBox` is `DockviewGroupPanelApiImpl.boundingBox`
// (dockview-core@7.0.4's installed dist/esm, api/dockviewGroupPanelApi.js),
// dockview-root-relative `{left, top, width, height}`, `undefined` for a
// popout group (a real case this helper must tolerate, not just the
// "no groups at all" case — see the "hidden first group" fixture below).
export interface TopBandGroupInput {
  readonly id: string;
  readonly boundingBox:
    | {
        readonly left: number;
        readonly top: number;
        readonly width: number;
        readonly height: number;
      }
    | undefined;
}

export interface TopBandLayoutResult {
  /** Every group whose boundingBox.top === 0 — the row DockviewLayout.tsx
   * stamps `data-dv-topband` onto (via each group's `header.element`, the
   * `.dv-tabs-and-actions-container` node — dockviewGroupPanelModel.js's
   * `header` getter / tabsContainer.js's `_element.className`). */
  readonly topRowGroupIds: ReadonlySet<string>;
  /** The top-row group that ALSO owns (0,0) — left === 0 too — i.e. the
   * group the corner cell overlays. `null` when no group is at (0,0)
   * (including the empty-groups case). */
  readonly cornerOwnerGroupId: string | null;
  /** How much left padding the corner owner's tab strip needs to clear the
   * overlaid corner cell — `cornerWidthPx`, CAPPED at the owner's own
   * current width (NARROW-COLUMN RULE, critique M4) so a sashed-narrow
   * column's tab strip never renders fully off-canvas. `0` when there is no
   * corner owner. */
  readonly cornerPaddingPx: number;
}

export function computeTopBandLayout(
  groups: readonly TopBandGroupInput[],
  cornerWidthPx: number,
): TopBandLayoutResult {
  const topRowGroupIds = new Set<string>();
  let cornerOwner: TopBandGroupInput | null = null;

  for (const candidate of groups) {
    const box = candidate.boundingBox;
    // A popout (or not-yet-sized) group reports no boundingBox at all —
    // skip it rather than crash; it simply isn't part of the band.
    if (!box) continue;
    // Round-13 fix (real bug, owner screenshot): a hidden group
    // (`group.api.setVisible(false)` — the sidebar-toggle mechanism) is NOT
    // `boundingBox === undefined`. It's a REAL box: verified against the
    // installed dockview-core@7.0.4's own splitview.js#layoutViews, a
    // hidden view's container gets `width: 0px` via inline style, while its
    // `left` offset is computed EXACTLY the same as if visible — for the
    // grid's index-0 item (the Sidebar), `offset` is unconditionally `0`
    // regardless of visibility. Critically, when index-0 is hidden, the
    // NEXT visible item ALSO gets `offset: 0` (nothing visible before it),
    // so the hidden Sidebar and the now-visible (0,0) group report
    // `left: 0` SIMULTANEOUSLY, live. Exclude zero-area boxes from BOTH
    // topRowGroupIds and corner-owner candidacy so the collision always
    // resolves to the group that's actually rendered.
    if (box.width <= 0 || box.height <= 0) continue;
    if (box.top !== 0) continue;
    topRowGroupIds.add(candidate.id);
    if (box.left === 0 && cornerOwner === null) {
      cornerOwner = candidate;
    }
  }

  const cornerPaddingPx =
    cornerOwner?.boundingBox === undefined
      ? 0
      : Math.min(cornerWidthPx, cornerOwner.boundingBox.width);

  return {
    topRowGroupIds,
    cornerOwnerGroupId: cornerOwner?.id ?? null,
    cornerPaddingPx,
  };
}
