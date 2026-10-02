import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { AuthAccessSnapshot, AuthPairingLink } from "./auth.ts";

// Decode through the JSON codec, as the HTTP/RPC wire does: timestamps arrive
// as ISO strings and `Schema.DateTimeUtc` only accepts them via its JSON codec.
const decodePairingLink = Schema.decodeUnknownSync(Schema.toCodecJson(AuthPairingLink));
const decodeAccessSnapshot = Schema.decodeUnknownSync(Schema.toCodecJson(AuthAccessSnapshot));

const pairingLink = {
  id: "link-1",
  subject: "owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2026-01-02T00:00:00.000Z",
};

describe("AuthPairingLink read model", () => {
  it("drops scope literals this build does not know instead of failing the snapshot", () => {
    const snapshot = decodeAccessSnapshot({
      pairingLinks: [
        {
          ...pairingLink,
          scopes: ["orchestration:read", "presence:read", "scope-from-a-newer-server"],
        },
      ],
      clientSessions: [],
    });

    expect(snapshot.pairingLinks[0]?.scopes).toEqual(["orchestration:read", "presence:read"]);
  });

  it("never carries the pairing credential, even when an older server still sends it", () => {
    const link = decodePairingLink({
      ...pairingLink,
      credential: "secret-pairing-token",
      scopes: ["presence:command"],
    });

    expect(link.scopes).toEqual(["presence:command"]);
    expect("credential" in link).toBe(false);
  });
});
