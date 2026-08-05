// #87 investigation finding: `PrimaryEnvironmentRequestError.fromCause`
// (auth.ts:48-62) computes `status = readHttpApiStatus(cause) ?? 500` — a
// HARDCODED FALLBACK whenever the cause can't be classified as either an
// `EnvironmentHttpCommonError` (a well-formed error body the server sent
// back) or an `HttpClientError` that actually carries a `.response` (a real
// HTTP response was received, just not a 2xx). Anything else — a client-side
// throw before any network round-trip happened at all, an aborted request,
// a plain JS error from somewhere in the auth/bearer-token pipeline — gets
// mislabeled "HTTP 500" via `PrimaryEnvironmentRequestError.message`
// ("Primary environment request failed during fetch-session-state (HTTP
// 500).", the exact string the owner saw), even though the server never
// actually returned a 500 — in the #87 repro's server.trace.ndjson, there is
// zero occurrence of any failed (or even second) `/api/auth/session`
// request, meaning the request most likely never reached the server's HTTP
// layer at all.
//
// This test proves the mechanism, not the trigger: a cause that carries NO
// real HTTP status produces a message indistinguishable from a genuine
// server-side 500. See #87's investigation notes for the full evidence
// chain (desktop.trace.ndjson timeline, the dev-mode Vite proxy hop
// `target.ts`'s `resolveHttpRequestBaseUrl` routes primary requests through
// that curl bypasses entirely).
import { EnvironmentInternalError } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import { HttpClientError, HttpClientRequest } from "effect/unstable/http";

import { PrimaryEnvironmentRequestError } from "./auth";

describe("PrimaryEnvironmentRequestError.fromCause", () => {
  it("defaults to HTTP 500 for a cause that never carries a real HTTP status — a plain client-side throw", () => {
    // No network round-trip at all: e.g. a rejected promise from the
    // bearer-token IPC step (httpLayer.ts's withPrimaryBearerToken wraps
    // desktopAuth.ts's readDesktopPrimaryBearerToken in Effect.promise,
    // which turns a rejection into a defect, not a typed HttpClientError).
    const clientSideCause = new Error("bearer token IPC channel not ready");

    const error = PrimaryEnvironmentRequestError.fromCause({
      operation: "fetch-session-state",
      cause: clientSideCause,
    });

    expect(error.status).toBe(500);
    expect(error.message).toBe(
      "Primary environment request failed during fetch-session-state (HTTP 500).",
    );
  });

  it("defaults to HTTP 500 for an HttpClientError with no response — a transport failure, not a server error", () => {
    // HttpClientError.isHttpClientError(cause) is true here, but
    // readHttpApiStatus only trusts it when `.response !== undefined` — a
    // TransportError (connection refused/reset, DNS failure, an aborted
    // fetch) never received a response at all.
    const transportFailure = new HttpClientError.HttpClientError({
      reason: new HttpClientError.TransportError({
        request: HttpClientRequest.get("http://127.0.0.1:13775/api/auth/session"),
        cause: new TypeError("Failed to fetch"),
      }),
    });

    const error = PrimaryEnvironmentRequestError.fromCause({
      operation: "fetch-session-state",
      cause: transportFailure,
    });

    expect(error.status).toBe(500);
  });

  it("is indistinguishable, from the rendered message alone, from a genuine server-side 500 — the actual finding", () => {
    // A REAL EnvironmentInternalError instance — constructed the same way
    // the server would (the server genuinely erred, and said so in a shape
    // the client recognizes via isEnvironmentHttpCommonError's schema
    // check). This is a materially DIFFERENT code path than the two tests
    // above: readHttpApiStatus's FIRST branch (readEnvironmentHttpErrorStatus)
    // handles this, not the `?? 500` fallback. Compare error.message to the
    // two cases above: identical text, opposite truth about what actually
    // happened server-side.
    const genuineServerCause = new EnvironmentInternalError({
      code: "internal_error",
      reason: "internal_error",
      traceId: "trace-1",
    });

    const error = PrimaryEnvironmentRequestError.fromCause({
      operation: "fetch-session-state",
      cause: genuineServerCause,
    });

    expect(error.status).toBe(500);
    expect(error.message).toBe(
      "Primary environment request failed during fetch-session-state (HTTP 500).",
    );
  });
});
