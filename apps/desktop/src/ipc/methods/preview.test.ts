import { it as effectIt } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { DesktopPreviewWebviewConfig } from "@t3tools/contracts";
import type * as Electron from "electron";

import * as PreviewManager from "../../preview/Manager.ts";
import * as PreviewIpc from "./preview.ts";

const { fromPartition } = vi.hoisted(() => ({
  fromPartition: vi.fn(() => {
    throw new Error("Session can only be received when app is ready");
  }),
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
  session: {
    fromPartition,
  },
  webContents: {
    fromId: vi.fn(() => null),
  },
}));

describe("preview IPC methods", () => {
  beforeEach(() => {
    fromPartition.mockClear();
  });

  it("does not access the Electron session while the module loads", async () => {
    await expect(import("./preview.ts")).resolves.toBeDefined();
    expect(fromPartition).not.toHaveBeenCalled();
  });

  effectIt.effect("rejects invalid webContents ids before resolving the preview service", () =>
    Effect.map(
      PreviewIpc.registerWebview
        .handler({ tabId: "tab-1", webContentsId: 0 })
        .pipe(Effect.provideService(PreviewManager.PreviewManager, null as never), Effect.exit),
      (exit) => {
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isSuccess(exit)) return;
        const error = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(error) && Schema.isSchemaError(error.value)).toBe(true);
        expect(fromPartition).not.toHaveBeenCalled();
      },
    ),
  );

  // #89/#92 (independent audit, mutation-tested, 2026-08-04): mutating this
  // handler's `preloadUrl: null` to a real path (e.g.
  // "file:///tmp/evil.js") survived the whole suite — this handler had no
  // test at all. WebviewPreferences.ts's own doc comment cites this exact
  // value as what stops a renderer supplying its own preload on the
  // third-party (Figma/Notion) partition — untrusted external content that,
  // unlike preview, gets no preload of ANY kind. Defense-in-depth still
  // holds even if this one regresses (DesktopWindow.ts's `will-attach-
  // webview` handler independently `delete`s `webPreferences.preload` for
  // the third-party partition — see G1/F2's own fix), but a stated security
  // invariant with nothing pinning it is exactly the shape this audit went
  // looking for.
  //
  // Three cases, not one: a single "returns null" assertion pins today's
  // LITERAL, which would still pass if this ever became conditional on the
  // resolved session/partition (`preloadUrl: someCondition ? url : null`)
  // as long as THIS test's specific inputs still landed on the null branch.
  // Varying the mocked session identity and partition string across cases
  // and asserting null every time is what actually tests the INVARIANT
  // WebviewPreferences.ts's comment claims — that this path cannot yield a
  // non-null preload — rather than one snapshot of it.
  describe.each([
    { label: "session A", session: { __brand: "session-a" }, partition: "persist:devgame-thirdparty-aaaa" },
    { label: "session B", session: { __brand: "session-b" }, partition: "persist:devgame-thirdparty-bbbb" },
    { label: "a session with no identifying brand at all", session: {}, partition: "persist:devgame-thirdparty-cccc" },
  ])("getThirdPartyBrowserConfig — $label", ({ session, partition }) => {
    effectIt.effect("always returns preloadUrl: null regardless of the resolved session/partition", () =>
      Effect.gen(function* () {
        // `DesktopIpcMethod<E, R>`'s exported `handler` type is deliberately
        // erased to `(raw: unknown) => Effect.Effect<unknown, E, R>`
        // (DesktopIpc.ts) — a uniform shape every registered method shares
        // for `DesktopIpc.handle`'s own registry, not specific to this one.
        // The cast below is honest, not a workaround: `preview.ts`'s own
        // handler body (read directly, not inferred through this erased
        // type) returns exactly `DesktopPreviewWebviewConfig` on success.
        const result = (yield* PreviewIpc.getThirdPartyBrowserConfig.handler(
          undefined,
        )) as DesktopPreviewWebviewConfig;
        expect(result.preloadUrl).toBeNull();
        expect(result.partition).toBe(partition);
      }).pipe(
        Effect.provide(
          Layer.mock(PreviewManager.PreviewManager)({
            getThirdPartyBrowserSession: () => Effect.succeed(session as Electron.Session),
            getThirdPartyBrowserPartition: () => Effect.succeed(partition),
            // Plain sync (non-Effect) members — Layer.mock can't lazily stub
            // these with a "not implemented" default the way it can for
            // Effect-returning members, so they're required regardless of
            // whether this test's own path reaches them. Unreached here.
            isBrowserPartition: () => false,
            isThirdPartyBrowserPartition: () => false,
          }),
        ),
      ),
    );
  });
});
