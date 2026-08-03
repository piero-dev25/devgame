/**
 * Raw (non-RPC) WebSocket route that pushes live space updates to
 * subscribed clients — the liveness gap this route closes: `space.created`
 * / `space.deleted` are persisted and projected, but no connected client
 * ever hears about them, because the only existing live-push channel
 * (`orchestration.subscribeShell` in `../ws.ts`) is narrowed to upstream's
 * own `project`/`thread` aggregate kinds and drops everything else
 * unconditionally (see its `toShellStreamEvent`, which falls through to
 * `if (event.aggregateKind !== "thread") return Option.none()` for any
 * event it doesn't have an explicit case for). Spaces DO already appear in
 * that channel's *initial* snapshot (`OrchestrationShellSnapshot.spaces`),
 * so this is specifically a live-update gap — poll-or-refresh, not total
 * invisibility.
 *
 * This route exists entirely outside `WsRpcGroup` / `WS_METHODS` — no new
 * RPC method, no `packages/contracts` change, no `../ws.ts` edit — for the
 * same reason `../editorPresence/EditorPresenceRoute.ts` does: `WsRpcGroup`
 * mounts every WS_METHODS handler together in one object, so its router's
 * type requirement is the union of all of them, and there is no way to bolt
 * on a project-scoped subscription without editing either vendor file. This
 * route, and its registration in `../server.ts`, are the smallest possible
 * addition that avoids both. It reads through `ProjectionSnapshotQuery`
 * (the existing "read-model, read-only" service `../ws.ts` itself already
 * depends on for `subscribeShell`) rather than the lower-level
 * `ProjectionSpaceRepository`: the repository isn't wired to be reachable
 * from `server.ts`'s route composition — routes only ever receive
 * already-built read-model services, never raw `SqlClient` — so reaching
 * for it directly would require this route to independently thread its own
 * `SqlClient` dependency through `makeRoutesLayer`, widening the very
 * surface this route is trying to keep small.
 *
 * `GET /space-events?projectId=<ProjectId>` — subscribe-only, one role, no
 * inbound frames (see protocol.ts). Level-style broadcasts, not edge-style:
 * see protocol.ts's doc comment for why, and `SpaceEventsRegistry` for the
 * per-project fan-out this route registers into.
 *
 * AUTH: reuses EditorPresenceRoute's publisher ruling rather than inventing
 * a new one — accept the upgrade unconditionally, authenticate from inside
 * the read loop's `onOpen`, and on failure close with an application code
 * (>= 4000) plus a human-readable reason instead of refusing the upgrade
 * with HTTP 401. That ruling was written for engine clients (Godot, Unity)
 * that cannot read a rejected upgrade's HTTP status at all, but the same
 * limitation applies to a browser's native `WebSocket`: a non-101 response
 * surfaces as an opaque `close`/`error` event with no readable status code
 * either, so a bad-credential rejection would be just as invisible to a web
 * client as to an engine one. Retry semantics are credential-class versus
 * everything else, NOT a numeric threshold: `SPACE_EVENTS_MISSING_
 * CREDENTIAL_CLOSE_CODE` / `SPACE_EVENTS_INVALID_CREDENTIAL_CLOSE_CODE`
 * mean the credential itself is bad and the client should stop retrying;
 * `SPACE_EVENTS_INTERNAL_ERROR_CLOSE_CODE` means the server is at fault and
 * the client should keep retrying.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import * as Socket from "effect/unstable/socket/Socket";
import type { OrchestrationSpace, ProjectId } from "@t3tools/contracts";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { buildSpacesFrame, type SpaceEventsEntry } from "./protocol.ts";
import * as SpaceEventsRegistry from "./SpaceEventsRegistry.ts";

const SPACE_EVENTS_PATH = "/space-events";

/**
 * Application-range close codes (RFC 6455 §7.4.2, >= 4000) used to reject an
 * unauthenticated upgrade — see the module doc's AUTH section. Credential
 * class (4400/4401) means stop retrying; server fault (4500) means keep
 * retrying.
 */
