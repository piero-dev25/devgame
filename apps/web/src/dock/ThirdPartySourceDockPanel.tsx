/**
 * Figma and Notion as a first-class dock panel — docs/workbench/
 * three-feature-decisions.md #4, owner ruling relayed 2026-08-04 ("Figma/
 * Notion should be a DOCK PANEL, registered the way DiffDockPanel and
 * FilesDockPanel are, with its own store").
 *
 * IDENTITY: unlike `DiffDockPanel`/`FilesDockPanel`, this panel resolves NO
 * thread identity at all — no `useParams`, no `ThreadRouteContext`. That's
 * not a missing piece; it's the point. `thirdPartySourceBrowserStore.ts`'s
 * own doc comment carries the full reasoning: a Figma file or Notion page
 * is not about any one conversation, so there is exactly one Figma tab and
 * one Notion tab for the whole app, addressable from `_props: PanelProps`
 * alone.
 *
 * SCOPE OF THIS SLICE: the browsing surface itself — switching between
 * Figma/Notion, each with its own live `<webview>` and persisted-across-
 * restarts login (`BrowserSession.ts`'s shared third-party partition).
 * "Add to chat" (capturing the current page's identity + a screenshot into
 * a composer draft) is a deliberately SEPARATE next step, not silently
 * folded in here — it raises its own question this panel doesn't answer on
 * its own (this panel has no active THREAD to hand a captured annotation
 * to, since it isn't thread-scoped) and deserves to be resolved
 * explicitly rather than guessed at alongside the browsing UI.
 *
 * NOT YET LIVE: mounting a `<webview>` on the third-party partition is
 * still gated on `DesktopWindow.ts`'s `will-attach-webview` allowlist,
 * which does not yet recognize that partition — see
 * `WebviewPreferences.ts`'s own note. This panel is correct and ready; the
 * webview itself will render blank until that gate is updated.
 */
import { cn } from "~/lib/utils";

import { ThirdPartySourceWebview } from "../browser/ThirdPartySourceWebview";
import type { ThirdPartySourceKind } from "../thirdPartySourceBrowserStore";
import { useThirdPartySourceBrowserStore } from "../thirdPartySourceBrowserStore";
import type { PanelProps } from "./lib/types";

const SOURCE_TAB_LABELS: Readonly<Record<ThirdPartySourceKind, string>> = {
  figma: "Figma",
  notion: "Notion",
};
const SOURCE_TAB_ORDER: ReadonlyArray<ThirdPartySourceKind> = ["figma", "notion"];

function ThirdPartySourceTabStrip(props: {
  activeSource: ThirdPartySourceKind | null;
  onSelect: (source: ThirdPartySourceKind) => void;
}) {
  return (
    <div className="flex min-h-0 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border/60 px-1 py-1">
      {SOURCE_TAB_ORDER.map((source) => {
        const active = props.activeSource === source;
        return (
          <button
            key={source}
            type="button"
            onClick={() => props.onSelect(source)}
            className={cn(
              "shrink-0 rounded px-2 py-1 text-xs",
              active
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
            )}
          >
            {SOURCE_TAB_LABELS[source]}
          </button>
        );
      })}
    </div>
  );
}

export default function ThirdPartySourceDockPanel(_props: PanelProps) {
  const activeSource = useThirdPartySourceBrowserStore((state) => state.activeSource);
  const onSelect = (source: ThirdPartySourceKind) => {
    useThirdPartySourceBrowserStore.getState().open(source);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ThirdPartySourceTabStrip activeSource={activeSource} onSelect={onSelect} />
      <div className="min-h-0 flex-1">
        {activeSource ? (
          <ThirdPartySourceWebview key={activeSource} source={activeSource} />
        ) : (
          <div className="flex h-full items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
            Pick Figma or Notion above to start browsing.
          </div>
        )}
      </div>
    </div>
  );
}
