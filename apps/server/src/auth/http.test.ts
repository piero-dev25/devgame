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
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";

import { failEnvironmentInternal } from "./http.ts";

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
