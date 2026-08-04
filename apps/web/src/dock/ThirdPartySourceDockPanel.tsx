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
 * SCOPE OF THIS SLICE: the browsing surface AND "Add to chat," but
 * deliberately v1-shaped (owner ruling, relayed 2026-08-04): identity +
 * screenshot as plain composer text, NOT the `<preview_annotation>` flow's
 * structured-payload + composer-cards UX. That flow needs a send-time
 * rendering step BECAUSE it stores a structured payload; plain text skips
 * that problem entirely — `composerDraftStore.ts`'s `setPrompt` already IS
 * the generic primitive needed, so this never touches `ChatView.tsx` or
 * adds a parallel `thirdPartySourceAnnotations` array. If the cards UX
 * turns out to be missed, that's an easy follow-up on a working feature,
 * not a prerequisite to having one.
 *
 * ACTIVE THREAD: read from `ThreadRouteContext` (`ChatPanel.tsx`) at
 * click-time, NOT held by this panel — the panel itself stays thread-free
 * (see the store's own doc comment for why). `ThreadRouteContext.Provider`
 * wraps dockview's whole panel tree in `ChatDock.tsx`, not just
 * `ChatPanel`'s own subtree, so a sibling panel reads it the same way
 * `FilesDockPanel.tsx` already does. BOTH route kinds ("server" and
 * "draft") are accepted — unlike Files, this doesn't need a real
 * project/workspace, just composer draft state every route kind already
 * has. No active route at all → the action is unavailable with a stated
 * reason, not a silent no-op.
 *
 * NOT YET LIVE — corrected 2026-08-04, the reason changed: the
 * `will-attach-webview` allowlist gate is fixed (an independent security
 * review found real issues in it — F1/F2/F3/F5 — since resolved and
 * pending their own review pass, see `WebviewPreferences.ts`'s own note).
 * What's still pending is this panel's OWN registration into
 * `ChatDock.tsx` — the dock-migration lane's active territory, sequenced
 * separately. Nothing walks through any of this until that lands.
 */
import { useContext, useState } from "react";

import { previewBridge } from "~/components/preview/previewBridge";
import { DraftId, useComposerDraftStore, useComposerThreadDraft } from "~/composerDraftStore";
import { cn } from "~/lib/utils";

import {
  appendThirdPartySourceAnnotationPrompt,
  buildThirdPartySourceChip,
  thirdPartySourceScreenshotFile,
} from "../browser/thirdPartySourceAnnotation";
import { parseThirdPartySourceIdentity } from "../browser/thirdPartySourceIdentity";
import { ThirdPartySourceWebview, thirdPartySourceTabId } from "../browser/ThirdPartySourceWebview";
import type { ThirdPartySourceKind } from "../thirdPartySourceBrowserStore";
import { useThirdPartySourceBrowserStore } from "../thirdPartySourceBrowserStore";
import { ThreadRouteContext } from "./ChatPanel";
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

// A stable, never-really-resolved fallback — React hooks must run in the
// same order every render, so `useComposerThreadDraft` below is always
// called, but its result is only READ when `composerTarget` is non-null
// (button disabled otherwise). An empty DraftId matches nothing in
// `draftThreadsByThreadKey`, so this safely returns the store's own empty
// draft rather than touching a real thread.
const NO_ACTIVE_THREAD_FALLBACK_TARGET = DraftId.make("");

export default function ThirdPartySourceDockPanel(_props: PanelProps) {
  const activeSource = useThirdPartySourceBrowserStore((state) => state.activeSource);
  const activeTab = useThirdPartySourceBrowserStore((state) =>
    activeSource ? state.tabs[activeSource] : null,
  );
  const routeContext = useContext(ThreadRouteContext);
  const [addingToChat, setAddingToChat] = useState(false);

  const composerTarget =
    routeContext === null
      ? null
      : routeContext.routeKind === "server"
        ? { environmentId: routeContext.environmentId, threadId: routeContext.threadId }
        : routeContext.draftId;

  const draft = useComposerThreadDraft(composerTarget ?? NO_ACTIVE_THREAD_FALLBACK_TARGET);

  const onSelect = (source: ThirdPartySourceKind) => {
    useThirdPartySourceBrowserStore.getState().open(source);
  };

  const addToChatDisabledReason =
    composerTarget === null
      ? "Select a conversation to add this to."
      : activeSource === null || activeTab === null
        ? "Pick Figma or Notion above first."
        : null;

  const onAddToChat = async () => {
    if (composerTarget === null || activeSource === null || activeTab === null) return;
    setAddingToChat(true);
    try {
      const identity = parseThirdPartySourceIdentity(activeTab.url);
      if (!identity) return;
      const tabId = thirdPartySourceTabId(activeSource);
      const screenshot =
        (await previewBridge?.captureTabScreenshotDataUrl(tabId).catch(() => null)) ?? null;
      const store = useComposerDraftStore.getState();
      if (screenshot) {
        const file = await thirdPartySourceScreenshotFile(
          screenshot,
          `${identity.source}-${Date.now()}`,
        );
        store.addImage(composerTarget, {
          type: "image",
          id: `third-party-source-${Date.now()}`,
          name: file.name,
          mimeType: file.type,
          sizeBytes: file.size,
          previewUrl: screenshot.dataUrl,
          file,
        });
      }
      const nextPrompt = appendThirdPartySourceAnnotationPrompt(draft.prompt, {
        identity,
        pageUrl: activeTab.url,
        pageTitle: activeTab.title,
        comment: "",
        screenshot,
        createdAt: new Date().toISOString(),
      });
      store.setPrompt(composerTarget, nextPrompt);
    } finally {
      setAddingToChat(false);
    }
  };

  const activeIdentity = activeTab ? parseThirdPartySourceIdentity(activeTab.url) : null;
  const chip = activeIdentity ? buildThirdPartySourceChip(activeIdentity) : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 shrink-0 items-center justify-between border-b border-border/60">
        <ThirdPartySourceTabStrip activeSource={activeSource} onSelect={onSelect} />
        <button
          type="button"
          disabled={addToChatDisabledReason !== null || addingToChat}
          title={addToChatDisabledReason ?? (chip ? `Add ${chip.label} to chat` : undefined)}
          onClick={() => void onAddToChat()}
          className={cn(
            "mr-1 shrink-0 rounded px-2 py-1 text-xs",
            addToChatDisabledReason !== null || addingToChat
              ? "cursor-not-allowed text-muted-foreground/50"
              : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
          )}
        >
          {addingToChat ? "Adding…" : "Add to chat"}
        </button>
      </div>
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
