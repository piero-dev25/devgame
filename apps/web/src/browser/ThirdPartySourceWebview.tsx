"use client";

/**
 * Renders the live `<webview>` for whichever third-party source
 * (`thirdPartySourceBrowserStore.ts`) is active. Deliberately much simpler
 * than `HostedBrowserWebview.tsx`: that component's complexity is almost
 * entirely thread-scoped preview-session machinery (`browserSurfaceStore`'s
 * hidden-overlay-positioned-under-a-placeholder trick, viewport/zoom/device
 * emulation, crash-recovery tied to a `ScopedThreadRef`) that a normal dock
 * panel — a plain CSS box dockview already lays out — doesn't need at all.
 *
 * Tab registration reuses `desktopTabLifetime.ts`'s `acquireDesktopTab`
 * AS-IS: it's generic bookkeeping keyed by an arbitrary `tabId` string (main
 * process needs a `WebContents` handle to command/capture a webview by id,
 * regardless of what content it shows), not preview-SESSION machinery — see
 * the investigation report this was built from. Navigation state is read
 * directly off the `<webview>` DOM element's own events, not relayed
 * through `previewStateStore`'s IPC round-trip — that store exists to sync
 * navigation across the desktop/web process boundary for the THREAD-scoped
 * preview tab lifecycle; this component owns its one global tab directly
 * and has no such boundary to cross for this.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { previewBridge } from "~/components/preview/previewBridge";

import { acquireDesktopTab, type AcquiredDesktopTab } from "./desktopTabLifetime";
import type { ThirdPartySourceKind } from "../thirdPartySourceBrowserStore";
import { useThirdPartySourceBrowserStore } from "../thirdPartySourceBrowserStore";
import { useThirdPartyBrowserWebviewConfig } from "./thirdPartyBrowserWebviewConfigState";

// Local cast target only — deliberately NOT a `declare global` augmentation
// of `HTMLElementTagNameMap`. `HostedBrowserWebview.tsx` already provides
// one for the `<webview>` intrinsic element (with a different method set);
// TypeScript requires every declaration merged into the same global
// interface to match EXACTLY, so a second, differently-shaped one here
// would conflict. `setWebviewRef` below takes a plain `HTMLElement | null`
// and casts to this locally, so the JSX ref's inferred type never needs to
// match this interface.
interface ElectronWebview extends HTMLElement {
  src: string;
  partition: string;
  webpreferences?: string;
  getWebContentsId: () => number;
  getURL: () => string;
  getTitle: () => string;
}

const THIRD_PARTY_TAB_ID_PREFIX = "third-party-browser:";

/** Shared with `ThirdPartySourceDockPanel.tsx`'s "Add to chat" handler,
 * which needs the same tabId to call `captureTabScreenshotDataUrl` against
 * the exact webview the user is looking at — exported so both sides derive
 * it from one source rather than duplicating the prefix literal. */
export function thirdPartySourceTabId(source: ThirdPartySourceKind): string {
  return `${THIRD_PARTY_TAB_ID_PREFIX}${source}`;
}

