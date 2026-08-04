/**
 * webPreferences override applied to every preview `<webview>` element via
 * its `webpreferences="..."` attribute. Single source of truth so all guest
 * surfaces inherit the same security posture.
 *
 * Lives in its own electron-free module so the value is unit-testable
 * without importing `Manager.ts` (which transitively imports
 * `electron` and blows up under vitest).
 *
 * - `contextIsolation=false`: the picker preload needs to share `globalThis`
 *   with the page so react-grab/bippy can read the React DevTools hook
 *   (`__REACT_DEVTOOLS_GLOBAL_HOOK__`) and resolve component names. Without
 *   this every pick comes back with `componentName: null` even on dev React
 *   apps.
 * - `sandbox=true`: keeps the OS-level renderer sandbox enabled. Critical
 *   when paired with `contextIsolation=false` — without sandbox, the preload
 *   has full Node access (`require`, `fs`, `child_process`, ...) and that
 *   `require` would land on the page's shared `globalThis`, giving any
 *   third-party page in the preview full Node + IPC access to the host.
 *   In sandboxed mode Electron still synthesizes the `electron` module for
 *   the preload's `import { ipcRenderer }` line, but no Node globals leak.
 * - `nodeIntegration=false`: pinned for clarity (the page itself never gets
 *   Node access).
 *
 * Format notes (locked down by `WebviewPreferences.test.ts`):
 * - Whitespace-free. Electron's webpreferences parser splits on `,` and
 *   does not trim, so a leading space would turn a key into an unknown one
 *   and silently drop it.
 * - Values are JS-boolean strings (`true`/`false`) — `yes`/`no` are not
 *   special-cased by the parser; `value="no"` becomes the truthy STRING
 *   `"no"` when assigned to a boolean webPreferences key. Most critically,
 *   `contextIsolation="no"` is truthy → contextIsolation stays ENABLED →
 *   react-grab can't see the React DevTools hook.
 *
 * Defense in depth: `apps/desktop/src/window/DesktopWindow.ts` (NOT
 * `main.ts` — corrected 2026-08-04, an earlier version of this comment
 * named the wrong file and there is exactly one `will-attach-webview`
 * handler in the app) also runs a `will-attach-webview` handler that
 * force-sets `sandbox`/`nodeIntegration*`/`webSecurity`/
 * `allowRunningInsecureContent` on the actual webPreferences object, gated
 * on the preview or third-party partition, so even if this string is ever
 * wrong, the security-critical flags can't regress.
 */
export const PREVIEW_WEBVIEW_PREFERENCES =
  "contextIsolation=false,sandbox=true,nodeIntegration=false";

/**
 * webPreferences for a third-party browser-panel `<webview>` (Figma,
 * Notion). Deliberately its own constant, not a reuse of
 * `PREVIEW_WEBVIEW_PREFERENCES` — third-party pages are untrusted external
 * content, unlike the user's own dev-server preview, and get no preload
 * (`getThirdPartyBrowserConfig`'s `preloadUrl` is always `null`). With no
 * preload, there is nothing running in that renderer for
 * `contextIsolation` to protect either way — `sandbox=true` +
 * `nodeIntegration=false` already deny Node/IPC access regardless of it —
 * so `contextIsolation=true` here costs nothing and is pure defense in
 * depth, unlike preview's `false`, which is a real, documented tradeoff for
 * the picker preload.
 *
 * `DesktopWindow.ts`'s `will-attach-webview` handler now recognizes the
 * third-party partition and honors this constant (fixed 2026-08-04,
 * addressing findings F1/F2/F3/F5 from an independent security review,
 * each verified by execution against a real third-party partition). That
 * review found the earlier version of this handler and the third-party
 * session; the fixes made in response are new changes to the SAME
 * security-relevant surface and are themselves pending their own review
 * pass before merge — a review addressing version N doesn't clear
 * version N+1 just because it was written in response.
 *
 * STILL NOT LIVE, for a separate reason: the third-party dock panel
 * (`ThirdPartySourceDockPanel.tsx`) is not yet registered in `ChatDock.tsx`
 * — that's the dock-migration lane's active territory, sequenced
 * separately — so no real `<webview>` on this partition attaches yet.
 */
export const THIRD_PARTY_BROWSER_WEBVIEW_PREFERENCES =
  "contextIsolation=true,sandbox=true,nodeIntegration=false";
