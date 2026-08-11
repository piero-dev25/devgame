// #113: `failEnvironmentInternal`'s error log used to pass the raw `error`
// object straight to `Effect.logError`'s metadata. `Logger.consolePretty()`
// (serverLogger.ts) formats that metadata with Node's default `util.inspect`
// object-depth cap, which silently printed `[Object]` past two levels of
// nesting — exactly the depth a real chain like auth error ->
// bootstrap-credential error -> `BootstrapCredentialConsumeAvailableError`
// -> the actual SQL/decode failure reaches. Found live: three real
// `browser_session_issuance_failed` failures on a long-lived instance each
// logged nothing past `BootstrapCredentialConsumeAvailableError`'s own tag —
// the underlying cause was already lost by the time it reached disk.
//
// F4 (2026-08-05, merge-gate review against f26ccc527): #113's own fix —
// `depth: null` — removed the INCIDENTAL containment the previous `depth: 2`
// default provided, with no size bound at all, on the single funnel for
// every `failEnvironmentInternal` call site (14+, including
// `pairing_credential_issuance_failed`). A failed INSERT during pairing-
// credential issuance could print a SQL driver's own bound parameters —
// which, for that call site, ARE the credential — at unlimited depth. See
// `failEnvironmentInternal`'s own `INSPECT_OPTIONS` doc comment for the fix.
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";

import { failEnvironmentInternal } from "./http.ts";

/** Captures whatever `failEnvironmentInternal` logged as `cause`, via the
 * same "record every message argument, find the one with a `cause` key"
 * pattern the #113 test above uses — kept as a shared helper so the F4
 * tests below don't re-derive it. */
const captureLoggedCause = (error: unknown) =>
  Effect.gen(function* () {
    const messages: Array<unknown> = [];
    const logger = Logger.make<unknown, void>((options) => {
      if (Array.isArray(options.message)) {
        messages.push(...options.message);
      } else {
        messages.push(options.message);
      }
    });
    yield* Effect.exit(failEnvironmentInternal("browser_session_issuance_failed", error)).pipe(
      Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
    );
    const logged = messages.find(
      (message): message is Record<string, unknown> =>
        typeof message === "object" && message !== null && "cause" in message,
    );
    assert.exists(logged);
    assert.strictEqual(typeof logged.cause, "string");
    return String(logged.cause);
  });

