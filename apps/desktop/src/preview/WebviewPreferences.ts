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
 * Defense in depth: `apps/desktop/src/main.ts` also runs a
 * `will-attach-webview` handler that force-sets `sandbox: true` and
 * `nodeIntegration*: false` on the actual webPreferences object, gated on
 * the preview partition, so even if this string is ever wrong, the
 * security-critical flags can't regress on preview tabs.
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
 * NOT YET ENFORCED end-to-end: `DesktopWindow.ts`'s `will-attach-webview`
 * handler is a security-relevant CHANGE still pending review before a
 * third-party webview can attach at all (it currently only recognizes the
 * preview partition and hardcodes `contextIsolation=false` for it) — see
 * that handler's own doc note. This constant is correct in isolation and
 * ready for that handler to honor once it's updated.
 */
export const THIRD_PARTY_BROWSER_WEBVIEW_PREFERENCES =
  "contextIsolation=true,sandbox=true,nodeIntegration=false";
