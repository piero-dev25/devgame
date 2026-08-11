/**
 * Task #109 (finding 2 of 2 — "hidden panes stay in the accessibility
 * tree"): dockview's OWN maximize mechanism (`api.maximizeGroup`,
 * `gridview.js`'s `hideAllViewsBut`) hides every other group by toggling a
 * `visible` class and collapsing layout size to zero — it does NOT set
 * `aria-hidden`/`inert`, and a zero-size element is not reliably excluded
 * from the accessibility tree the way `display:none`/`visibility:hidden`
 * are. Confirmed by an accessibility-tree-reading QA driver, not a visual
 * pass — a purely visual check would never have caught this, since sighted
 * users genuinely can't see or reach the hidden panes either way.
 *
 * Deliberately NOT reaching into dockview's private internals: `.element`
 * and `.id` are both PUBLIC surface on `DockviewGroupPanel` (what
 * `api.groups` yields), the same object `tabContextMenu.ts` already reads
 * `.api.isMaximized()` off of. This function only ever touches attributes
 * WE set, never anything dockview itself manages.
 */
export interface MaximizableGroup {
  readonly id: string;
  readonly element: {
    readonly setAttribute: (name: string, value: string) => void;
    readonly removeAttribute: (name: string) => void;
  };
}

/**
 * `inert` (not just `aria-hidden`) so a hidden pane is also unfocusable and
 * unclickable, not merely invisible to assistive tech — a maximized group
 * hiding its siblings should mean genuinely "not here right now" for
 * keyboard/pointer navigation too, matching what sighted users already
 * experience (those panes render at zero size, unreachable by mouse).
 * Paired rather than either alone: `aria-hidden` is the belt for AT that
 * doesn't respect `inert`, `inert` is the suspenders for keyboard/pointer
 * reachability `aria-hidden` alone doesn't cover.
 */
export function applyMaximizedGroupAccessibility(
  groups: ReadonlyArray<MaximizableGroup>,
  maximizedGroupId: string | null,
): void {
  for (const group of groups) {
    const shouldHide = maximizedGroupId !== null && group.id !== maximizedGroupId;
    if (shouldHide) {
      group.element.setAttribute("aria-hidden", "true");
      group.element.setAttribute("inert", "");
    } else {
      group.element.removeAttribute("aria-hidden");
      group.element.removeAttribute("inert");
    }
  }
}
