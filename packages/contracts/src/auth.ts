import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";

import { AuthSessionId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Declares the server's overall authentication posture.
 *
 * This is a high-level policy label that tells clients how the environment is
 * expected to be accessed, not a transport detail and not an exhaustive list
 * of every accepted credential.
 *
 * Typical usage:
 * - rendered in auth/pairing UI so the user understands what kind of
 *   environment they are connecting to
 * - used by clients to decide whether silent desktop bootstrap is expected or
 *   whether an explicit pairing flow should be shown
 *
 * Meanings:
 * - `desktop-managed-local`: local desktop-managed environment with narrow
 *   trusted bootstrap, intended to avoid login prompts on the same machine
 * - `loopback-browser`: standalone local server intended for browser pairing on
 *   the same machine
 * - `remote-reachable`: environment intended to be reached from other devices
 *   or networks, where explicit pairing/auth is expected
 * - `unsafe-no-auth`: intentionally unauthenticated mode; this is an explicit
 *   unsafe escape hatch, not a normal deployment mode
 */
export const ServerAuthPolicy = Schema.Literals([
  "desktop-managed-local",
  "loopback-browser",
  "remote-reachable",
  "unsafe-no-auth",
]);
export type ServerAuthPolicy = typeof ServerAuthPolicy.Type;

/**
 * A credential type that can be exchanged for a real authenticated session.
 *
 * Bootstrap methods are for establishing trust at the start of a connection or
 * pairing flow. They are not the long-lived credential used for ordinary
 * authenticated HTTP / WebSocket traffic after pairing succeeds.
 *
 * Current methods:
 * - `desktop-bootstrap`: a trusted local desktop handoff, used so the desktop
 *   shell can pair the renderer without a login screen
 * - `one-time-token`: a short-lived pairing token, suitable for manual pairing
 *   flows such as `/pair?token=...`
 */
export const ServerAuthBootstrapMethod = Schema.Literals(["desktop-bootstrap", "one-time-token"]);
export type ServerAuthBootstrapMethod = typeof ServerAuthBootstrapMethod.Type;

/**
 * A credential type accepted for steady-state authenticated requests after a
 * client has already paired.
 *
 * These methods are used by the server-wide auth layer for privileged HTTP and
 * WebSocket access. They are distinct from bootstrap methods so clients can
 * reason clearly about "pair first, then use session auth".
 *
 * Current methods:
 * - `browser-session-cookie`: cookie-backed browser session, used by the web
 *   app after bootstrap/pairing
 * - `bearer-access-token`: scoped token suitable for non-cookie or
 *   non-browser clients
 * - `dpop-access-token`: scoped proof-of-possession token used by managed
 *   relay connections
 */
export const ServerAuthSessionMethod = Schema.Literals([
  "browser-session-cookie",
  "bearer-access-token",
  "dpop-access-token",
]);
export type ServerAuthSessionMethod = typeof ServerAuthSessionMethod.Type;

export const AuthOrchestrationReadScope = "orchestration:read" as const;
export const AuthOrchestrationOperateScope = "orchestration:operate" as const;
export const AuthTerminalOperateScope = "terminal:operate" as const;
export const AuthReviewWriteScope = "review:write" as const;
export const AuthAccessReadScope = "access:read" as const;
export const AuthAccessWriteScope = "access:write" as const;
export const AuthRelayReadScope = "relay:read" as const;
export const AuthRelayWriteScope = "relay:write" as const;
/**
 * Authorizes sending an Editor Presence COMMAND (Play/Stop/Step/Pause) to a
 * connected engine — see `EditorPresenceRoute.ts`'s `dispatchEditorCommand`
 * and docs/workbench/spec-editor-presence-commands.md. Deliberately its own
 * scope, NOT folded into `orchestration:operate`: that scope already
 * authorizes `dispatchCommand`, `projectsWriteFile`, `vcsPull`, and
 * `sourceControlCloneRepository`, and `AuthStandardClientScopes` grants
 * read+operate to every standard client by default — the browser app, every
 * `t3 pair` token, the Unity plugin's own token exchange. Reusing that scope
 * would mean "make the user's editor execute code" is authorized by a scope
 * every already-paired client already holds, with no way to grant presence
 * read/write without ALSO granting command dispatch. This scope is
 * deliberately excluded from BOTH `AuthStandardClientScopes` AND
 * `AuthAdministrativeScopes` below — see `AuthDesktopOwnerScopes` for where
 * it actually lives, and why `AuthAdministrativeScopes` itself is the wrong
 * place for it.
 */
export const AuthPresenceCommandScope = "presence:command" as const;
export const AuthEnvironmentScope = Schema.Literals([
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  AuthTerminalOperateScope,
  AuthReviewWriteScope,
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  AuthPresenceCommandScope,
]);
export type AuthEnvironmentScope = typeof AuthEnvironmentScope.Type;
export const AuthEnvironmentScopes = Schema.Array(AuthEnvironmentScope);
export type AuthEnvironmentScopes = typeof AuthEnvironmentScopes.Type;

const AUTH_ENVIRONMENT_SCOPE_VALUES: ReadonlySet<string> = new Set(AuthEnvironmentScope.literals);

/**
 * A tolerant decode of a scope LIST: unrecognized scope strings are DROPPED
 * rather than failing the whole decode. `AuthEnvironmentScope` is a closed
 * `Schema.Literals` union, so `AuthEnvironmentScopes` (a strict array of it)
 * fails to decode ENTIRELY the moment the array contains even one value the
 * decoding build doesn't recognize — which is exactly what happens when an
 * OLDER client (built before a new scope literal like `presence:command`
 * existed) decodes a NEWER server's response for a session that now carries
 * it: "one scope I don't understand" becomes "this client session's state
 * failed to load," for every field in the same payload, not just the scope
 * list.
 *
 * Used ONLY for scope lists a client READS — describing a session, pairing
 * link, or client that already exists. Dropping an unrecognized entry there
 * is safe: the client simply doesn't know about a capability it can't act
 * on anyway. `AuthCreatePairingCredentialInput.scopes` deliberately keeps
 * the STRICT `AuthEnvironmentScopes` — a WRITE request specifying scopes by
 * name should be rejected outright if it names one the server doesn't
 * recognize, not silently narrowed.
 */
export const AuthEnvironmentScopesLenient = Schema.Array(Schema.String).pipe(
  Schema.decodeTo(
    AuthEnvironmentScopes,
    SchemaTransformation.transform<ReadonlyArray<AuthEnvironmentScope>, ReadonlyArray<string>>({
      decode: (scopes) =>
        scopes.filter((scope): scope is AuthEnvironmentScope =>
          AUTH_ENVIRONMENT_SCOPE_VALUES.has(scope),
        ),
      encode: (scopes) => [...scopes],
    }),
  ),
);

export const AuthStandardClientScopes = [
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  AuthTerminalOperateScope,
  AuthReviewWriteScope,
  AuthRelayReadScope,
] as const;
export const AuthAdministrativeScopes = [
  ...AuthStandardClientScopes,
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthRelayWriteScope,
] as const;

/**
 * `AuthAdministrativeScopes`, plus `AuthPresenceCommandScope` — used at
 * EXACTLY ONE mint site: the desktop app's own bootstrap seed
 * (`PairingGrantStore.ts`'s `desktopBootstrapToken` seeding). This is
 * deliberately NOT the same set `AuthAdministrativeScopes` itself grants,
 * because `AuthAdministrativeScopes` has other mint sites that are NOT the
 * machine owner sitting at their own desktop — most notably `t3 auth
 * session issue` (apps/server/src/cli/auth.ts), which mints bearer tokens
 * "for headless or REMOTE clients." Folding `presence:command` into
 * `AuthAdministrativeScopes` itself would hand every one of those
 * remote/headless tokens the ability to make a connected editor execute
 * code too — the same "capability riding ambiently on a broad grant" shape
 * as the #46 finding this scope exists to answer, just at a smaller radius.
 *
 * The desktop bootstrap session is different in kind: it is the one
 * session that starts on the SAME machine as the editors it would be
 * commanding, seeded once at process start, never minted on demand for a
 * remote caller. That is the one place "may DELEGATE engine control" is a
 * property PairingGrantStore's `pairingCredential` HTTP path can then hand
 * out consciously, one explicit checkbox at a time (Settings > Connections)
 * — see `AuthPresenceCommandScope`'s own doc comment for why a session must
 * already hold a scope to delegate it, and why that would otherwise make
 * this scope permanently unmintable.
 */
export const AuthDesktopOwnerScopes = [
  ...AuthAdministrativeScopes,
  AuthPresenceCommandScope,
] as const;

export const AuthTokenExchangeGrantType =
  "urn:ietf:params:oauth:grant-type:token-exchange" as const;
export const AuthAccessTokenType = "urn:ietf:params:oauth:token-type:access_token" as const;
export const AuthEnvironmentBootstrapTokenType =
  "urn:t3:params:oauth:token-type:environment-bootstrap" as const;

/**
 * Server-advertised auth capabilities for a specific execution environment.
 *
 * Clients should treat this as the authoritative description of how that
 * environment expects to be paired and how authenticated requests should be
 * made afterward.
 *
 * Field meanings:
 * - `policy`: high-level auth posture for the environment
 * - `bootstrapMethods`: pairing/bootstrap methods the server is currently
 *   willing to accept
 * - `sessionMethods`: authenticated request/session methods the server supports
 *   once pairing is complete
 * - `sessionCookieName`: cookie name clients should expect when
 *   `browser-session-cookie` is in use
 *
 * This descriptor is intentionally capability-oriented. It lets clients choose
 * the right UX without embedding server-specific auth logic or assuming a
 * single access method.
 */
export const ServerAuthDescriptor = Schema.Struct({
  policy: ServerAuthPolicy,
  bootstrapMethods: Schema.Array(ServerAuthBootstrapMethod),
  sessionMethods: Schema.Array(ServerAuthSessionMethod),
  sessionCookieName: TrimmedNonEmptyString,
});
export type ServerAuthDescriptor = typeof ServerAuthDescriptor.Type;

export const AuthBrowserSessionRequest = Schema.Struct({
  credential: TrimmedNonEmptyString,
});
export type AuthBrowserSessionRequest = typeof AuthBrowserSessionRequest.Type;

export const AuthBrowserSessionResult = Schema.Struct({
  authenticated: Schema.Literal(true),
  // Lenient: this describes a session that already exists — see
  // `AuthEnvironmentScopesLenient`'s own doc for why a READ of scopes
  // tolerates an unrecognized literal instead of failing outright.
  scopes: AuthEnvironmentScopesLenient,
  sessionMethod: ServerAuthSessionMethod,
  expiresAt: Schema.DateTimeUtc,
});
export type AuthBrowserSessionResult = typeof AuthBrowserSessionResult.Type;

export const AuthClientMetadataDeviceType = Schema.Literals([
  "desktop",
  "mobile",
  "tablet",
  "bot",
  "unknown",
]);
export type AuthClientMetadataDeviceType = typeof AuthClientMetadataDeviceType.Type;

export const AuthClientPresentationMetadata = Schema.Struct({
  label: Schema.optionalKey(TrimmedNonEmptyString),
  deviceType: Schema.optionalKey(AuthClientMetadataDeviceType),
  os: Schema.optionalKey(TrimmedNonEmptyString),
});
export type AuthClientPresentationMetadata = typeof AuthClientPresentationMetadata.Type;

export const AuthTokenExchangeRequest = Schema.Struct({
  grant_type: Schema.Literal(AuthTokenExchangeGrantType),
  subject_token: TrimmedNonEmptyString,
  subject_token_type: Schema.Literal(AuthEnvironmentBootstrapTokenType),
  requested_token_type: Schema.Literal(AuthAccessTokenType),
  scope: Schema.optionalKey(TrimmedNonEmptyString),
  client_label: Schema.optionalKey(TrimmedNonEmptyString),
  client_device_type: Schema.optionalKey(AuthClientMetadataDeviceType),
  client_os: Schema.optionalKey(TrimmedNonEmptyString),
}).pipe(HttpApiSchema.asFormUrlEncoded());
export type AuthTokenExchangeRequest = typeof AuthTokenExchangeRequest.Type;

export const AuthAccessTokenResult = Schema.Struct({
  access_token: TrimmedNonEmptyString,
  issued_token_type: Schema.Literal(AuthAccessTokenType),
  token_type: Schema.Literals(["Bearer", "DPoP"]),
  expires_in: Schema.Number,
  scope: TrimmedNonEmptyString,
});
export type AuthAccessTokenResult = typeof AuthAccessTokenResult.Type;

export const AuthWebSocketTicketResult = Schema.Struct({
  ticket: TrimmedNonEmptyString,
  expiresAt: Schema.DateTimeUtc,
});
export type AuthWebSocketTicketResult = typeof AuthWebSocketTicketResult.Type;

export const AuthPairingCredentialResult = Schema.Struct({
  id: TrimmedNonEmptyString,
  credential: TrimmedNonEmptyString,
  label: Schema.optionalKey(TrimmedNonEmptyString),
  expiresAt: Schema.DateTimeUtc,
});
export type AuthPairingCredentialResult = typeof AuthPairingCredentialResult.Type;

export const AuthPairingLink = Schema.Struct({
  id: TrimmedNonEmptyString,
  credential: TrimmedNonEmptyString,
  // Lenient — see `AuthBrowserSessionResult`'s comment above.
  scopes: AuthEnvironmentScopesLenient,
  subject: TrimmedNonEmptyString,
  label: Schema.optionalKey(TrimmedNonEmptyString),
  createdAt: Schema.DateTimeUtc,
  expiresAt: Schema.DateTimeUtc,
});
export type AuthPairingLink = typeof AuthPairingLink.Type;

export const AuthClientMetadata = Schema.Struct({
  label: Schema.optionalKey(TrimmedNonEmptyString),
  ipAddress: Schema.optionalKey(TrimmedNonEmptyString),
  userAgent: Schema.optionalKey(TrimmedNonEmptyString),
  deviceType: AuthClientMetadataDeviceType,
  os: Schema.optionalKey(TrimmedNonEmptyString),
  browser: Schema.optionalKey(TrimmedNonEmptyString),
});
export type AuthClientMetadata = typeof AuthClientMetadata.Type;

export const AuthClientSession = Schema.Struct({
  sessionId: AuthSessionId,
  subject: TrimmedNonEmptyString,
  // Lenient — see `AuthBrowserSessionResult`'s comment above.
  scopes: AuthEnvironmentScopesLenient,
  method: ServerAuthSessionMethod,
  client: AuthClientMetadata,
  issuedAt: Schema.DateTimeUtc,
  expiresAt: Schema.DateTimeUtc,
  lastConnectedAt: Schema.NullOr(Schema.DateTimeUtc),
  connected: Schema.Boolean,
  current: Schema.Boolean,
});
export type AuthClientSession = typeof AuthClientSession.Type;

export const AuthAccessSnapshot = Schema.Struct({
  pairingLinks: Schema.Array(AuthPairingLink),
  clientSessions: Schema.Array(AuthClientSession),
});
export type AuthAccessSnapshot = typeof AuthAccessSnapshot.Type;

export const AuthAccessStreamSnapshotEvent = Schema.Struct({
  version: Schema.Literal(1),
  revision: Schema.Number,
  type: Schema.Literal("snapshot"),
  payload: AuthAccessSnapshot,
});
export type AuthAccessStreamSnapshotEvent = typeof AuthAccessStreamSnapshotEvent.Type;

export const AuthAccessStreamPairingLinkUpsertedEvent = Schema.Struct({
  version: Schema.Literal(1),
  revision: Schema.Number,
  type: Schema.Literal("pairingLinkUpserted"),
  payload: AuthPairingLink,
});
export type AuthAccessStreamPairingLinkUpsertedEvent =
  typeof AuthAccessStreamPairingLinkUpsertedEvent.Type;

export const AuthAccessStreamPairingLinkRemovedEvent = Schema.Struct({
  version: Schema.Literal(1),
  revision: Schema.Number,
  type: Schema.Literal("pairingLinkRemoved"),
  payload: Schema.Struct({
    id: TrimmedNonEmptyString,
  }),
});
export type AuthAccessStreamPairingLinkRemovedEvent =
  typeof AuthAccessStreamPairingLinkRemovedEvent.Type;

export class AuthAccessStreamError extends Schema.TaggedErrorClass<AuthAccessStreamError>()(
  "AuthAccessStreamError",
  {
    message: Schema.String,
  },
) {}

export class EnvironmentAuthorizationError extends Schema.TaggedErrorClass<EnvironmentAuthorizationError>()(
  "EnvironmentAuthorizationError",
  {
    message: Schema.String,
    requiredScope: AuthEnvironmentScope,
  },
) {}

export const AuthAccessStreamClientUpsertedEvent = Schema.Struct({
  version: Schema.Literal(1),
  revision: Schema.Number,
  type: Schema.Literal("clientUpserted"),
  payload: AuthClientSession,
});
export type AuthAccessStreamClientUpsertedEvent = typeof AuthAccessStreamClientUpsertedEvent.Type;

export const AuthAccessStreamClientRemovedEvent = Schema.Struct({
  version: Schema.Literal(1),
  revision: Schema.Number,
  type: Schema.Literal("clientRemoved"),
  payload: Schema.Struct({
    sessionId: AuthSessionId,
  }),
});
export type AuthAccessStreamClientRemovedEvent = typeof AuthAccessStreamClientRemovedEvent.Type;

export const AuthAccessStreamEvent = Schema.Union([
  AuthAccessStreamSnapshotEvent,
  AuthAccessStreamPairingLinkUpsertedEvent,
  AuthAccessStreamPairingLinkRemovedEvent,
  AuthAccessStreamClientUpsertedEvent,
  AuthAccessStreamClientRemovedEvent,
]);
export type AuthAccessStreamEvent = typeof AuthAccessStreamEvent.Type;

export const AuthRevokePairingLinkInput = Schema.Struct({
  id: TrimmedNonEmptyString,
});
export type AuthRevokePairingLinkInput = typeof AuthRevokePairingLinkInput.Type;

export const AuthRevokeClientSessionInput = Schema.Struct({
  sessionId: AuthSessionId,
});
export type AuthRevokeClientSessionInput = typeof AuthRevokeClientSessionInput.Type;

export const AuthCreatePairingCredentialInput = Schema.Struct({
  label: Schema.optionalKey(TrimmedNonEmptyString),
  scopes: Schema.optionalKey(AuthEnvironmentScopes),
});
export type AuthCreatePairingCredentialInput = typeof AuthCreatePairingCredentialInput.Type;

export const AuthSessionState = Schema.Struct({
  authenticated: Schema.Boolean,
  auth: ServerAuthDescriptor,
  // Lenient — see `AuthBrowserSessionResult`'s comment above.
  scopes: Schema.optionalKey(AuthEnvironmentScopesLenient),
  sessionMethod: Schema.optionalKey(ServerAuthSessionMethod),
  expiresAt: Schema.optionalKey(Schema.DateTimeUtc),
});
export type AuthSessionState = typeof AuthSessionState.Type;
