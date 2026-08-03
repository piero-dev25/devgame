// Ported from gamedev-workbench's
// app/web/src/components/layout/LayoutNotice.tsx.
//
// Two changes from the source (spec-dock-step-1.md corrections 2 and the
// mechanical sweep #3):
//  1. `IconButton` (../ui/IconButton.tsx in source) is not part of the
//     layout system and is saturated with source-only `@theme` utilities
//     (`rounded-control`, `ease-wb`, `text-text-muted`, …) that don't exist
//     here — replaced with this fork's own `Button` primitive
//     (`~/components/ui/button`), `variant="ghost" size="icon-xs"`.
//  2. Tailwind classes rewritten onto this fork's semantic tokens: the
//     source's `warn` tier (border-warn/30, bg-warn-soft, text-warn) becomes
//     `destructive` (border-destructive/30, bg-destructive/10,
//     text-destructive) — this fork has no separate warning tier, and
//     PanelErrorBoundary.tsx/QuarantinePanel.tsx (ported alongside this
//     file) already establish `destructive` as where source's
//     warn/danger-family colours land. Kept as a fully-tinted bar (bg +
//     border + text, not just the icon) to preserve the source's "this
//     needs attention" visual weight rather than flattening it to a neutral
//     `bg-card` banner.
import { TriangleAlert, X } from "lucide-react";

import { Button } from "~/components/ui/button";

export interface LayoutNoticeProps {
  message: string;
  onDismiss: () => void;
}

/**
 * The dismissible notice shown whenever a saved layout couldn't be used
 * as-is — corrupted/unparseable, a schema version this build doesn't
 * understand, or a panel type no longer in the catalog. Always names the
 * file/reason so the notice is actionable, not just alarming.
 */
export function LayoutNotice({ message, onDismiss }: LayoutNoticeProps) {
  return (
    <div
      role="status"
      data-testid="layout-notice"
      className="flex items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-3 py-1.5 text-xs text-destructive"
    >
      <TriangleAlert size={14} strokeWidth={2} className="shrink-0" />
      <p className="min-w-0 flex-1">{message}</p>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Dismiss notice"
        onClick={onDismiss}
        className="text-destructive hover:bg-destructive/15 hover:text-destructive"
      >
        <X size={14} strokeWidth={2} />
      </Button>
    </div>
  );
}
