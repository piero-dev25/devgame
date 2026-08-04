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
 * REGISTERED (task #55) — `ChatDock.tsx` registers this panel now, so the
 * code path this file describes is reachable. Read `ChatDock.tsx`'s own
 * registration comment before treating that as "shippable": as of
 * registration, `#75`'s F1/F2/F3/F5/F7 findings against the
 * `will-attach-webview` allowlist are fixed (`f425a8ebd`), and an
 * INDEPENDENT REVIEW of the fix commit is still running and may land
 * further findings.
 *
 * F4 SIGN-OUT (owner ruling, relayed 2026-08-04): "Sign out" clears the
 * ACTIVE source's cookies/storage only — see `onSignOut` below and
 * `BrowserSession.ts`'s `clearThirdPartySourceData` for what it does and
 * does not clear (notably: not the shared partition's cache, which isn't
 * origin-scoped in Electron). Deliberately kept SMALL per the ruling:
 * `will-navigate` visibility and an origin indicator in the UI are tracked
 * but explicitly NOT built in this slice.
 *
 * WEB-CLIENT DEGRADATION: the `<webview>` intrinsic only exists in
 * Electron's renderer, so a plain web-client tab has nothing to attach one
 * to — `ThirdPartySourceWebview.tsx` shows an honest "only available in the
 * desktop app" message in that case (same `previewBridge` signal, same
 * message text, as `PreviewPanel.tsx`'s equivalent gate for the Browser
 * panel), rather than a blank content area. "Add to chat" and "Sign out"
 * are disabled with the same reason here, at the panel level, since both
 * would otherwise stay clickable and silently no-op via `previewBridge?.
 * method()` — see `THIRD_PARTY_SOURCE_UNAVAILABLE_REASON` below.
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
import {
  parseThirdPartySourceIdentity,
  thirdPartySourceOrigin,
} from "../browser/thirdPartySourceIdentity";
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

// Same text, same signal (`previewBridge`) as `ThirdPartySourceWebview.tsx`'s
// own runtime gate — repeated here (not exported/shared) matching
// `BrowserDockPanel.tsx`'s/`PreviewPanel.tsx`'s precedent of each owning its
// own copy of the equivalent message rather than a cross-file constant.
// Content-area unavailability is `ThirdPartySourceWebview`'s job; this
// constant is for the two action buttons here, which would otherwise stay
// enabled and silently no-op (`previewBridge?.method()`) in a plain web tab.
const THIRD_PARTY_SOURCE_UNAVAILABLE_REASON =
  "Figma and Notion previews are only available in the DevGame desktop app.";

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
  const [signingOut, setSigningOut] = useState(false);

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
    previewBridge === null
      ? THIRD_PARTY_SOURCE_UNAVAILABLE_REASON
      : composerTarget === null
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

  // F4 (owner ruling, relayed 2026-08-04): sign out of the ACTIVE source
  // only — not "sign out of everything," per the ruling's "per source"
  // framing. `previewBridge.signOutOfThirdPartySource` clears that origin's
  // cookies/storage in the (shared) third-party partition without touching
  // the other product's login; see BrowserSession.ts for exactly what it
  // does and does not clear. `resetTab` then drops the remembered URL/title
  // so the panel's `key={activeSource}` remount (below) reloads the webview
  // at the default URL instead of a stale, now-logged-out page.
  const onSignOut = async () => {
    if (activeSource === null) return;
    setSigningOut(true);
    try {
      await previewBridge?.signOutOfThirdPartySource(thirdPartySourceOrigin(activeSource));
      useThirdPartySourceBrowserStore.getState().resetTab(activeSource);
    } finally {
      setSigningOut(false);
    }
  };

  const activeIdentity = activeTab ? parseThirdPartySourceIdentity(activeTab.url) : null;
  const chip = activeIdentity ? buildThirdPartySourceChip(activeIdentity) : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 shrink-0 items-center justify-between border-b border-border/60">
        <ThirdPartySourceTabStrip activeSource={activeSource} onSelect={onSelect} />
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            disabled={previewBridge === null || activeSource === null || signingOut}
            title={
              previewBridge === null
                ? THIRD_PARTY_SOURCE_UNAVAILABLE_REASON
                : activeSource === null
                  ? "Pick Figma or Notion above first."
                  : `Sign out of ${SOURCE_TAB_LABELS[activeSource]}`
            }
            onClick={() => void onSignOut()}
            className={cn(
              "shrink-0 rounded px-2 py-1 text-xs",
              previewBridge === null || activeSource === null || signingOut
                ? "cursor-not-allowed text-muted-foreground/50"
                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
            )}
          >
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
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
