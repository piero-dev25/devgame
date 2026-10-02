// Authenticated POSTs to DevGame's own environment HTTP routes (Unity
// command/setup-probe/pipeline-install/raise, Editor Presence command,
// generation list) through upstream's
// `executeAuthenticatedEnvironmentHttpRequest`.
//
// Upstream made its old header/credential plumbing
// (`buildEnvironmentAuthHeaders`/`withEnvironmentCredentials`) private and
// routes every environment request through that one helper. It resolves the
// credential at request time, signs a DPoP proof bound to this request, opts
// cookie-session connections into `credentials: "include"`, and gives a
// rejected DPoP credential one refresh-and-retry. This module ports the fork's
// fetchers onto it rather than re-exporting the private pieces.
//
// The fork routes are plain `HttpRouter` routes, not part of the contracts'
// `EnvironmentHttpApi`. The helper still requires an HttpApi group, so this
// passes the smallest one ("metadata") and ignores the typed client it builds.
// The request itself is a plain `HttpClient` POST carrying the helper's
// headers.
//
// Two adaptations make the helper's semantics hold for these routes:
// - A fork route that rejects a credential answers 401 with the same
//   `EnvironmentAuthInvalidError` JSON every upstream route sends. A non-2xx
//   body that decodes as an `EnvironmentHttpCommonError` is failed with that
//   typed error, which is what lets the helper recognise `invalid_credential`
//   and retry. Any other non-2xx status fails as an undeclared status.
// - `RemoteEnvironmentAuthorization` lives in the connection runtime and is
//   not exported from client-runtime, so these Promise-boundary fetchers
//   cannot reach it. For a DPoP connection with no authorization service, a
//   static authorization replays the prepared connection's own access token,
//   which is exactly what these fetchers sent before the port. That access
//   token cannot be refreshed: a rejected token fails instead of retrying.
import {
  ConnectionBlockedError,
  type PreparedConnection,
} from "@t3tools/client-runtime/connection";
import { environmentEndpointUrl } from "@t3tools/client-runtime/environment";
import type { RemoteEnvironmentRequestError } from "@t3tools/client-runtime/rpc";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import { executeAuthenticatedEnvironmentHttpRequest } from "@t3tools/client-runtime/state/environmentHttpAuth";
import { EnvironmentHttpCommonError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

type AuthenticatedRequestInput = Parameters<typeof executeAuthenticatedEnvironmentHttpRequest>[0];
type RemoteAuthorizationOption = NonNullable<AuthenticatedRequestInput["remoteAuthorization"]>;
export type ForkRouteRemoteAuthorization =
  RemoteAuthorizationOption extends Option.Option<infer Service> ? Service : never;

const decodeEnvironmentHttpCommonError = Schema.decodeUnknownOption(EnvironmentHttpCommonError);

function parseJsonOrUndefined(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Replays the prepared connection's own DPoP credential. It never refreshes:
 * asked to replace a rejected token, it fails with an authentication block.
 */
export function staticDpopAuthorization(
  prepared: PreparedConnection,
): ForkRouteRemoteAuthorization {
  const unsupported = (operation: string) =>
    Effect.die(`Fork environment routes never call ${operation}.`);
  return {
    authorizeBearer: () => unsupported("authorizeBearer"),
    authorizeDpop: () => unsupported("authorizeDpop"),
    authorizeDpopHttp: (input) => {
      const authorization = prepared.httpAuthorization;
      if (input.rejectedAccessToken !== undefined || authorization?._tag !== "Dpop") {
        return Effect.fail(
          new ConnectionBlockedError({
            reason: "authentication",
            detail:
              "The environment rejected this connection's access token. Reconnect to renew it.",
          }),
        );
      }
      return Effect.succeed({
        environmentId: prepared.environmentId,
        label: prepared.label,
        httpBaseUrl: prepared.httpBaseUrl,
        httpAuthorization: authorization,
      });
    },
  };
}

/**
 * POSTs `body` as JSON to `path` on the prepared environment and resolves with
 * the 2xx response body as unparsed `unknown` JSON. Callers decode it with
 * their own contract schema, so a malformed body still rejects with a
 * `SchemaError`, as each fetcher's tests require.
 */
export const postForkEnvironmentRoute = Effect.fn("web.forkEnvironmentRoute.post")(
  function* (input: {
    readonly prepared: PreparedConnection;
    readonly path: string;
    readonly body: unknown;
    readonly timeoutMs: number;
    /** Defaults to a static replay of the prepared DPoP credential. */
    readonly remoteAuthorization?: Option.Option<ForkRouteRemoteAuthorization>;
  }) {
    const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
    const httpClient = yield* HttpClient.HttpClient;
    const remoteAuthorization =
      input.remoteAuthorization !== undefined && Option.isSome(input.remoteAuthorization)
        ? input.remoteAuthorization
        : Option.some(staticDpopAuthorization(input.prepared));
    // The helper resolves the base URL per attempt (a refreshed DPoP
    // authorization can move it) and calls `url` immediately before `request`.
    let requestUrl = environmentEndpointUrl(input.prepared.httpBaseUrl, input.path);
    return yield* executeAuthenticatedEnvironmentHttpRequest({
      prepared: input.prepared,
      signer,
      remoteAuthorization,
      group: "metadata",
      method: "POST",
      url: (httpBaseUrl) => {
        requestUrl = environmentEndpointUrl(httpBaseUrl, input.path);
        return requestUrl;
      },
      timeoutMs: input.timeoutMs,
      request: ({ headers }) =>
        Effect.gen(function* () {
          const response = yield* httpClient.execute(
            HttpClientRequest.post(requestUrl).pipe(
              HttpClientRequest.setHeaders({ ...headers }),
              HttpClientRequest.bodyJsonUnsafe(input.body),
            ),
          );
          if (response.status >= 200 && response.status < 300) {
            return (yield* response.json) as unknown;
          }
          const commonError = decodeEnvironmentHttpCommonError(
            parseJsonOrUndefined(yield* response.text),
          );
          if (Option.isSome(commonError)) {
            return yield* commonError.value;
          }
          // Fails with the response attached, which the helper reports as an
          // undeclared status for `requestUrl`.
          return yield* HttpClientResponse.filterStatusOk(response).pipe(Effect.as(undefined));
        }),
    });
  },
);

/** Why a fork route request produced no result, worded for the user. */
export type ForkRouteFailure =
  /** This connection lacks the route's scope; fork routes answer a text 403. */
  | { readonly _tag: "notPermitted" }
  /** No answer: the request could not be sent or timed out. */
  | { readonly _tag: "unreachable"; readonly message: string }
  /**
   * The environment answered, but not with a result: an auth error, another
   * error status, or a body that does not match the contract.
   */
  | { readonly _tag: "failed"; readonly message: string };

const isConnectionBlockedError = Schema.is(ConnectionBlockedError);
const UNREADABLE_RESPONSE = "It answered with a response this app could not read.";

/** Sorts a failed `postForkEnvironmentRoute` (or its decode) into "no answer" versus "answered with an error". */
export function classifyForkRouteFailure(
  error: RemoteEnvironmentRequestError | Schema.SchemaError,
): ForkRouteFailure {
  switch (error._tag) {
    case "RemoteEnvironmentAuthTimeoutError":
      return { _tag: "unreachable", message: error.message };
    case "RemoteEnvironmentAuthFetchError":
      // A rejected access token surfaces here wrapped; that is an auth answer, not a network failure.
      return isConnectionBlockedError(error.cause)
        ? { _tag: "failed", message: error.cause.detail }
        : { _tag: "unreachable", message: error.message };
    case "RemoteEnvironmentAuthUndeclaredStatusError":
      return error.status === 403
        ? { _tag: "notPermitted" }
        : { _tag: "failed", message: `It answered with status ${error.status}.` };
    case "RemoteEnvironmentAuthInvalidJsonError":
    case "SchemaError":
      return { _tag: "failed", message: UNREADABLE_RESPONSE };
    default:
      // Every typed environment error (auth, scope, bad request, internal) is a server answer.
      return { _tag: "failed", message: error.message };
  }
}
