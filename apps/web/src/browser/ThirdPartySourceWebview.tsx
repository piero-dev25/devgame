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

export function ThirdPartySourceWebview(props: { readonly source: ThirdPartySourceKind }) {
  const { source } = props;
  const config = useThirdPartyBrowserWebviewConfig();
  const tab = useThirdPartySourceBrowserStore((state) => state.tabs[source]);
  const tabId = `${THIRD_PARTY_TAB_ID_PREFIX}${source}`;
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