export function ThirdPartySourceWebview(props: { readonly source: ThirdPartySourceKind }) {
  const { source } = props;
  const config = useThirdPartyBrowserWebviewConfig();
  const tab = useThirdPartySourceBrowserStore((state) => state.tabs[source]);
  const tabId = thirdPartySourceTabId(source);
  const webviewRef = useRef<ElectronWebview | null>(null);
  const tabLeaseRef = useRef<AcquiredDesktopTab | null>(null);
  // Read once on mount, not re-synced from later store updates — matches
  // `HostedBrowserWebview.tsx`'s own `initialSrc` pattern. Once the webview
  // is live, its own navigation drives `tab.url` via `reportNavigation`
  // below; re-deriving `src` from the store on every render would fight
  // the user's own in-page navigation.
  const [initialSrc] = useState(() => tab?.url ?? "about:blank");

  useEffect(() => {
    const lease = acquireDesktopTab(tabId);
    tabLeaseRef.current = lease;
    return () => {
      if (tabLeaseRef.current === lease) tabLeaseRef.current = null;
      lease.release();
    };
  }, [tabId]);

  const setWebviewRef = useCallback((node: HTMLElement | null) => {
    webviewRef.current = node as ElectronWebview | null;
    // F5 (independent security review, 2026-08-04): without this,
    // window.open/target="_blank" silently do nothing — Chromium's popup
    // handler in the main process never even fires. That meant Google SSO
    // sign-in popups, the standard login path for both Figma and Notion,
    // were silently swallowed: a user couldn't complete the FIRST login the
    // persistent-session work exists to avoid repeating. Matches
    // HostedBrowserWebview.tsx's own `allowpopups` handling. Landing this
    // makes Manager.ts's `setWindowOpenHandler` (attachListeners) live for
    // untrusted third-party content for the first time — see that
    // handler's own note on why its fallback navigation is validated
    // through `normalizePreviewUrl` in the same change as this attribute.
    if (node && !node.hasAttribute("allowpopups")) node.setAttribute("allowpopups", "true");
  }, []);

  const reportNavigation = useCallback(() => {
    const webview = webviewRef.current;
    if (!webview) return;
    const url = webview.getURL();
    if (!url || url === "about:blank") return;
    useThirdPartySourceBrowserStore
      .getState()
      .setTabState(source, { url, title: webview.getTitle() || null });
  }, [source]);

  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview || !config) return;
    let disposed = false;
    const register = () => {
      const lease = tabLeaseRef.current;
      if (!lease) return;
      void (async () => {
        try {
          await lease.ready;
          if (disposed || webviewRef.current !== webview) return;
          const webContentsId = webview.getWebContentsId();
          if (Number.isInteger(webContentsId) && webContentsId > 0) {
            await window.desktopBridge?.preview?.registerWebview(tabId, webContentsId);
          }
        } catch {
          // did-attach/dom-ready will retry if the guest was not ready yet.
        }
      })();
    };
    webview.addEventListener("did-attach", register);
    webview.addEventListener("dom-ready", register);
    webview.addEventListener("did-navigate", reportNavigation);
    webview.addEventListener("did-navigate-in-page", reportNavigation);
    webview.addEventListener("page-title-updated", reportNavigation);
    register();
    return () => {
      disposed = true;
      webview.removeEventListener("did-attach", register);
      webview.removeEventListener("dom-ready", register);
      webview.removeEventListener("did-navigate", reportNavigation);
      webview.removeEventListener("did-navigate-in-page", reportNavigation);
      webview.removeEventListener("page-title-updated", reportNavigation);
    };
  }, [config, tabId, reportNavigation]);

  // Matches `PreviewPanel.tsx`'s own runtime gate exactly, same signal
  // (`previewBridge`, i.e. `window.desktopBridge?.preview`): the `<webview>`
  // intrinsic only exists in Electron's renderer, so a plain web-client tab
  // has no host to attach one to at all. Before this, a non-Electron runtime
  // fell through to the `!config` branch below and rendered nothing — the
  // exact "blank panel with no explanation" the Browser dock panel already
  // avoids for the analogous case. This check comes first so the message is
  // honest about *why* there's nothing to show, rather than reading as the
  // same empty state a slow/failed config load produces.
  if (previewBridge === null) {
    return (
      <div className="flex size-full items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
        Figma and Notion previews are only available in the DevGame desktop app.
      </div>
    );
  }

  // KNOWN GAP, not fixed here: `config` is `null` for two still-undifferentiated
  // reasons — `thirdPartyBrowserWebviewConfigAtom` hasn't resolved yet (normal,
  // brief, on every mount), or `getThirdPartyBrowserConfig()` failed
  // (`ThirdPartyBrowserWebviewConfigLoadError`, real, would otherwise persist).
  // `useThirdPartyBrowserWebviewConfig()` collapses both to `null` via
  // `Option.getOrNull(AsyncResult.value(result))`, discarding which one
  // happened, so this branch can't tell a slow load from a broken one — a
  // load failure currently reads to the user as an indefinitely blank panel,
  // same as mid-load. Distinguishing them needs surfacing
  // `AsyncResult`'s own loading/failure states out of
  // `thirdPartyBrowserWebviewConfigState.ts`, not a check addable at this
  // call site — left as a scoped follow-up, not fixed in the pass that added
  // the `previewBridge === null` branch above it.
  if (!config) return null;

  return (
    <webview
      ref={setWebviewRef}
      src={initialSrc}
      partition={config.partition}
      webpreferences={config.webPreferences}
      data-third-party-source={source}
      className="size-full"
    />
  );
}
