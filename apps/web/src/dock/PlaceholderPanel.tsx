// New for step 1 (spec-dock-step-1.md) — not a port.
//
// The spec's non-goals are explicit: "Do not port any panel components...
// The second panel in step 1 is a placeholder, nothing more." Rather than
// port the source's `PanelPlaceholder.tsx` (a generic catalog-decoration
// component driven by a `CatalogEntryConfig` this fork's catalog.tsx-cut
// port has no equivalent of), this is a small bespoke component: exactly
// one placeholder, for exactly one panel, using this fork's own tokens.
import { LayoutDashboard } from "lucide-react";

/**
 * Second panel content for step 1's chat dock. Exists to prove the dock is
 * a real two-panel dock (a splitter with something real on both sides), not
 * to demonstrate any panel content of its own — see acceptance check 2 in
 * spec-dock-step-1.md.
 */
export function PlaceholderPanel() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground">
      <LayoutDashboard size={20} strokeWidth={1.75} aria-hidden="true" />
      <p className="text-sm font-medium text-foreground">Second panel</p>
      <p className="max-w-xs text-xs text-muted-foreground">
        Reserved for a future panel. Drag the splitter to resize it against the chat panel.
      </p>
    </div>
  );
}
