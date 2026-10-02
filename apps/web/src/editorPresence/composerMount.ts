/**
 * Whether the composer mounts the editor-presence chip row.
 *
 * - Hidden while the composer is collapsed on mobile, resolving an approval,
 *   or answering pending user input: the same states that hide every other
 *   pre-input row in the composer.
 * - `engineChipState === "none"` (detection ran and the project is not a
 *   game) unmounts the row (no-engine-ui-for-non-game-projects spec, rev 2,
 *   Scope B).
 * - `"unknown"` deliberately stays mounted, so a project switch's in-flight
 *   window never re-mints the presence socket or flashes "connecting…"
 *   (critique F1).
 */
export function shouldMountEditorPresenceChips(input: {
  readonly composerCollapsedMobile: boolean;
  readonly approvalPending: boolean;
  readonly pendingUserInputCount: number;
  readonly engineChipState: string;
}): boolean {
  return (
    !input.composerCollapsedMobile &&
    !input.approvalPending &&
    input.pendingUserInputCount === 0 &&
    input.engineChipState !== "none"
  );
}
