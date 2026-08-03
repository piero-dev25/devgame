/**
 * Space Events wire protocol — server → client only.
 *
 * Transport: WebSocket, one JSON text frame per broadcast. There is exactly
 * one frame kind (`spaces`), because the protocol is level-style rather than
 * edge-style: every broadcast carries the *complete* current set of active
 * (non-deleted) spaces for one project, not a single created/deleted delta.
 * A client that misses a frame — a reconnect, a dropped connection, a
 * coalesced burst — is still correct on the very next frame, because the
 * frame is the whole truth rather than an increment to apply. See
 * `EditorPresenceRegistry`'s doc comment for the same reasoning applied to
 * presence chips; this route is the same call for spaces.
 *
 * Deliberately one-directional: unlike Editor Presence, nothing here
 * publishes. A client only ever subscribes (`GET
 * /space-events?projectId=...`), so there is no inbound frame to parse.
 */
import type { ProjectId, SpaceId } from "@t3tools/contracts";

export interface SpaceEventsEntry {
  readonly id: SpaceId;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Server → subscriber `spaces` frame: the complete active-space list for
 * one project at the moment of broadcast. */
export function buildSpacesFrame(
  projectId: ProjectId,
  spaces: ReadonlyArray<SpaceEventsEntry>,
): string {
  return JSON.stringify({ v: 1, type: "spaces", projectId, spaces });
}
