// Ported verbatim from gamedev-workbench's
// app/web/src/components/layout/reactTabRenderer.tsx. No relative imports,
// no app coupling.
import type { ITabRenderer, TabPartInitParameters } from "dockview";
import { X } from "lucide-react";
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
 */

interface TabContentProps {
  title: string;
  showClose: boolean;
  onClose: () => void;
}

function TabContent({ title, showClose, onClose }: TabContentProps) {
  return (
    <div className="dv-default-tab-content">
      <span>{title}</span>
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
          showClose={showClose}
          onClose={() => params.api.close()}
        />,
      );
    },
    dispose() {
      // See reactContentRenderer.tsx for why this unmount is deferred a microtask.
      const current = root;
      root = null;
      if (current) queueMicrotask(() => current.unmount());
    },
  };
}
