// #87: `PrimaryEnvironmentRequestError.fromCause` used to compute
// `status = readHttpApiStatus(cause) ?? 500` — a hardcoded fallback
// whenever the cause couldn't be classified as either an
// `EnvironmentHttpCommonError` (a well-formed error body the server sent
// back) or an `HttpClientError` that actually carries a `.response` (a real
// HTTP response was received, just not a 2xx). Anything else — a client-side
// throw before any network round-trip happened at all, an aborted request,
// a plain JS error from somewhere in the auth/bearer-token pipeline — got
// mislabeled "HTTP 500", even though the server never actually returned a
// 500. In the #87 repro's server.trace.ndjson, there was zero occurrence of
// any failed (or even second) `/api/auth/session` request, meaning the
// renderer's request most likely never reached the server's HTTP layer at
// all — the "HTTP 500" the owner saw was fabricated, not observed.
//
// Fixed: `status` is now `number | null`. `null` means no real HTTP status
// is known, and the message says so honestly ("no response received")
// instead of inventing one. These tests were originally written to prove
// the OLD bug (both cases below rendered identically to a genuine 500);
// they now prove the fix — the two cases are `null`, and are
// distinguishable from a genuine server-side 500 in the rendered message.
import { EnvironmentInternalError } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import { HttpClientError, HttpClientRequest } from "effect/unstable/http";

import { PrimaryEnvironmentRequestError } from "./auth";

describe("PrimaryEnvironmentRequestError.fromCause", () => {
  it("does NOT fabricate HTTP 500 for a cause that never carries a real HTTP status — a plain client-side throw", () => {
    // No network round-trip at all: e.g. a rejected promise from the
    // bearer-token IPC step (httpLayer.ts's withPrimaryBearerToken wraps
    // desktopAuth.ts's readDesktopPrimaryBearerToken in Effect.promise,
    // which turns a rejection into a defect, not a typed HttpClientError).
    const clientSideCause = new Error("bearer token IPC channel not ready");

    const error = PrimaryEnvironmentRequestError.fromCause({
      operation: "fetch-session-state",
      cause: clientSideCause,
    });

    expect(error.status).toBe(null);
    expect(error.message).toBe(
      "Primary environment request failed during fetch-session-state (no response received).",
    );
  });

  it("does NOT fabricate HTTP 500 for an HttpClientError with no response — a transport failure, not a server error", () => {
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

    expect(error.status).toBe(null);
    expect(error.message).toBe(
      "Primary environment request failed during fetch-session-state (no response received).",
    );
  });

  it("is now distinguishable from a genuine server-side 500 — the actual fix", () => {
    // A REAL EnvironmentInternalError instance — constructed the same way
    // the server would (the server genuinely erred, and said so in a shape
    // the client recognizes via isEnvironmentHttpCommonError's schema
    // check). readHttpApiStatus's FIRST branch (readEnvironmentHttpErrorStatus)
    // handles this, not the (now-removed) `?? 500` fallback. Before the fix,
    // this rendered identically to the two cases above; now it doesn't.
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
