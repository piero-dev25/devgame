// Ported from gamedev-workbench's
// app/web/src/components/layout/QuarantinePanel.tsx. Tailwind classes
// rewritten onto this fork's semantic tokens (spec-dock-step-1.md's
// mechanical sweep #3) — see the module doc below for the mapping.
import { TriangleAlert } from "lucide-react";

export interface QuarantinePanelProps {
  /** The unrecognised `contentComponent` id from a saved layout. */
  componentId: string;
}

/**
 * Rendered for a panel type present in a saved layout but no longer in the
 * catalog: "Unknown panel type → quarantine card, never a crash". The panel
 * stays in the layout tree (so the user's arrangement isn't silently
 * rewritten) but renders this instead of crashing or vanishing.
 *
 * Token mapping (source `--wb-*` tokens don't exist here; this fork's own
 * tailwind theme does — see index.css's `@theme` block):
 *  - `bg-warn-soft text-warn` (icon badge) → `bg-destructive/10 text-destructive`.
 *    This fork has no separate "warn" tier, only "destructive" — used here
 *    the same way PanelErrorBoundary.tsx's source used `bg-danger-soft
 *    text-danger` for an almost identical badge, so this is consolidating
 *    two source tiers (warn/danger) onto the one this fork actually has.
 *  - `rounded-control` → `rounded-full`: the badge is a small icon circle,
 *    not a rectangular control, so a full circle reads correctly regardless
 *    of this fork's exact control-radius token value.
 *  - `text-text` (primary) → `text-foreground`.
 *  - `text-text-muted` / `text-text-dim` (two secondary tiers) →
 *    `text-muted-foreground` for both: this fork has only one muted tier.
 *  - `text-2xs` (a size tier below Tailwind's own smallest, defined in
 *    source's `@theme` block, which correction 5 forbids porting) → the
 *    arbitrary value `text-[10px]`, to keep the componentId line visually
 *    smaller than the description below it rather than collapsing both to
 *    the same `text-xs`.
 */
export function QuarantinePanel({ componentId }: QuarantinePanelProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 overflow-auto p-6 text-center">
      <span className="flex size-10 items-center justify-center rounded-full bg-destructive/10 text-destructive">
        <TriangleAlert size={20} strokeWidth={1.75} />
      </span>
      <p className="text-sm font-medium text-foreground">Unknown panel type</p>
      <p className="font-mono text-[10px] uppercase tracking-[0.07em] text-muted-foreground">
        {componentId}
      </p>
      <p className="max-w-xs text-xs text-muted-foreground">
        This panel isn't in the current catalog. It's kept in place so the rest of the layout stays
        intact — close it or reset to the default layout to remove it.
      </p>
    </div>
  );
}
