// Ported verbatim from gamedev-workbench's
// app/web/src/components/layout/reactTabRenderer.tsx. No relative imports,
// no app coupling.
import type { ITabRenderer, TabPartInitParameters } from "dockview";
import {
  ClipboardList,
  FileDiff,
  Files,
  Globe2,
  MessageSquare,
  PanelLeft,
  TerminalSquare,
  X,
  type LucideIcon,
} from "lucide-react";
import { createRoot, type Root } from "react-dom/client";

/**
 * KNOWN LIMITATION — tabs mount in their own React root, so **a tab component
 * cannot read app context**. This is the same wall that would break dock
 * panels if they mounted their own root too (panels avoid it by going
 * through `panelPortalStore.ts` + `createPortal` instead). Nothing is broken
 * today because `TabContent` below takes only title/showClose/onClose and
 * reads no context — but the first tab that wants a live value would throw
 * exactly the same way.
 *
 * Left as-is deliberately rather than fixed speculatively: tabs are
 * numerous, cheap and re-rendered by dockview on its own schedule, so
 * porting them to portals is a real design question, not a copy of the
 * panel change. Recorded here so it is found by reading rather than by
 * debugging.
 *
 * `TabContent` still honours that boundary: it takes title/icon/showClose/
 * onClose and reads no context. The icon is looked up from the panel id —
 * available on `params.api` — precisely so adding it did not require
 * crossing this wall. The first tab wanting a genuinely LIVE value (the
 * browser favicon is the known one) would still throw exactly as described.
 */

/**
 * Per-panel tab icons, deliberately reusing the vocabulary of the right-panel
 * tab strip these panels replaced (`RightPanelTabs.tsx`) — same lucide glyphs
 * for the same surfaces, so a Terminal tab reads as a Terminal tab wherever it
 * is docked. Without this the dock rendered dockview's stock text-only tab,
 * which the owner correctly called out as a downgrade from the strip.
 *
 * Keyed by panel id, which a tab CAN read (`params.api.id`) without app
 * context — so this stays inside the boundary documented above rather than
 * forcing the portal refactor. `sidebar`/`chat` come from ChatDock.tsx;
 * `diff`/`files` from chatDockHandle.ts; the rest are the surfaces still
 * queued to migrate.
 *
 * An unrecognised id renders NO icon rather than a placeholder one. A missing
 * icon is merely plain; a wrong icon actively misinforms.
 *
 * STILL OPEN — the browser surface: the old strip showed a LIVE FAVICON per
 * page with `Globe2` only as the load-failure fallback. That needs live
 * per-surface state, which is exactly what a tab cannot reach from its own
 * React root. `Globe2` here is the honest static floor, not the finished
 * treatment; the favicon needs the icon resolved outside and passed in.
 */
const PANEL_TAB_ICONS: Readonly<Record<string, LucideIcon>> = {
  sidebar: PanelLeft,
  chat: MessageSquare,
  diff: FileDiff,
  files: Files,
  terminal: TerminalSquare,
  preview: Globe2,
  plan: ClipboardList,
};

interface TabContentProps {
  title: string;
  icon: LucideIcon | undefined;
  showClose: boolean;
  onClose: () => void;
}

function TabContent({ title, icon: Icon, showClose, onClose }: TabContentProps) {
  return (
    <div className="dv-default-tab-content">
      {/* No colour class: the icon inherits the tab's own text colour, so the
          active/inactive/hover tokens in dockviewTheme.css drive it for free.
          Layout needs no CSS either — `.dv-default-tab-content` is already
          `display:flex` with `gap:6px`. */}
      {Icon ? <Icon size={14} strokeWidth={2} className="shrink-0" /> : null}
      <span className="truncate">{title}</span>
      {showClose ? (
        <button
          type="button"
          className="dv-default-tab-action"
          aria-label={`Close ${title}`}
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
        >
          <X size={12} strokeWidth={2} />
        </button>
      ) : null}
    </div>
  );
}

/**
 * A dockview tab renderer built to look exactly like dockview's own
 * `DefaultTab` (same `.dv-default-tab-content`/`.dv-default-tab-action`
 * classes, so `dockviewTheme.css`'s tab styling applies unchanged) except
 * the close (×) control is conditional. Step 1's two panels both use the
 * no-close variant (see ChatDock.tsx) — see that file for why.
 */
export function createReactTabRenderer(showClose: boolean): ITabRenderer {
  const element = document.createElement("div");
  element.className = "dv-default-tab";

  let root: Root | null = null;

  return {
    element,
    init(params: TabPartInitParameters) {
      root = createRoot(element);
      root.render(
        <TabContent
          title={params.title}
          icon={PANEL_TAB_ICONS[params.api.id]}
          showClose={showClose}
          onClose={() => params.api.close()}
        />,
      );
    },
    dispose() {
      // Fix-round finding #5 (step-1 review): this used to point at
      // reactContentRenderer.tsx "for why this unmount is deferred a
      // microtask" — that file never explained it (it doesn't own a React
      // root at all; its own doc comment only notes that ITS OLD
      // microtask-deferred-unmount workaround is GONE, since the portal
      // refactor removed the hazard it guarded). The dangling reference
      // predates that refactor; here is the reasoning it used to point to,
      // stated directly: calling `root.unmount()` synchronously from inside
      // dockview-core's own `dispose()` callback can run while THIS app's
      // React tree is mid-commit elsewhere (dockview disposing a tab is not
      // itself a React event) — unmounting a root synchronously in that
      // window is the "don't unmount mid-commit" hazard. Deferring to a
      // microtask lets the current call stack (and any in-flight commit)
      // finish first.
      const current = root;
      root = null;
      if (current) queueMicrotask(() => current.unmount());
    },
  };
}
