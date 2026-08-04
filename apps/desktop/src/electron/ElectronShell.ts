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
