// @effect-diagnostics globalDate:off - shouldAllowExternalDeflect is called
// synchronously from raw Electron event callbacks (will-navigate,
// will-redirect, the window-open handler) that never run inside an Effect
// runtime, so there is no Clock service to pull from at the call site.

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Electron from "electron";

const SAFE_EXTERNAL_PROTOCOLS = new Set(["http:", "https:"]);

// F-3 (independent security review, 2026-08-04): every cross-origin
// navigation this app denies-in-panel and deflects to the user's real
// browser (`openExternal`) is an unbounded, gesture-free "spawn a tab
// holding the user's full cookie jar" primitive from the guest's point of
// view. Measured against a hostile page looping `window.location.href`:
// 9 real external tabs opened in ~1.4 seconds. A cooldown, not a confirm
// dialog — SSO/IdP sign-in is a single hop per login attempt, comfortably
// under any reasonable window here, while a confirm on every cross-origin
// hop would degrade the exact SSO flow G3's deflect policy exists to keep
// working. Not gated on "was this a user gesture" instead: none of
// will-navigate/will-redirect/the window-open handler exposes a reliable
// gesture flag to check, so that signal isn't actually available to gate
// on, only a plausible-sounding one.
//
// Keyed by webContents id and shared module-wide (not per-caller state) so
// DesktopWindow.ts's guest will-navigate/will-redirect deflects and
// Manager.ts's popup-handler deflect count against the SAME budget for the
// same guest — a page cannot reset its allowance by switching which
// navigation mechanism it spams through.
//
// The invariant that keeps a legitimate multi-hop SSO chain from tripping
// this: only a CROSS-ORIGIN hop that actually gets deflected calls this at
// all — a same-origin hop returns before ever reaching it, so an
// all-same-origin redirect chain can never consume budget. And
// `event.preventDefault()` on the first cross-origin hop of a chain cancels
// that WHOLE in-flight navigation, so later hops in the same load never
// fire — a chain costs at most one deflection structurally, not "one per
// hop, which happens not to accumulate."
const EXTERNAL_DEFLECT_COOLDOWN_MS = 3_000;
const lastExternalDeflectAtByWebContentsId = new Map<number, number>();

export function shouldAllowExternalDeflect(webContentsId: number): boolean {
  const now = Date.now();
  const lastDeflectAt = lastExternalDeflectAtByWebContentsId.get(webContentsId);
  if (lastDeflectAt !== undefined && now - lastDeflectAt < EXTERNAL_DEFLECT_COOLDOWN_MS) {
    return false;
  }
  lastExternalDeflectAtByWebContentsId.set(webContentsId, now);
  return true;
}

// F6 (guard security review, 2026-08-11): `will-redirect` cannot tell an
// app-initiated load apart from a guest-initiated one — Electron fires it
// for BOTH, while `will-navigate` fires only for guest-initiated
// navigations. So when the app itself drives a load (`Manager.ts`'s
// `navigate`/`loadPendingUrl` `wc.loadURL` calls — the user typed a URL, or
// a pending tab URL is being applied) and the target 301s cross-origin
// (apex -> www, http -> https, an SSO bounce), the redirect used to be
// judged against the PREVIOUS page's origin and deflected to the external
// browser — the "typing reddit.com in a loaded tab opens Chrome" half of
// the owner's bug. Manager marks the load in flight here before calling
// `loadURL`; `DesktopWindow.ts`'s guest `will-redirect` skips enforcement
// while set; the guest's own `did-navigate`/`did-fail-load` clears it.
// Shared per-webContentsId module state, same shape as the deflect budget
// above and for the same reason. Deliberately NOT gated on
// `details.initiator == null` (it also goes null when the initiating frame
// was deleted before the event — an iframe that sets `top.location` and
// removes itself would get a free pass; that signal fails open). And
// deliberately NOT marked by the popup-funneled `loadURL`
// (`handlePopupNavigation`'s loadInPanel branch): that navigation is
// guest-initiated content merely routed through `loadURL` — marking it
// would let a hostile page ride a same-origin `window.open` into an
// arbitrary cross-origin redirect in-panel.
const appInitiatedLoadInFlightWebContentsIds = new Set<number>();

export function markAppInitiatedLoad(webContentsId: number): void {
  appInitiatedLoadInFlightWebContentsIds.add(webContentsId);
}

export function clearAppInitiatedLoad(webContentsId: number): void {
  appInitiatedLoadInFlightWebContentsIds.delete(webContentsId);
}

export function isAppInitiatedLoadInFlight(webContentsId: number): boolean {
  return appInitiatedLoadInFlightWebContentsIds.has(webContentsId);
}

export function parseSafeExternalUrl(rawUrl: unknown): Option.Option<string> {
  if (typeof rawUrl !== "string") {
    return Option.none();
  }

  try {
    const url = new URL(rawUrl);
    return SAFE_EXTERNAL_PROTOCOLS.has(url.protocol) ? Option.some(url.href) : Option.none();
  } catch {
    return Option.none();
  }
}

export class ElectronShell extends Context.Service<
  ElectronShell,
  {
    readonly openExternal: (rawUrl: unknown) => Effect.Effect<boolean>;
    readonly copyText: (text: string) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/electron/ElectronShell") {}

export const make = ElectronShell.of({
  openExternal: (rawUrl) =>
    Option.match(parseSafeExternalUrl(rawUrl), {
      onNone: () => Effect.succeed(false),
      onSome: (externalUrl) =>
        Effect.promise(() =>
          Electron.shell.openExternal(externalUrl).then(
            () => true,
            () => false,
          ),
        ),
    }),
  copyText: (text) =>
    Effect.sync(() => {
      Electron.clipboard.writeText(text);
    }),
});

export const layer = Layer.succeed(ElectronShell, make);