const SPACE_EVENTS_MISSING_CREDENTIAL_CLOSE_CODE = 4400;
const SPACE_EVENTS_INVALID_CREDENTIAL_CLOSE_CODE = 4401;
const SPACE_EVENTS_INTERNAL_ERROR_CLOSE_CODE = 4500;

const isSpaceEventsAuthCloseCode = (code: number): boolean =>
  code === SPACE_EVENTS_MISSING_CREDENTIAL_CLOSE_CODE ||
  code === SPACE_EVENTS_INVALID_CREDENTIAL_CLOSE_CODE ||
  code === SPACE_EVENTS_INTERNAL_ERROR_CLOSE_CODE;

function credentialCloseCode(error: EnvironmentAuth.ServerAuthCredentialError): number {
  return error._tag === "ServerAuthMissingCredentialError"
    ? SPACE_EVENTS_MISSING_CREDENTIAL_CLOSE_CODE
    : SPACE_EVENTS_INVALID_CREDENTIAL_CLOSE_CODE;
}

function readProjectId(request: HttpServerRequest.HttpServerRequest): ProjectId | null {
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) return null;
  const projectId = url.value.searchParams.get("projectId");
  return projectId && projectId.trim().length > 0 ? (projectId as ProjectId) : null;
}

function toSpaceEventsEntry(space: OrchestrationSpace): SpaceEventsEntry {
  return {
    id: space.id,
    title: space.title,
    createdAt: space.createdAt,
    updatedAt: space.updatedAt,
  };
}

/** Queries the current active-space list for one project and broadcasts it
 * as a single `spaces` level frame — the one place this route ever reads
 * space rows, always through the project-scoped `getActiveSpacesForProject`
 * (indexed on `project_id`), never an unscoped listing. */
const broadcastCurrentSpaces = (
  registry: SpaceEventsRegistry.SpaceEventsRegistry["Service"],
  snapshotQuery: ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"],
  projectId: ProjectId,
) =>
  Effect.gen(function* () {
    const hasSubscribers = yield* registry.hasSubscribers(projectId);
    if (!hasSubscribers) return;
    const spaces = yield* snapshotQuery.getActiveSpacesForProject(projectId);
    yield* registry.broadcast(
      projectId,
      buildSpacesFrame(projectId, spaces.map(toSpaceEventsEntry)),
    );
  });

/**
 * Drains the real orchestration engine's domain event stream — the same
 * stream `../ws.ts`'s `subscribeShell`/`subscribeThread` read from — for
 * `space.created` / `space.deleted`, and re-broadcasts the affected
 * project's current space list. Forked once at layer-construction time, not
 * per-connection.
 *
 * `space.created`'s payload carries `projectId` directly. `space.deleted`'s
 * does not (see `SpaceDeletedPayload` in packages/contracts), so that branch
 * recovers it via `getSpaceProjectId` — a single indexed row lookup by
 * primary key, safe for the same reason `getActiveSpacesForProject` is:
 * this is the space row's own soft-delete (see `applySpacesProjection` in
 * ProjectionPipeline.ts), so the row — and its `projectId` — is still there
 * with `deletedAt` set.
 *
 * One malformed event must never take the whole listener down: each event
 * is handled inside `Effect.catch` that logs and continues, matching
 * `../ws.ts`'s own "log and drop" discipline for its shell projection
 * refetch.
 */
const listenForSpaceEvents = (
  registry: SpaceEventsRegistry.SpaceEventsRegistry["Service"],
  snapshotQuery: ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"],
  engine: OrchestrationEngine.OrchestrationEngineService["Service"],
) =>
  engine.streamDomainEvents.pipe(
    Stream.runForEach((event) =>
      Effect.gen(function* () {
        switch (event.type) {
          case "space.created":
            yield* broadcastCurrentSpaces(registry, snapshotQuery, event.payload.projectId);
            return;
          case "space.deleted": {
            const projectId = yield* snapshotQuery.getSpaceProjectId(event.payload.spaceId);
            if (Option.isNone(projectId)) return;
            yield* broadcastCurrentSpaces(registry, snapshotQuery, projectId.value);
            return;
          }
          default:
            return;
        }
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("space events broadcast failed for one event", {
            eventType: event.type,
            cause,
          }),
        ),
      ),
    ),
    Effect.forkScoped,
  );

