// Ported from gamedev-workbench's
// app/web/src/components/layout/PanelErrorBoundary.tsx. Tailwind classes
// rewritten onto this fork's semantic tokens — see QuarantinePanel.tsx's
// module doc for the same mapping (`bg-danger-soft text-danger` here maps
// onto `bg-destructive/10 text-destructive` even more directly, since
// "danger" and "destructive" are the same concept under different names).
import { TriangleAlert } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";

interface PanelErrorBoundaryProps {
  /** The catalog panel's title, shown in the quarantine card. */
  panelTitle: string;
  children: ReactNode;
}

interface PanelErrorBoundaryState {
  error: Error | null;
}

/**
 * Contains a panel's own render/lifecycle crash to its own tab: "a panel
 * that throws should render a quarantine card inside its own tab, the same
 * discipline as an unknown panel type. One bad panel taking down the whole
 * workspace would be the worst possible failure mode for a dockable app."
 * Wired once, in `PanelPortalContent` (DockviewLayout.tsx), around every
 * panel's content — no catalog entry has to remember to wrap itself. It
 * wraps BOTH arms there: the registered component AND the `QuarantinePanel`
 * fallback, so an unknown panel id or an `undefined` component quarantines
 * too instead of escaping to the app root, which has no boundary above it.
 *
 * Must be a class component: React has no hook-based error boundary API.
 */
export class PanelErrorBoundary extends Component<
  PanelErrorBoundaryProps,
  PanelErrorBoundaryState
> {
  override state: PanelErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): PanelErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error(`Panel "${this.props.panelTitle}" crashed:`, error, info.componentStack);
  }

  override render() {
    const { error } = this.state;
    if (!error) {
      return this.props.children;
    }

    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 overflow-auto p-6 text-center">
        <span className="flex size-10 items-center justify-center rounded-full bg-destructive/10 text-destructive">
          <TriangleAlert size={20} strokeWidth={1.75} />
        </span>
        <p className="text-sm font-medium text-foreground">
          {this.props.panelTitle} couldn't render
        </p>
        <p className="max-w-xs font-mono text-[10px] text-muted-foreground">
          {error.message || "An unexpected error occurred."}
        </p>
      </div>
    );
  }
}
