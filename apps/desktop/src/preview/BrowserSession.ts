import type { Session } from "electron";
import { session } from "electron";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as SynchronizedRef from "effect/SynchronizedRef";

const PREVIEW_PARTITION_PREFIX = "persist:devgame-preview-";

// Third-party browser-panel destinations (Figma, Notion — see
// docs/workbench/three-feature-decisions.md #4) get their OWN prefix, not a
// scope under the preview one. A Figma tab is not a preview of anything, and
// it deliberately does NOT go through the thread/environment-scoped preview-
// session machinery (`Manager.ts`'s `openPreviewSession` chain) — reusing
// `persist:devgame-preview-` would make the partition name lie about what it
// holds and imply a relationship to that machinery this was built to avoid.
//
// ONE shared scope for every third-party destination (owner ruling, relayed
// 2026-08-04): cookies are already origin-scoped WITHIN a partition — Figma
// and Notion cookies can't leak into each other whether or not they share a
// partition — so a separate partition per product buys no real isolation,
// only more surface to reason about. `getThirdPartyBrowserPartition`/
// `getThirdPartyBrowserSession` take no scope argument at all: there is
// exactly one third-party partition, by construction, so it can't fragment
// by accident the way a caller-supplied scope string could.
//
// WHAT THIS STORES, PLAINLY: real third-party login cookies (and
// localStorage/IndexedDB), persisted to disk by Electron because the
// partition name is `persist:`-prefixed — exactly what keeping a user logged
// into Figma/Notion across app restarts requires, and exactly what the owner
// asked for ("no repeated logins"). Clearing this partition's storage signs
// the user out of every third-party destination at once; nothing here
// prunes or expires it automatically.
//
// Deliberately excluded from `clearCookies`/`clearCache` below: those two
// methods exist to reset PREVIEW data (the user's own dev-server browsing)
// and iterate `sessionsRef`. Third-party sessions live in their own
// `thirdPartySessionsRef` specifically so a "reset preview data" action can
// never silently sign the user out of Figma/Notion as a side effect.
const THIRD_PARTY_PARTITION_PREFIX = "persist:devgame-thirdparty-";
const THIRD_PARTY_BROWSER_SCOPE = "third-party-tabs";

// Permissions granted to preview web content. `clipboard-sanitized-write` is the
// Electron permission behind `navigator.clipboard.writeText()` — note it is NOT
// `clipboard-write`, which is not a valid Electron permission name. Async
// clipboard writes are gated by the permission *check* handler (not only the
// request handler), so both handlers must allow it; otherwise built-in "Copy"
// buttons — e.g. the Next.js / Vercel error overlay — fail with
// `Failed to execute 'writeText' on 'Clipboard': Write permission denied`.
const ALLOWED_PREVIEW_PERMISSIONS: ReadonlySet<string> = new Set([
  "clipboard-read",
  "clipboard-sanitized-write",
  "notifications",
  "geolocation",
]);

// F1 (independent security review, 2026-08-04), VERIFIED BY EXECUTION: the
// third-party session was reusing ALLOWED_PREVIEW_PERMISSIONS above —
// scoped, by ITS OWN doc comment, to the user's own dev server — which
// silently granted clipboard-read/clipboard-write/geolocation/notifications
// to figma.com, notion.so, and anything either links to, with NO prompt.
// `navigator.clipboard.readText()` on any focused external page, no
// prompt, on a machine whose clipboard routinely holds API keys and
// tokens. Deliberately EMPTY: deny everything by default. Add specific
// permissions back only with actual evidence Figma/Notion need them to
// function — none has been demonstrated yet, and a blanket preview-shaped
// allow-set for untrusted external content was exactly the mistake.
const ALLOWED_THIRD_PARTY_PERMISSIONS: ReadonlySet<string> = new Set([]);

export class BrowserSessionPartitionDerivationError extends Schema.TaggedErrorClass<BrowserSessionPartitionDerivationError>()(
  "BrowserSessionPartitionDerivationError",
  {
    scope: Schema.String,
    cause: Schema.instanceOf(PlatformError.PlatformError),
  },
) {
  override get message(): string {
    return `Failed to derive a desktop preview browser partition for scope ${this.scope}.`;
  }
}

export class BrowserSessionCreationError extends Schema.TaggedErrorClass<BrowserSessionCreationError>()(
  "BrowserSessionCreationError",
  {
    scope: Schema.String,
    partition: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to create a desktop preview browser session for scope ${this.scope} (partition ${this.partition}).`;
  }
}

export class BrowserSessionStorageClearError extends Schema.TaggedErrorClass<BrowserSessionStorageClearError>()(
  "BrowserSessionStorageClearError",
  {
    partition: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to clear desktop preview browser storage for partition ${this.partition}.`;
  }
}

