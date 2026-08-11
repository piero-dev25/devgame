import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthStandardClientScopes,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthPresenceCommandScope,
  AuthPresenceReadScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  AuthReviewWriteScope,
  AuthTerminalOperateScope,
  EnvironmentAuthInvalidError,
  type EnvironmentAuthInvalidReason,
  EnvironmentHttpApi,
  EnvironmentInternalError,
  type EnvironmentInternalErrorReason,
  EnvironmentOperationForbiddenError,
  EnvironmentRequestInvalidError,
  type EnvironmentRequestInvalidReason,
  EnvironmentResourceNotFoundError,
  type EnvironmentResourceNotFoundReason,
  EnvironmentScopeRequiredError,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
} from "@t3tools/contracts";
import type { AuthEnvironmentScope } from "@t3tools/contracts";
import { parseAllowedOAuthScope } from "@t3tools/shared/oauthScope";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as NodeUtil from "node:util";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { identity } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Cookies from "effect/unstable/http/Cookies";
import * as HttpEffect from "effect/unstable/http/HttpEffect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as SessionStore from "./SessionStore.ts";
import { traceAuthenticatedRelayRequest, traceRelayRequest } from "../cloud/traceRelayRequest.ts";
import { deriveAuthClientMetadata } from "./utils.ts";
import { verifyRequestDpopProof } from "./dpop.ts";
import { sanitizeFailureDetail } from "../orchestration/failureDetail.ts";

const CREDENTIAL_RESPONSE_HEADERS = {
  "cache-control": "no-store",
  pragma: "no-cache",
} as const;

const appendCredentialResponseHeaders = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(HttpServerResponse.setHeaders(response, CREDENTIAL_RESPONSE_HEADERS)),
);

const appendDpopChallengeHeader = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(HttpServerResponse.setHeader(response, "www-authenticate", "DPoP")),
);

const appendDpopChallengeOnUnauthorized = (error: EnvironmentAuthInvalidError) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const usesDpop =
      (request.originalUrl.startsWith("/oauth/token") && request.headers.dpop !== undefined) ||
      request.headers.authorization?.startsWith("DPoP ") === true;
    if (usesDpop) {
      yield* appendDpopChallengeHeader;
    }
    return yield* error;
  });

export const currentEnvironmentTraceId = Effect.currentParentSpan.pipe(
  Effect.map((span) => span.traceId),
  Effect.orElseSucceed(() => "unavailable"),
);

export function annotateEnvironmentRequest(endpoint: string) {
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    const traceId = yield* currentEnvironmentTraceId;

    yield* Effect.addFinalizer((exit) =>
      exit._tag === "Failure"
        ? Effect.logWarning("environment api request failed", {
            endpoint,
            traceId,
            errorTag: causeErrorTag(exit.cause),
            cause: exit.cause,
          })
        : Effect.void,
    );
    yield* Effect.annotateLogsScoped({ "environment.endpoint": endpoint, traceId });
    yield* Effect.annotateCurrentSpan({
      "environment.endpoint": endpoint,
      "http.request.method": request.method,
      "url.path": url._tag === "Some" ? url.value.pathname : "unknown",
    });
  });
}

export function failEnvironmentAuthInvalid(reason: EnvironmentAuthInvalidReason) {
  return currentEnvironmentTraceId.pipe(
    Effect.flatMap((traceId) =>
      Effect.fail(new EnvironmentAuthInvalidError({ code: "auth_invalid", reason, traceId })),
    ),
  );
}

export function failEnvironmentInvalidRequest(reason: EnvironmentRequestInvalidReason) {
  return currentEnvironmentTraceId.pipe(
    Effect.flatMap((traceId) =>
      Effect.fail(new EnvironmentRequestInvalidError({ code: "invalid_request", reason, traceId })),
    ),
  );
}

export function failEnvironmentScopeRequired(requiredScope: AuthEnvironmentScope) {
  return currentEnvironmentTraceId.pipe(
    Effect.flatMap((traceId) =>
      Effect.fail(
        new EnvironmentScopeRequiredError({
          code: "insufficient_scope",
          requiredScope,
          traceId,
        }),
      ),
    ),
  );
}