const runSpaceEventsSubscriberConnection = (
  socket: Socket.Socket,
  registry: SpaceEventsRegistry.SpaceEventsRegistry["Service"],
  snapshotQuery: ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"],
  projectId: ProjectId,
  authenticate: Effect.Effect<
    unknown,
    EnvironmentAuth.ServerAuthCredentialError | EnvironmentAuth.ServerAuthInternalError
  >,
) =>
  Effect.gen(function* () {
    const write = yield* socket.writer;
    const send: SpaceEventsRegistry.SpaceEventsSubscriberSend = (frame) =>
      write(frame).pipe(Effect.catch(() => Effect.void));

    // Set only once authentication succeeds. Registration (and the initial
    // frame it triggers) never happens before that — see the module doc's
    // AUTH section.
    let registered = false;

    const rejectUpgrade = (code: number, reason: string) =>
      write(new Socket.CloseEvent(code, reason)).pipe(Effect.catch(() => Effect.void));

    yield* socket
      .runString(() => Effect.void, {
        // The writer is only actually pumped once the read loop is running
        // (see EditorPresenceRoute.ts's identical comment) — a write issued
        // before that sits in an internal queue that nothing ever drains
        // and hangs indefinitely. So authentication, the rejecting close on
        // failure, registration, and the initial `spaces` frame all have to
        // happen from inside `onOpen`.
        onOpen: authenticate.pipe(
          Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
            rejectUpgrade(
              credentialCloseCode(error),
              EnvironmentAuth.serverAuthCredentialReason(error),
            ),
          ),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, () =>
            rejectUpgrade(SPACE_EVENTS_INTERNAL_ERROR_CLOSE_CODE, "internal_error"),
          ),
          Effect.flatMap(() =>
            Effect.gen(function* () {
              registered = true;
              yield* registry.addSubscriber(projectId, send);
              const spaces = yield* snapshotQuery.getActiveSpacesForProject(projectId);
              yield* send(buildSpacesFrame(projectId, spaces.map(toSpaceEventsEntry)));
            }).pipe(
              // A read-model failure while sending the initial snapshot is a
              // server fault, not a credential problem — same close code
              // (and same "keep retrying") as an auth internal error.
              Effect.catch(() =>
                rejectUpgrade(SPACE_EVENTS_INTERNAL_ERROR_CLOSE_CODE, "internal_error"),
              ),
            ),
          ),
        ),
      })
      .pipe(
        // A close we initiate ourselves (one of the auth codes above)
        // surfaces as a FAILURE of the read loop, not a clean completion —
        // see EditorPresenceRoute.ts's identical comment and
        // Socket.ts:549's `closeCodeIsError` default.
        Effect.catchFilter(
          Socket.SocketCloseError.filterClean(isSpaceEventsAuthCloseCode),
          () => Effect.void,
        ),
        Effect.ensuring(
          Effect.suspend(() =>
            registered ? registry.removeSubscriber(projectId, send) : Effect.void,
          ),
        ),
      );
  });

export const spaceEventsRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const registry = yield* SpaceEventsRegistry.SpaceEventsRegistry;
    const snapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    const engine = yield* OrchestrationEngine.OrchestrationEngineService;

    yield* listenForSpaceEvents(registry, snapshotQuery, engine);

    return HttpRouter.add(
      "GET",
      SPACE_EVENTS_PATH,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const projectId = readProjectId(request);
        if (projectId === null) {
          return HttpServerResponse.text("Bad Request: projectId query parameter is required", {
            status: 400,
          });
        }

        const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const socket = yield* request.upgrade;
        yield* runSpaceEventsSubscriberConnection(
          socket,
          registry,
          snapshotQuery,
          projectId,
          serverAuth.authenticateWebSocketUpgrade(request),
        );
        return HttpServerResponse.empty();
      }),
    );
  }),
).pipe(Layer.provide(SpaceEventsRegistry.layer));