export class BrowserSessionCacheClearError extends Schema.TaggedErrorClass<BrowserSessionCacheClearError>()(
  "BrowserSessionCacheClearError",
  {
    partition: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to clear the desktop preview browser cache for partition ${this.partition}.`;
  }
}

// G9 (independent security review, 2026-08-04, INFO): guards the invariant
// that `sessionsRef` (preview) and `thirdPartySessionsRef` (third-party)
// never resolve the same partition string — see `resolveSession`'s own
// comment for why a silent collision would be a handler-clobbering bug,
// not just a wasted allocation.
export class BrowserSessionPartitionCollisionError extends Schema.TaggedErrorClass<BrowserSessionPartitionCollisionError>()(
  "BrowserSessionPartitionCollisionError",
  {
    scope: Schema.String,
    partition: Schema.String,
  },
) {
  override get message(): string {
    return `Partition ${this.partition} (scope ${this.scope}) is already claimed by the other browser-session cache — refusing to create a second session for it.`;
  }
}

export class BrowserSessionThirdPartySignOutError extends Schema.TaggedErrorClass<BrowserSessionThirdPartySignOutError>()(
  "BrowserSessionThirdPartySignOutError",
  {
    origin: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to sign out of the third-party source at origin ${this.origin}.`;
  }
}

export const BrowserSessionGetSessionError = Schema.Union([
  BrowserSessionPartitionDerivationError,
  BrowserSessionCreationError,
  BrowserSessionPartitionCollisionError,
]);
export type BrowserSessionGetSessionError = typeof BrowserSessionGetSessionError.Type;
export const isBrowserSessionGetSessionError = Schema.is(BrowserSessionGetSessionError);

export const BrowserSessionError = Schema.Union([
  BrowserSessionPartitionDerivationError,
  BrowserSessionCreationError,
  BrowserSessionPartitionCollisionError,
  BrowserSessionStorageClearError,
  BrowserSessionCacheClearError,
  BrowserSessionThirdPartySignOutError,
]);
export type BrowserSessionError = typeof BrowserSessionError.Type;
export const isBrowserSessionError = Schema.is(BrowserSessionError);

export class BrowserSession extends Context.Service<
  BrowserSession,
  {
    readonly getPartition: (
      scope?: string,
    ) => Effect.Effect<string, BrowserSessionPartitionDerivationError>;
    readonly isPartition: (partition: string) => boolean;
    readonly getSession: (scope?: string) => Effect.Effect<Session, BrowserSessionGetSessionError>;
    readonly clearCookies: () => Effect.Effect<void, BrowserSessionStorageClearError>;
    readonly clearCache: () => Effect.Effect<void, BrowserSessionCacheClearError>;
    /** The one shared partition for every third-party browser-panel
     * destination (Figma, Notion, ...) — see the module doc above for why
     * this takes no scope argument and why it's excluded from
     * `clearCookies`/`clearCache`. */
    readonly getThirdPartyBrowserPartition: () => Effect.Effect<
      string,
      BrowserSessionPartitionDerivationError
    >;
    readonly getThirdPartyBrowserSession: () => Effect.Effect<
      Session,
      BrowserSessionGetSessionError
    >;
    readonly isThirdPartyPartition: (partition: string) => boolean;
    /** F4 (owner ruling, relayed 2026-08-04): sign a user out of ONE
     * third-party source without touching the other's login, even though
     * both share the one partition above. Electron's `clearStorageData`
     * accepts an `origin` filter, so this clears cookies/storage for
     * exactly the given origin — NOT `clearCache()`, which has no origin
     * filter and would touch the shared partition's cache for both
     * products.
     *
     * BOUNDED RESIDUAL, VERIFIED BY EXECUTION (not assumed): credentials
     * are cleared — the next request from this origin will not
     * authenticate — but previously-cached response BODIES for this
     * origin can remain on disk after sign-out. Proven directly: a probe
     * loaded a page from a local server that set a cookie and returned
     * `Cache-Control: max-age=3600`, ran this exact clear (cookies only,
     * no cache), killed the server, and reloaded the same URL in the same
     * session — the page still rendered the original response body from
     * disk, with no server able to answer. An authenticated Figma/Notion
     * view (file names, thumbnails, team/project names) can behave the
     * same way. This is exactly the shared-machine scenario the feature
     * exists for, so it's recorded here rather than assumed safe: the gap
     * is real, not merely theoretical, and the decision to accept it
     * (rather than clear the whole partition's cache and degrade the
     * OTHER product) stands as originally made. */
    readonly clearThirdPartySourceData: (
      origin: string,
    ) => Effect.Effect<void, BrowserSessionGetSessionError | BrowserSessionThirdPartySignOutError>;
  }
>()("@t3tools/desktop/preview/BrowserSession") {}