function failEnvironmentOperationForbidden(reason: "current_session_revoke_not_allowed") {
  return currentEnvironmentTraceId.pipe(
    Effect.flatMap((traceId) =>
      Effect.fail(
        new EnvironmentOperationForbiddenError({
          code: "operation_forbidden",
          reason,
          traceId,
        }),
      ),
    ),
  );
}

export function failEnvironmentNotFound(reason: EnvironmentResourceNotFoundReason) {
  return currentEnvironmentTraceId.pipe(
    Effect.flatMap((traceId) =>
      Effect.fail(new EnvironmentResourceNotFoundError({ code: "not_found", reason, traceId })),
    ),
  );
}

/** Bounds the RAW `util.inspect` pass over an arbitrary, untyped `error`
 * (`Schema.Defect()` on every internal-error tag this funnel serves) before
 * `sanitizeFailureDetail` (below) ever sees it — the first of two layers,
 * not a substitute for the second. `depth: 8` comfortably clears the
 * 3-level chain #113 needed serialized (auth error -> bootstrap-credential
 * error -> the actual SQL/decode failure) while stopping well short of
 * where many SQL drivers attach the failed statement's BOUND PARAMETERS on
 * their own error objects — which, for `pairing_credential_issuance_failed`
 * specifically, can BE the credential. `maxStringLength`/`maxArrayLength`
 * cap what a single string/array value can render to, independent of
 * depth (a flat error with one enormous `.message` or `.params` array
 * would sail through a depth cap alone). Found live (2026-08-05, F4 merge-
 * gate review against f26ccc527): `depth: null` — #113's own fix — undid
 * the *incidental* containment the previous `depth: 2` default provided,
 * with no size bound at all, on the single funnel for every one of this
 * file's 14+ internal-error call sites. */
const INSPECT_OPTIONS = { depth: 8, maxStringLength: 2_000, maxArrayLength: 50 } as const;

export function failEnvironmentInternal(reason: EnvironmentInternalErrorReason, error?: unknown) {
  return Effect.gen(function* () {
    const traceId = yield* currentEnvironmentTraceId;
    if (error !== undefined) {
      yield* Effect.logError("environment api operation failed", {
        reason,
        traceId,
        // Serialized to a BOUNDED string, not passed through as the raw
        // `error` object. `Logger.consolePretty()` (serverLogger.ts)
        // formats structured metadata with Node's default `util.inspect`
        // object-depth cap, which silently prints `[Object]` past two
        // levels of nesting — exactly what a chain like `error` -> tagged
        // auth error -> `BootstrapCredentialConsumeAvailableError` -> the
        // actual SQL/decode failure routinely is. A STRING value is never
        // depth-truncated by the LOGGER, only nested plain objects are —
        // #113's own fix — but an unbounded string is its own hazard
        // (F4, 2026-08-05): `depth: null` can walk into a SQL driver's own
        // bound-parameter payload, and nothing capped the resulting
        // string's total size either. `INSPECT_OPTIONS` bounds the
        // inspection itself; `sanitizeFailureDetail` (task #76's own
        // funnel guard, reused rather than reinvented — same reasoning
        // that file's module doc gives) then strips this server's
        // absolute filesystem paths and applies a final overall-length
        // bound as defense in depth, the same two-layer treatment that
        // funnel already gives provider-failure details.
        cause: sanitizeFailureDetail(NodeUtil.inspect(error, INSPECT_OPTIONS)),
      });
    }
    return yield* new EnvironmentInternalError({ code: "internal_error", reason, traceId });
  });
}

export const requireEnvironmentScope = Effect.fn("environment.auth.requireScope")(function* (
  scope: AuthEnvironmentScope,
) {
  const session = yield* EnvironmentAuthenticatedPrincipal;
  if (!session.scopes.has(scope)) {
    return yield* failEnvironmentScopeRequired(scope);
  }
  return session;
});

