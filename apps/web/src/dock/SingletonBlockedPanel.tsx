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
 *
 * Copy revised after review: the first draft ("Close this tab, or use it
 * from its existing tab") named an action without saying where the real
 * tab IS or whether closing is even available — someone who hits this has
 * no other context for what just happened. Rewritten to say what happened
 * (a real, live instance exists elsewhere in the SAME dock, under the same
 * name) and what to do about it (find that tab; closing this one, if the
 * tab strip lets you, is safe). Deliberately doesn't claim "close this tab"
 * unconditionally — whether THIS particular duplicate instance is
 * closeable depends on how it got added (a stray "Add tab" click leaves it
 * closeable; a corrupted saved layout entry might not be), so the copy
 * only promises what's actually true either way.
 */
export function SingletonBlockedPanel({ title }: SingletonBlockedPanelProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 overflow-auto p-6 text-center">
      <span className="flex size-10 items-center justify-center rounded-full bg-destructive/10 text-destructive">
        <Ban size={20} strokeWidth={1.75} />
      </span>
      <p className="text-sm font-medium text-foreground">{title} is already open</p>
      <p className="max-w-xs text-xs text-muted-foreground">
        Only one {title} panel can be open at a time, and this isn't the live one — look for another
        tab also named "{title}" elsewhere in this dock; that's the one with real content. If this
        tab has a close (×) control, closing it is safe and won't affect the other.
      </p>
    </div>
  );
}
