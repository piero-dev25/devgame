import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import { beforeEach, vi } from "vite-plus/test";

const { fromPartition, sessions } = vi.hoisted(() => ({
  fromPartition: vi.fn(),
  sessions: new Map<
    string,
    {
      readonly clearCache: ReturnType<typeof vi.fn>;
      readonly clearStorageData: ReturnType<typeof vi.fn>;
      readonly getUserAgent: ReturnType<typeof vi.fn>;
      readonly setPermissionRequestHandler: ReturnType<typeof vi.fn>;
      readonly setPermissionCheckHandler: ReturnType<typeof vi.fn>;
      readonly setUserAgent: ReturnType<typeof vi.fn>;
    }
  >(),
}));

vi.mock("electron", () => ({
  session: {
    fromPartition,
  },
}));

import * as BrowserSession from "./BrowserSession.ts";

const layer = BrowserSession.layer.pipe(Layer.provide(NodeServices.layer));

describe("BrowserSession", () => {
  beforeEach(() => {
    sessions.clear();
    fromPartition.mockReset();
    fromPartition.mockImplementation((partition: string) => {
      const browserSession = {
        clearCache: vi.fn(() => Promise.resolve()),
        clearStorageData: vi.fn(() => Promise.resolve()),
        getUserAgent: vi.fn(() => "Mozilla/5.0 Electron/41.5.0 t3code/0.0.27"),
        setPermissionRequestHandler: vi.fn(),
        setPermissionCheckHandler: vi.fn(),
        setUserAgent: vi.fn(),
      };
      sessions.set(partition, browserSession);
      return browserSession;
    });
  });

  it.effect("derives deterministic partitions and memoizes sessions", () =>
    Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;

      const partition = yield* browserSessions.getPartition("scope-a");
      const first = yield* browserSessions.getSession("scope-a");
      const second = yield* browserSessions.getSession("scope-a");

      assert.strictEqual(partition, "persist:devgame-preview-f051bb2c68cb7b2fe969");
      assert.strictEqual(first, second);
      assert.strictEqual(fromPartition.mock.calls.length, 1);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("grants clipboard-sanitized-write through both the request and check handlers", () =>
    Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;
      const partition = yield* browserSessions.getPartition("scope-a");
      yield* browserSessions.getSession("scope-a");

      const browserSession = sessions.get(partition);
      assert.isDefined(browserSession);

      const requestHandler = browserSession.setPermissionRequestHandler.mock.calls[0]?.[0];
      const checkHandler = browserSession.setPermissionCheckHandler.mock.calls[0]?.[0];
      assert.isFunction(requestHandler);
      assert.isFunction(checkHandler);

      const requestAllows = (permission: string): boolean => {
        let granted: boolean | undefined;
        requestHandler(null, permission, (value: boolean) => {
          granted = value;
        });
        assert.isDefined(granted);
        return granted;
      };

      for (const permission of [
        "clipboard-read",
        "clipboard-sanitized-write",
        "notifications",
        "geolocation",
      ]) {
        assert.isTrue(requestAllows(permission), `request handler should allow ${permission}`);
        assert.isTrue(
          checkHandler(null, permission) as boolean,
          `check handler should allow ${permission}`,
        );
      }

      // `clipboard-write` is not a real Electron permission — the async write API
      // uses `clipboard-sanitized-write` — so the stale name must not be granted,
      // and unrelated permissions stay denied.
      for (const permission of ["clipboard-write", "midi"]) {
        assert.isFalse(requestAllows(permission), `request handler should deny ${permission}`);
        assert.isFalse(
          checkHandler(null, permission) as boolean,
          `check handler should deny ${permission}`,
        );
      }
    }).pipe(Effect.provide(layer)),
  );

  it.effect("preserves partition scope and the platform failure chain", () => {
    const nativeCause = new Error("native digest failed");
    const platformCause = PlatformError.systemError({
      _tag: "Unknown",
      module: "Crypto",
      method: "digest",
      cause: nativeCause,
    });
    const failingCryptoLayer = Layer.succeed(
      Crypto.Crypto,
      Crypto.make({
        randomBytes: (size) => new Uint8Array(size),
        digest: () => Effect.fail(platformCause),
      }),
    );

    return Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;
      const error = yield* browserSessions.getPartition("environment-a").pipe(Effect.flip);

      assert.instanceOf(error, BrowserSession.BrowserSessionPartitionDerivationError);
      assert.isTrue(BrowserSession.isBrowserSessionGetSessionError(error));
      assert.isTrue(BrowserSession.isBrowserSessionError(error));
      assert.equal(error.scope, "environment-a");
      assert.strictEqual(error.cause, platformCause);
      assert.strictEqual(error.cause.reason.cause, nativeCause);
      assert.equal(
        error.message,
        "Failed to derive a desktop preview browser partition for scope environment-a.",
      );
      assert.notInclude(error.message, nativeCause.message);
    }).pipe(Effect.provide(BrowserSession.layer.pipe(Layer.provide(failingCryptoLayer))));
  });

  it.effect("preserves session scope, partition, and the Electron failure", () =>
    Effect.gen(function* () {
      const cause = new Error("Electron session failed");
      fromPartition.mockImplementationOnce(() => {
        throw cause;
      });
      const browserSessions = yield* BrowserSession.BrowserSession;
      const partition = yield* browserSessions.getPartition("environment-b");
      const error = yield* browserSessions.getSession("environment-b").pipe(Effect.flip);

      assert.instanceOf(error, BrowserSession.BrowserSessionCreationError);
      assert.isTrue(BrowserSession.isBrowserSessionGetSessionError(error));
      assert.isTrue(BrowserSession.isBrowserSessionError(error));
      assert.equal(error.scope, "environment-b");
      assert.equal(error.partition, partition);
      assert.strictEqual(error.cause, cause);
      assert.equal(
        error.message,
        `Failed to create a desktop preview browser session for scope environment-b (partition ${partition}).`,
      );
      assert.notInclude(error.message, cause.message);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("clears storage and cache for every created session", () =>
    Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;
      yield* browserSessions.getSession("scope-a");
      yield* browserSessions.getSession("scope-b");

      yield* browserSessions.clearCookies();
      yield* browserSessions.clearCache();

      assert.strictEqual(sessions.size, 2);
      for (const browserSession of sessions.values()) {
        assert.strictEqual(browserSession.clearStorageData.mock.calls.length, 1);
        assert.deepEqual(browserSession.clearStorageData.mock.calls[0], [
          {
            storages: ["cookies", "localstorage", "indexdb", "websql", "serviceworkers"],
          },
        ]);
        assert.strictEqual(browserSession.clearCache.mock.calls.length, 1);
      }
    }).pipe(Effect.provide(layer)),
  );

  it.effect("derives a third-party partition under its own prefix, independent of scope", () =>
    Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;

      const first = yield* browserSessions.getThirdPartyBrowserPartition();
      const second = yield* browserSessions.getThirdPartyBrowserPartition();

      assert.strictEqual(first, second);
      assert.isTrue(first.startsWith("persist:devgame-thirdparty-"));
      assert.isFalse(first.startsWith("persist:devgame-preview-"));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("isPartition does not claim a third-party partition as a preview one", () =>
    Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;
      const thirdPartyPartition = yield* browserSessions.getThirdPartyBrowserPartition();

      assert.isFalse(browserSessions.isPartition(thirdPartyPartition));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("isThirdPartyPartition recognizes its own partition and rejects a preview one", () =>
    Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;
      const thirdPartyPartition = yield* browserSessions.getThirdPartyBrowserPartition();
      const previewPartition = yield* browserSessions.getPartition("scope-a");

      assert.isTrue(browserSessions.isThirdPartyPartition(thirdPartyPartition));
      assert.isFalse(browserSessions.isThirdPartyPartition(previewPartition));
    }).pipe(Effect.provide(layer)),
  );

  // F3 (independent security review, 2026-08-04): `startsWith` matching
  // meant `persist:devgame-thirdparty-EVIL` attached with the weakened
  // preference, and a bare prefix with nothing after it was allowed too.
  // There is exactly one third-party partition (one fixed scope), so exact
  // match is available at zero cost — no reason to accept a weaker check.
  it.effect("isThirdPartyPartition rejects a lookalike that merely shares the prefix", () =>
    Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;
      yield* browserSessions.getThirdPartyBrowserPartition();

      assert.isFalse(browserSessions.isThirdPartyPartition("persist:devgame-thirdparty-EVIL"));
      assert.isFalse(browserSessions.isThirdPartyPartition("persist:devgame-thirdparty-"));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("isThirdPartyPartition denies everything before any partition has been derived", () =>
    Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;

      // Deliberately NOT calling getThirdPartyBrowserPartition/Session first
      // — nothing to compare against yet, so this must fail closed, not
      // fall back to a prefix check (that fallback would BE the F3 hole).
      assert.isFalse(browserSessions.isThirdPartyPartition("persist:devgame-thirdparty-anything"));
    }).pipe(Effect.provide(layer)),
  );

  // F1 (independent security review, 2026-08-04), VERIFIED BY EXECUTION:
  // the third-party session was reusing ALLOWED_PREVIEW_PERMISSIONS —
  // scoped, by that constant's own doc, to the user's OWN dev server — and
  // silently granting clipboard-read/clipboard-write/geolocation/
  // notifications to figma.com, notion.so, and anything they link to,
  // WITHOUT a prompt. `navigator.clipboard.readText()` on any focused
  // external page, no prompt, on a machine whose clipboard routinely holds
  // API keys and tokens. Default third-party to denying everything.
  it.effect("denies every permission preview allows — third party gets no free grants", () =>
    Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;
      const partition = yield* browserSessions.getThirdPartyBrowserPartition();
      yield* browserSessions.getThirdPartyBrowserSession();

      const browserSession = sessions.get(partition);
      assert.isDefined(browserSession);
      const requestHandler = browserSession.setPermissionRequestHandler.mock.calls[0]?.[0];
      const checkHandler = browserSession.setPermissionCheckHandler.mock.calls[0]?.[0];
      assert.isFunction(requestHandler);
      assert.isFunction(checkHandler);

      const requestAllows = (permission: string): boolean => {
        let granted: boolean | undefined;
        requestHandler(null, permission, (value: boolean) => {
          granted = value;
        });
        assert.isDefined(granted);
        return granted;
      };

      for (const permission of [
        "clipboard-read",
        "clipboard-sanitized-write",
        "clipboard-write",
        "notifications",
        "geolocation",
        "midi",
      ]) {
        assert.isFalse(requestAllows(permission), `request handler should deny ${permission}`);
        assert.isFalse(
          checkHandler(null, permission) as boolean,
          `check handler should deny ${permission}`,
        );
      }
    }).pipe(Effect.provide(layer)),
  );

  // F4 sign-out (owner ruling, relayed 2026-08-04): the third-party
  // partition is persistent — a login survives app restarts indefinitely,
  // with no user-visible trace and no way to clear it short of a dev tool.
  // "Prove it by executing it, not by asserting the call was made" — so
  // this doesn't just assert `clearStorageData` was called; it tracks a
  // fake per-origin "signed in" flag (mirroring what a real cookie jar
  // does — state that either is or isn't there afterward) and proves
  // sign-out for ONE origin actually clears that origin's flag while
  // leaving the OTHER origin's flag untouched. That selectivity is the
  // whole point: this is ONE shared partition for both Figma and Notion,
  // so "sign out of Figma" must not silently sign the user out of Notion
  // too — only Electron's per-origin `clearStorageData({ origin })` filter
  // makes that possible; a whole-partition clear would not have been
  // "per source" as promised.
  it.effect("signs out of one origin's data without touching the other origin's", () =>
    Effect.gen(function* () {
      const signedInOrigins = new Set(["https://www.figma.com", "https://www.notion.so"]);
      const clearStorageDataCalls: Array<{ origin?: string; storages?: readonly string[] }> = [];
      fromPartition.mockImplementationOnce((partition: string) => {
        const browserSession = {
          clearCache: vi.fn(() => Promise.resolve()),
          clearStorageData: vi.fn((options: { origin?: string; storages?: readonly string[] }) => {
            clearStorageDataCalls.push(options);
            if (options.origin) signedInOrigins.delete(options.origin);
            return Promise.resolve();
          }),
          getUserAgent: vi.fn(() => "Mozilla/5.0 Electron/41.5.0 t3code/0.0.27"),
          setPermissionRequestHandler: vi.fn(),
          setPermissionCheckHandler: vi.fn(),
          setUserAgent: vi.fn(),
        };
        sessions.set(partition, browserSession);
        return browserSession;
      });

      const browserSessions = yield* BrowserSession.BrowserSession;
      assert.isTrue(signedInOrigins.has("https://www.figma.com"));
      assert.isTrue(signedInOrigins.has("https://www.notion.so"));

      yield* browserSessions.clearThirdPartySourceData("https://www.figma.com");

      assert.isFalse(signedInOrigins.has("https://www.figma.com"));
      assert.isTrue(
        signedInOrigins.has("https://www.notion.so"),
        "clearing Figma's origin must not clear Notion's",
      );
      assert.strictEqual(clearStorageDataCalls.length, 1);
      assert.deepEqual(clearStorageDataCalls[0]?.origin, "https://www.figma.com");
      assert.deepEqual(
        [...(clearStorageDataCalls[0]?.storages ?? [])].toSorted(),
        ["cookies", "indexdb", "localstorage", "serviceworkers", "websql"].toSorted(),
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "clearThirdPartySourceData does not touch preview sessions or the whole-partition clear methods",
    () =>
      Effect.gen(function* () {
        const browserSessions = yield* BrowserSession.BrowserSession;
        yield* browserSessions.getSession("scope-a");
        const previewPartition = yield* browserSessions.getPartition("scope-a");
        const previewSession = sessions.get(previewPartition);
        assert.isDefined(previewSession);

        yield* browserSessions.clearThirdPartySourceData("https://www.figma.com");

        assert.strictEqual(previewSession.clearStorageData.mock.calls.length, 0);
        assert.strictEqual(previewSession.clearCache.mock.calls.length, 0);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("memoizes the third-party session the same way preview sessions are memoized", () =>
    Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;

      const first = yield* browserSessions.getThirdPartyBrowserSession();
      const second = yield* browserSessions.getThirdPartyBrowserSession();

      assert.strictEqual(first, second);
      assert.strictEqual(fromPartition.mock.calls.length, 1);
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "clearCookies/clearCache never touch the third-party session — it is preview-only cleanup",
    () =>
      Effect.gen(function* () {
        const browserSessions = yield* BrowserSession.BrowserSession;
        yield* browserSessions.getSession("scope-a");
        const thirdPartySession = yield* browserSessions.getThirdPartyBrowserSession();

        yield* browserSessions.clearCookies();
        yield* browserSessions.clearCache();

        assert.strictEqual(
          (thirdPartySession as unknown as { clearStorageData: ReturnType<typeof vi.fn> })
            .clearStorageData.mock.calls.length,
          0,
        );
        assert.strictEqual(
          (thirdPartySession as unknown as { clearCache: ReturnType<typeof vi.fn> }).clearCache.mock
            .calls.length,
          0,
        );
      }).pipe(Effect.provide(layer)),
  );

  it.effect("correlates clear failures while still attempting every session", () =>
    Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;
      yield* browserSessions.getSession("scope-a");
      yield* browserSessions.getSession("scope-b");
      const firstPartition = yield* browserSessions.getPartition("scope-a");
      const secondPartition = yield* browserSessions.getPartition("scope-b");
      const firstSession = sessions.get(firstPartition);
      const secondSession = sessions.get(secondPartition);
      assert.isDefined(firstSession);
      assert.isDefined(secondSession);

      const storageCause = new Error("storage clear failed");
      secondSession.clearStorageData.mockImplementationOnce(() => Promise.reject(storageCause));
      const storageError = yield* browserSessions.clearCookies().pipe(Effect.flip);

      assert.instanceOf(storageError, BrowserSession.BrowserSessionStorageClearError);
      assert.isTrue(BrowserSession.isBrowserSessionError(storageError));
      assert.equal(storageError.partition, secondPartition);
      assert.strictEqual(storageError.cause, storageCause);
      assert.equal(
        storageError.message,
        `Failed to clear desktop preview browser storage for partition ${secondPartition}.`,
      );
      assert.notInclude(storageError.message, storageCause.message);
      for (const browserSession of sessions.values()) {
        assert.strictEqual(browserSession.clearStorageData.mock.calls.length, 1);
      }

      const cacheCause = new Error("cache clear failed");
      firstSession.clearCache.mockImplementationOnce(() => Promise.reject(cacheCause));
      const cacheError = yield* browserSessions.clearCache().pipe(Effect.flip);

      assert.instanceOf(cacheError, BrowserSession.BrowserSessionCacheClearError);
      assert.isTrue(BrowserSession.isBrowserSessionError(cacheError));
      assert.equal(cacheError.partition, firstPartition);
      assert.strictEqual(cacheError.cause, cacheCause);
      assert.equal(
        cacheError.message,
        `Failed to clear the desktop preview browser cache for partition ${firstPartition}.`,
      );
      assert.notInclude(cacheError.message, cacheCause.message);
      for (const browserSession of sessions.values()) {
        assert.strictEqual(browserSession.clearCache.mock.calls.length, 1);
      }
    }).pipe(Effect.provide(layer)),
  );
});