export const environmentAuthenticatedAuthLayer = Layer.effect(
  EnvironmentAuthenticatedAuth,
  Effect.gen(function* () {
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    return (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
          Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
            failEnvironmentAuthInvalid(EnvironmentAuth.serverAuthCredentialReason(error)),
          ),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("internal_error", error),
          ),
        );
        return yield* httpEffect.pipe(
          Effect.provideService(EnvironmentAuthenticatedPrincipal, {
            ...session,
            scopes: new Set(session.scopes),
          }),
          session.subject === "cloud-connect" ? traceAuthenticatedRelayRequest : identity,
        );
      }).pipe(Effect.catchTag("EnvironmentAuthInvalidError", appendDpopChallengeOnUnauthorized));
  }),
);

export const authHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "auth",
  Effect.fnUntraced(function* (handlers) {
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const sessions = yield* SessionStore.SessionStore;

    return handlers
      .handle(
        "session",
        Effect.fn("environment.auth.session")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const request = yield* HttpServerRequest.HttpServerRequest;
            return yield* serverAuth.getSessionState(request);
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("internal_error", error),
          ),
        ),
      )
      .handle(
        "browserSession",
        Effect.fn("environment.auth.browserSession")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const request = yield* HttpServerRequest.HttpServerRequest;
            const result = yield* serverAuth.createBrowserSession(
              args.payload.credential,
              deriveAuthClientMetadata({ request }),
            );
            const sessionCookies = yield* Effect.fromResult(
              Cookies.set(Cookies.empty, sessions.cookieName, result.sessionToken, {
                expires: DateTime.toDate(result.response.expiresAt),
                httpOnly: true,
                path: "/",
                sameSite: "lax",
              }),
            ).pipe(Effect.catch(() => failEnvironmentInternal("browser_session_cookie_failed")));

            yield* HttpEffect.appendPreResponseHandler((_request, response) =>
              Effect.succeed(HttpServerResponse.mergeCookies(response, sessionCookies)),
            );
            yield* appendCredentialResponseHeaders;
            return result.response;
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
            failEnvironmentAuthInvalid(EnvironmentAuth.serverAuthCredentialReason(error)),
          ),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("browser_session_issuance_failed", error),
          ),
        ),
      )
      .handle(
        "token",
        Effect.fn("environment.auth.token")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const request = yield* HttpServerRequest.HttpServerRequest;
            const requestedScopes =
              args.payload.scope === undefined
                ? undefined
                : parseAllowedOAuthScope({
                    value: args.payload.scope,
                    // `presence:command` is listed here (making it a
                    // requestable token-exchange scope) but stays OUT of
                    // `AuthStandardClientScopes` — this allowlist only
                    // decides what a caller may ASK for; whether the
                    // request actually succeeds still depends on the
                    // underlying bootstrap grant carrying that scope (see
                    // `exchangeBootstrapCredentialForAccessToken`'s
                    // `grantedScopes.every(...)` check), which nothing
                    // gets unless a pairing credential was explicitly
                    // minted with it — see `AuthPresenceCommandScope`'s own
                    // doc comment in @t3tools/contracts.
                    allowedScopes: new Set<AuthEnvironmentScope>([
                      AuthOrchestrationReadScope,
                      AuthOrchestrationOperateScope,
                      AuthTerminalOperateScope,
                      AuthReviewWriteScope,
                      AuthAccessReadScope,
                      AuthAccessWriteScope,
                      AuthRelayReadScope,
                      AuthRelayWriteScope,
                      AuthPresenceCommandScope,
                      AuthPresenceReadScope,
                    ]),
                  });
            if (requestedScopes === null) {
              return yield* failEnvironmentInvalidRequest("invalid_scope");
            }
            const proofKeyThumbprint = args.headers.dpop
              ? yield* verifyRequestDpopProof({ request }).pipe(
                  Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, () =>
                    appendDpopChallengeHeader.pipe(
                      Effect.andThen(failEnvironmentAuthInvalid("invalid_credential")),
                    ),
                  ),
                  Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
                    failEnvironmentInternal("access_token_issuance_failed", error),
                  ),
                )
              : undefined;
            yield* appendCredentialResponseHeaders;
            return yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
              args.payload.subject_token,
              requestedScopes,
              deriveAuthClientMetadata({
                request,
                presented: {
                  ...(args.payload.client_label ? { label: args.payload.client_label } : {}),
                  ...(args.payload.client_device_type
                    ? { deviceType: args.payload.client_device_type }
                    : {}),
                  ...(args.payload.client_os ? { os: args.payload.client_os } : {}),
                },
              }),
              proofKeyThumbprint ? { proofKeyThumbprint } : undefined,
            );
          },
          traceRelayRequest,
          Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
            failEnvironmentAuthInvalid(EnvironmentAuth.serverAuthCredentialReason(error)),
          ),
          Effect.catchIf(EnvironmentAuth.isServerAuthInvalidRequestError, (error) =>
            failEnvironmentInvalidRequest(EnvironmentAuth.serverAuthInvalidRequestReason(error)),
          ),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("access_token_issuance_failed", error),
          ),
        ),
      )
      .handle(
        "webSocketTicket",
        Effect.fn("environment.auth.webSocketTicket")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const session = yield* EnvironmentAuthenticatedPrincipal;
            yield* appendCredentialResponseHeaders;
            return yield* serverAuth.issueWebSocketTicket(session);
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("websocket_ticket_issuance_failed", error),
          ),
        ),
      )
      .handle(
        "pairingCredential",
        Effect.fn("environment.auth.pairingCredential")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const session = yield* requireEnvironmentScope(AuthAccessWriteScope);
            const delegatedScopes = args.payload.scopes ?? AuthStandardClientScopes;
            if (
              delegatedScopes.length === 0 ||
              new Set<AuthEnvironmentScope>(delegatedScopes).size !== delegatedScopes.length
            ) {
              return yield* failEnvironmentInvalidRequest("invalid_scope");
            }
            for (const delegatedScope of delegatedScopes) {
              if (!session.scopes.has(delegatedScope)) {
                return yield* failEnvironmentScopeRequired(delegatedScope);
              }
            }
            return yield* serverAuth.issuePairingCredential(args.payload);
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("pairing_credential_issuance_failed", error),
          ),
        ),
      )
      .handle(
        "pairingLinks",
        Effect.fn("environment.auth.pairingLinks")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            yield* requireEnvironmentScope(AuthAccessReadScope);
            return yield* serverAuth.listPairingLinks();
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("pairing_links_load_failed", error),
          ),
        ),
      )
      .handle(
        "revokePairingLink",
        Effect.fn("environment.auth.revokePairingLink")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            yield* requireEnvironmentScope(AuthAccessWriteScope);
            const revoked = yield* serverAuth.revokePairingLink(args.payload.id);
            return { revoked };
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("pairing_link_revoke_failed", error),
          ),
        ),
      )
      .handle(
        "clients",
        Effect.fn("environment.auth.clients")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const session = yield* requireEnvironmentScope(AuthAccessReadScope);
            return yield* serverAuth.listClientSessions(session.sessionId);
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("client_sessions_load_failed", error),
          ),
        ),
      )
      .handle(
        "revokeClient",
        Effect.fn("environment.auth.revokeClient")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const session = yield* requireEnvironmentScope(AuthAccessWriteScope);
            const revoked = yield* serverAuth.revokeClientSession(
              session.sessionId,
              args.payload.sessionId,
            );
            return { revoked };
          },
          Effect.catchTag("ServerAuthForbiddenOperationError", () =>
            failEnvironmentOperationForbidden("current_session_revoke_not_allowed"),
          ),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("client_session_revoke_failed", error),
          ),
        ),
      )
      .handle(
        "revokeOtherClients",
        Effect.fn("environment.auth.revokeOtherClients")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const session = yield* requireEnvironmentScope(AuthAccessWriteScope);
            const revokedCount = yield* serverAuth.revokeOtherClientSessions(session.sessionId);
            return { revokedCount };
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("client_session_revoke_failed", error),
          ),
        ),
      );
  }),
);