it.effect(
  "failEnvironmentInternal logs the full cause chain as a string, not a depth-truncated object",
  () => {
    const messages: Array<unknown> = [];
    const logger = Logger.make<unknown, void>((options) => {
      if (Array.isArray(options.message)) {
        messages.push(...options.message);
      } else {
        messages.push(options.message);
      }
    });

    // Three levels deep — matches the real shape found live: an outer auth
    // error wraps `BootstrapCredentialConsumeAvailableError`, which wraps the
    // actual SQL/decode failure. Node's default `util.inspect` depth (2)
    // would print `[Object]` for this innermost level if it weren't
    // pre-serialized before logging.
    const deepCause = {
      _tag: "ServerAuthBootstrapCredentialValidationError",
      cause: {
        _tag: "BootstrapCredentialConsumeAvailableError",
        cause: {
          _tag: "SqlError",
          message: "SQLITE_BUSY: database is locked",
        },
      },
    };

    return Effect.gen(function* () {
      yield* Effect.exit(failEnvironmentInternal("browser_session_issuance_failed", deepCause));

      const logged = messages.find(
        (message): message is Record<string, unknown> =>
          typeof message === "object" && message !== null && "cause" in message,
      );
      assert.exists(logged);
      // A STRING, not the raw nested object — a string is never subject to
      // the logger's own object-depth truncation.
      assert.strictEqual(typeof logged.cause, "string");
      // The innermost detail — the whole point of the fix — must survive.
      assert.ok(String(logged.cause).includes("SQLITE_BUSY: database is locked"));
      assert.ok(String(logged.cause).includes("BootstrapCredentialConsumeAvailableError"));
      assert.ok(String(logged.cause).includes("ServerAuthBootstrapCredentialValidationError"));
    }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
  },
);

it.effect("failEnvironmentInternal logs nothing when no error is supplied", () => {
  const messages: Array<unknown> = [];
  const logger = Logger.make<unknown, void>((options) => {
    if (Array.isArray(options.message)) {
      messages.push(...options.message);
    } else {
      messages.push(options.message);
    }
  });

  return Effect.gen(function* () {
    yield* Effect.exit(failEnvironmentInternal("browser_session_cookie_failed"));
    assert.strictEqual(messages.length, 0);
  }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
});

// F4: proof this fails against `depth: null` — the object below is short
// enough (well under `sanitizeFailureDetail`'s 2,000-char bound) that
// `depth: null` would print it in full, marker and all. Only a real depth
// cap keeps the marker out.
const SECRET_MARKER = "SECRET_CREDENTIAL_VALUE_MARKER_9f3a";

function nestCause(depth: number, innermost: unknown): unknown {
  return depth <= 0
    ? innermost
    : { _tag: `Level${depth}Error`, cause: nestCause(depth - 1, innermost) };
}

it.effect("a secret-shaped value past the depth-8 boundary never reaches the logged string", () =>
  Effect.gen(function* () {
    // 12 levels of `.cause` nesting — well past `INSPECT_OPTIONS.depth: 8`
    // (see that constant's own doc comment for why 8, not fewer) — with
    // the secret sitting at the very bottom, mirroring how a SQL driver
    // attaches bound parameters to the INNERMOST error in a chain like
    // auth error -> bootstrap-credential error -> the driver's own error.
    const deepCause = nestCause(12, {
      _tag: "SqlError",
      boundParameters: [SECRET_MARKER],
    });
    const logged = yield* captureLoggedCause(deepCause);
    assert.ok(!logged.includes(SECRET_MARKER), "secret-shaped value leaked past the depth cap");
    // The chain's own shape up to the cap must still be visible — this
    // isn't a blanket "everything gets swallowed" regression of #113's
    // own fix, only depth beyond 8 is bounded.
    assert.ok(logged.includes("Level12Error"));
    assert.ok(logged.includes("Level9Error"));
  }),
);

it.effect("the 3-level chain #113 needed survives — depth: 8 does not regress that fix", () =>
  Effect.gen(function* () {
    const deepCause = {
      _tag: "ServerAuthBootstrapCredentialValidationError",
      cause: {
        _tag: "BootstrapCredentialConsumeAvailableError",
        cause: { _tag: "SqlError", message: "SQLITE_BUSY: database is locked" },
      },
    };
    const logged = yield* captureLoggedCause(deepCause);
    assert.ok(logged.includes("SQLITE_BUSY: database is locked"));
    assert.ok(logged.includes("BootstrapCredentialConsumeAvailableError"));
    assert.ok(logged.includes("ServerAuthBootstrapCredentialValidationError"));
  }),
);

it.effect("an oversized single string value is bounded by maxStringLength, not just depth", () =>
  Effect.gen(function* () {
    const longSecret = SECRET_MARKER.repeat(200); // ~7,200 chars — over both bounds
    const logged = yield* captureLoggedCause({ _tag: "SqlError", message: longSecret });
    assert.ok(logged.length < longSecret.length);
  }),
);

it.effect(
  "sanitizeFailureDetail's own path-scrubbing applies here too — reused, not reinvented",
  () =>
    Effect.gen(function* () {
      // `/Users/<name>/...` is exactly the shape `stripAbsolutePaths`
      // (failureDetail.ts, reused by this funnel) rewrites to `~/...`.
      const logged = yield* captureLoggedCause({
        _tag: "SqlError",
        message: "ENOENT: /Users/piero/Projects/Deepmind/db.sqlite not found",
      });
      assert.ok(!logged.includes("/Users/piero/"));
      assert.ok(logged.includes("~/Projects/Deepmind/db.sqlite"));
    }),
);
