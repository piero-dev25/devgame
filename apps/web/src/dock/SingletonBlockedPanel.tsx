// New for the step-1 review fix round — not a port. Rendered by
// DockviewLayout.tsx in place of a singleton panel's real content for every
// instance after the first (see lib/singletonGuard.ts for why this exists
// and where it's enforced).
import { Ban } from "lucide-react";

export interface SingletonBlockedPanelProps {
  /** The catalog panel's title, e.g. "Chat" or "Sidebar". */
  title: string;
}

/**
 * Same visual language as `QuarantinePanel.tsx`/`PanelErrorBoundary.tsx`
 * (centered icon badge + short explanation) for a THIRD "something's not
 * right with this tab, but the rest of the dock is fine" case: not an
 * unknown panel type, not a crash, but a second instance of a panel type
 * that only ever gets one. `bg-destructive/10 text-destructive` matches
 * those two files' token mapping — see QuarantinePanel.tsx's module doc for
 * the mapping rationale (this fork has no separate "warn" tier).
 */
export function SingletonBlockedPanel({ title }: SingletonBlockedPanelProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 overflow-auto p-6 text-center">
      <span className="flex size-10 items-center justify-center rounded-full bg-destructive/10 text-destructive">
        <Ban size={20} strokeWidth={1.75} />
      </span>
      <p className="text-sm font-medium text-foreground">{title} is already open</p>
      <p className="max-w-xs text-xs text-muted-foreground">
        This panel only allows one open instance at a time. Close this tab, or use{" "}
        {title.toLowerCase()} from its existing tab.
      </p>
    </div>
  );
}