export const make = Effect.gen(function* BrowserSessionMake() {
  const crypto = yield* Crypto.Crypto;
  const sessionsRef = yield* SynchronizedRef.make<ReadonlyMap<string, Session>>(new Map());
  const thirdPartySessionsRef = yield* SynchronizedRef.make<ReadonlyMap<string, Session>>(
    new Map(),
  );

  const derivePartition = (prefix: string) =>
    Effect.fn("BrowserSession.derivePartition")(function* (scope: string) {
      const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(scope)).pipe(
        Effect.mapError(
          (cause) =>
            new BrowserSessionPartitionDerivationError({
              scope,
              cause,
            }),
        ),
      );
      return `${prefix}${Encoding.encodeHex(digest).slice(0, 20)}`;
    });

  // G5 (independent security review, follow-up to F3, 2026-08-04): preview
  // has MANY legitimate partitions — one per scope — so F3's single-string
  // cache doesn't generalize directly; this is the Set equivalent. Every
  // successful derivation adds its result here, and `isPartition` (below)
  // checks membership instead of a `startsWith` prefix match. Without
  // this, `persist:devgame-preview-anything` satisfied the prefix check
  // for ANY suffix, and DesktopWindow.ts's `will-attach-webview` handler
  // only strips a renderer-supplied `preload` for third-party partitions —
  // on the assumption that "classified as preview" means "really is a
  // preview session" backed by this process's own derivation. Same safety
  // argument as F3's cache: a webview can only plausibly request a
  // partition AFTER the renderer has already called `getPreviewConfig`
  // (which calls `getSession` → this derivation) for that scope, so the
  // set is always populated before a real attach attempt could reach it.
  const derivedPreviewPartitions = new Set<string>();

  const derivePreviewPartitionForScope = derivePartition(PREVIEW_PARTITION_PREFIX);
  const derivePreviewPartition = Effect.fn("BrowserSession.getPartition")(function* (
    scope = "shared",
  ) {
    const partition = yield* derivePreviewPartitionForScope(scope);
    derivedPreviewPartitions.add(partition);
    return partition;
  });

  // G9 (independent security review, 2026-08-04, INFO): `sessionsRef` and
  // `thirdPartySessionsRef` are two separate caches over ONE global
  // Electron session registry — `session.fromPartition(partition)` returns
  // the SAME underlying Session object for the same partition string
  // regardless of which cache asked for it. The two partition prefixes
  // make a collision impossible today, but if that ever changed (a prefix
  // constant edited, or the two prefixes' derivation ever produced the
  // same string), the SECOND `resolveSession` call would silently REBIND
  // `setPermissionRequestHandler`/`setPermissionCheckHandler` on the
  // shared session — Electron only keeps the last-registered handler — so
  // whichever cache resolved second would silently downgrade or upgrade
  // the OTHER cache's permission posture on what both believed was their
  // own isolated session, with no error. Guarded here rather than left as
  // an invariant nothing enforces: `otherRef` is the sibling cache: if
  // IT already holds this exact partition, fail loudly instead of
  // creating a second, handler-clobbering session.
  const resolveSession = (
    ref: SynchronizedRef.SynchronizedRef<ReadonlyMap<string, Session>>,
    otherRef: SynchronizedRef.SynchronizedRef<ReadonlyMap<string, Session>>,
    scope: string,
    partition: string,
    allowedPermissions: ReadonlySet<string>,
  ) =>
    SynchronizedRef.modifyEffect(ref, (sessions) => {
      const existing = sessions.get(partition);
      if (existing) return Effect.succeed([existing, sessions] as const);
      return Effect.gen(function* () {
        const otherSessions = yield* SynchronizedRef.get(otherRef);
        if (otherSessions.has(partition)) {
          return yield* Effect.fail(
            new BrowserSessionPartitionCollisionError({ scope, partition }),
          );
        }
        return yield* Effect.try({
          try: () => {
            const browserSession = session.fromPartition(partition);
            const userAgent = browserSession
              .getUserAgent()
              .replace(/Electron\/[\d.]+ /, "")
              .replace(/\s*t3code\/[\d.]+/, "");
            browserSession.setUserAgent(userAgent);
            browserSession.setPermissionRequestHandler((_webContents, permission, callback) => {
              callback(allowedPermissions.has(permission));
            });
            browserSession.setPermissionCheckHandler((_webContents, permission) =>
              allowedPermissions.has(permission),
            );
            const next = new Map(sessions);
            next.set(partition, browserSession);
            return [browserSession, next] as const;
          },
          catch: (cause) =>
            new BrowserSessionCreationError({
              scope,
              partition,
              cause,
            }),
        });
      });
    });

  const getSession = Effect.fn("BrowserSession.getSession")(function* (scope = "shared") {
    const partition = yield* derivePreviewPartition(scope);
    return yield* resolveSession(
      sessionsRef,
      thirdPartySessionsRef,
      scope,
      partition,
      ALLOWED_PREVIEW_PERMISSIONS,
    );
  });

  // F3 (independent security review, 2026-08-04): `isThirdPartyPartition`
  // used to be a `startsWith` prefix check, which let
  // `persist:devgame-thirdparty-EVIL` (or a bare prefix with nothing after
  // it) attach with the weakened preference. There is exactly ONE
  // third-party partition — one fixed scope — so exact match is available
  // at zero cost. Cached here on first successful derivation rather than
  // recomputed synchronously (the digest is an Effect, `isThirdPartyPartition`
  // is a plain sync predicate the `will-attach-webview` handler calls). Safe
  // in practice: a webview can only ever request this partition after the
  // renderer has already called `getThirdPartyBrowserConfig`, which calls
  // `getThirdPartyBrowserSession` (→ this derivation) BEFORE handing out the
  // partition string at all — so the cache is always populated before any
  // attach attempt could plausibly reach the handler. Before that, or if
  // nothing has ever derived it, this fails CLOSED (denies everything)
  // rather than falling back to a prefix check, which would reintroduce
  // the exact hole this fixes.
  let thirdPartyBrowserPartitionCache: string | null = null;

  const getThirdPartyPartition = derivePartition(THIRD_PARTY_PARTITION_PREFIX);
  const getThirdPartyBrowserPartition = Effect.fn("BrowserSession.getThirdPartyBrowserPartition")(
    function* () {
      const partition = yield* getThirdPartyPartition(THIRD_PARTY_BROWSER_SCOPE);
      thirdPartyBrowserPartitionCache = partition;
      return partition;
    },
  );

  const getThirdPartyBrowserSession = Effect.fn("BrowserSession.getThirdPartyBrowserSession")(
    function* () {
      const partition = yield* getThirdPartyBrowserPartition();
      return yield* resolveSession(
        thirdPartySessionsRef,
        sessionsRef,
        THIRD_PARTY_BROWSER_SCOPE,
        partition,
        ALLOWED_THIRD_PARTY_PERMISSIONS,
      );
    },
  );

  // F4: origin-scoped sign-out. Deliberately calls ONLY
  // `clearStorageData({ origin, ... })` — never `clearCache()` — because
  // the cache API has no origin filter and the third-party partition is
  // shared between Figma and Notion; calling it here would clear the
  // OTHER product's cache too, which is not what "sign out of Figma" means.
  // Credentials are cleared; cached response bodies for this origin are
  // NOT — see the interface doc above, VERIFIED BY EXECUTION, for the
  // bounded residual this leaves.
  const clearThirdPartySourceData = Effect.fn("BrowserSession.clearThirdPartySourceData")(
    function* (origin: string) {
      const browserSession = yield* getThirdPartyBrowserSession();
      yield* Effect.tryPromise({
        try: () =>
          browserSession.clearStorageData({
            origin,
            storages: ["cookies", "localstorage", "indexdb", "websql", "serviceworkers"],
          }),
        catch: (cause) => new BrowserSessionThirdPartySignOutError({ origin, cause }),
      });
    },
  );

  return BrowserSession.of({
    getPartition: derivePreviewPartition,
    isPartition: (partition) => derivedPreviewPartitions.has(partition),
    getSession,
    getThirdPartyBrowserPartition,
    getThirdPartyBrowserSession,
    isThirdPartyPartition: (partition) =>
      thirdPartyBrowserPartitionCache !== null && partition === thirdPartyBrowserPartitionCache,
    clearThirdPartySourceData,
    clearCookies: Effect.fn("BrowserSession.clearCookies")(function* () {
      const sessions = yield* SynchronizedRef.get(sessionsRef);
      yield* Effect.all(
        [...sessions.entries()].map(([partition, browserSession]) =>
          Effect.tryPromise({
            try: () =>
              browserSession.clearStorageData({
                storages: ["cookies", "localstorage", "indexdb", "websql", "serviceworkers"],
              }),
            catch: (cause) =>
              new BrowserSessionStorageClearError({
                partition,
                cause,
              }),
          }),
        ),
        { concurrency: "unbounded", discard: true },
      );
    }),
    clearCache: Effect.fn("BrowserSession.clearCache")(function* () {
      const sessions = yield* SynchronizedRef.get(sessionsRef);
      yield* Effect.all(
        [...sessions.entries()].map(([partition, browserSession]) =>
          Effect.tryPromise({
            try: () => browserSession.clearCache(),
            catch: (cause) =>
              new BrowserSessionCacheClearError({
                partition,
                cause,
              }),
          }),
        ),
        { concurrency: "unbounded", discard: true },
      );
    }),
  });
}).pipe(Effect.withSpan("BrowserSession.make"));

export const layer = Layer.effect(BrowserSession, make);
