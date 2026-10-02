// Proves the fork routes keep their auth semantics after moving onto
// upstream's `executeAuthenticatedEnvironmentHttpRequest`: cookie sessions
// still send credentials, a fork route's 401 `EnvironmentAuthInvalidError`
// drives upstream's one-shot DPoP renewal, a static prepared DPoP token is not
// retried forever, and an undeclared status rejects instead of being decoded
// as a domain result.
import { describe, expect, it } from "@effect/vitest";
import { RelayConnectionTarget, type PreparedConnection } from "@t3tools/client-runtime/connection";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import { remoteHttpClientLayer } from "@t3tools/client-runtime/rpc";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import {
  type ForkRouteRemoteAuthorization,
  postForkEnvironmentRoute,
} from "./forkEnvironmentRoute";
import { primaryPreparedConnection } from "./preparedConnectionFixture";

const ROUTE_PATH = "/unity/setup-probe";
const RELAY_TARGET = new RelayConnectionTarget({
  environmentId: EnvironmentId.make("environment-relay"),
  label: "Relay environment",
});
const RELAY_PREPARED: PreparedConnection = {
  environmentId: RELAY_TARGET.environmentId,
  label: RELAY_TARGET.label,
  httpBaseUrl: "https://prepared.example.test",
  socketUrl: "wss://prepared.example.test/ws",
  httpAuthorization: { _tag: "Dpop", accessToken: "prepared-token", expiresAtEpochMs: 0 },
  target: RELAY_TARGET,
};
const RENEWED_ORIGIN = "https://renewed.example.test";

function credentialRejectedResponse() {
  return Response.json(
    {
      _tag: "EnvironmentAuthInvalidError",
      code: "auth_invalid",
      reason: "invalid_credential",
      traceId: "trace-rejected",
    },
    { status: 401 },
  );
}

function makeHarness(reply: (requestNumber: number) => Response) {
  const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
  const fetchFn: typeof fetch = async (request, init) => {
    calls.push({ url: String(request), init: init ?? {} });
    return reply(calls.length);
  };
  let proofCount = 0;
  const signer = ManagedRelay.ManagedRelayDpopSigner.of({
    thumbprint: Effect.succeed("test-thumbprint"),
    createProof: () => Effect.sync(() => `proof-${++proofCount}`),
  });
  return {
    calls,
    layer: Layer.mergeAll(
      remoteHttpClientLayer(fetchFn),
      Layer.succeed(ManagedRelay.ManagedRelayDpopSigner, signer),
    ),
  };
}

const authorizationHeader = (init: RequestInit) => new Headers(init.headers).get("authorization");

describe("postForkEnvironmentRoute", () => {
  it.effect("sends a cookie-session request with credentials and no credential header", () =>
    Effect.gen(function* () {
      const harness = makeHarness(() => Response.json({ ok: true }));
      const result = yield* postForkEnvironmentRoute({
        prepared: primaryPreparedConnection(),
        path: ROUTE_PATH,
        body: { projectId: "project-1" },
        timeoutMs: 5_000,
      }).pipe(Effect.provide(harness.layer));

      expect(result).toEqual({ ok: true });
      expect(harness.calls).toHaveLength(1);
      expect(harness.calls[0]!.url).toBe(`http://127.0.0.1:3000${ROUTE_PATH}`);
      expect(harness.calls[0]!.init.credentials).toBe("include");
      expect(authorizationHeader(harness.calls[0]!.init)).toBeNull();
    }),
  );

  it.effect("renews a DPoP credential once when a fork route rejects it, then retries", () =>
    Effect.gen(function* () {
      const harness = makeHarness((requestNumber) =>
        requestNumber === 1 ? credentialRejectedResponse() : Response.json({ ok: true }),
      );
      const authorizations: Array<{ readonly rejectedAccessToken?: string }> = [];
      const remoteAuthorization: ForkRouteRemoteAuthorization = {
        authorizeBearer: () => Effect.die("unexpected bearer authorization"),
        authorizeDpop: () => Effect.die("unexpected socket authorization"),
        authorizeDpopHttp: (input) =>
          Effect.sync(() => {
            authorizations.push(input);
            const renewed = input.rejectedAccessToken !== undefined;
            return {
              environmentId: RELAY_TARGET.environmentId,
              label: RELAY_TARGET.label,
              httpBaseUrl: renewed ? RENEWED_ORIGIN : RELAY_PREPARED.httpBaseUrl,
              httpAuthorization: {
                _tag: "Dpop" as const,
                accessToken: renewed ? "renewed-token" : "prepared-token",
                expiresAtEpochMs: 3_600_000,
              },
            };
          }),
      };

      const result = yield* postForkEnvironmentRoute({
        prepared: RELAY_PREPARED,
        path: ROUTE_PATH,
        body: { projectId: "project-1" },
        timeoutMs: 5_000,
        remoteAuthorization: Option.some(remoteAuthorization),
      }).pipe(Effect.provide(harness.layer));

      expect(result).toEqual({ ok: true });
      expect(authorizations.map((input) => input.rejectedAccessToken)).toEqual([
        undefined,
        "prepared-token",
      ]);
      expect(harness.calls.map((call) => call.url)).toEqual([
        `${RELAY_PREPARED.httpBaseUrl}${ROUTE_PATH}`,
        `${RENEWED_ORIGIN}${ROUTE_PATH}`,
      ]);
      expect(harness.calls.map((call) => authorizationHeader(call.init))).toEqual([
        "DPoP prepared-token",
        "DPoP renewed-token",
      ]);
      expect(harness.calls.map((call) => new Headers(call.init.headers).get("dpop"))).toEqual([
        "proof-1",
        "proof-2",
      ]);
      expect(harness.calls[1]!.init.body).toEqual(harness.calls[0]!.init.body);
    }),
  );

  it.effect("replays the prepared DPoP token but does not retry when it is rejected", () =>
    Effect.gen(function* () {
      const harness = makeHarness(() => credentialRejectedResponse());
      const error = yield* postForkEnvironmentRoute({
        prepared: RELAY_PREPARED,
        path: ROUTE_PATH,
        body: { projectId: "project-1" },
        timeoutMs: 5_000,
      }).pipe(Effect.provide(harness.layer), Effect.asVoid, Effect.flip);

      expect(error._tag).toBe("RemoteEnvironmentAuthFetchError");
      expect(harness.calls).toHaveLength(1);
      expect(authorizationHeader(harness.calls[0]!.init)).toBe("DPoP prepared-token");
    }),
  );

  it.effect("rejects a text scope refusal as an undeclared status, not a domain body", () =>
    Effect.gen(function* () {
      const harness = makeHarness(
        () => new Response("Forbidden: insufficient scope", { status: 403 }),
      );
      const error = yield* postForkEnvironmentRoute({
        prepared: primaryPreparedConnection(),
        path: ROUTE_PATH,
        body: { projectId: "project-1" },
        timeoutMs: 5_000,
      }).pipe(Effect.provide(harness.layer), Effect.asVoid, Effect.flip);

      expect(error).toMatchObject({
        _tag: "RemoteEnvironmentAuthUndeclaredStatusError",
        status: 403,
        requestUrl: `http://127.0.0.1:3000${ROUTE_PATH}`,
      });
    }),
  );
});
