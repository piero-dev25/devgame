/**
 * Sign/verify unit coverage for `GenerationAssetAccess.ts` — the fork-owned
 * signed-URL half of Increment 2b.1's media route
 * (docs/v2/specs/increment-2b1-generation-panel.md, step 4). Proves the
 * three rejection classes the spec's own acceptance bar names explicitly:
 * tampered, unsigned/malformed, and expired — plus the plain round trip.
 * Cross-project rejection (a genuine, differently-signed token whose
 * `projectId` doesn't match the asset it's checked against) is
 * `GenerationAssetRoute.test.ts`'s job, one layer up, since THAT check
 * lives in `dispatchGenerationAsset`, not here — this file only proves the
 * claims a caller gets back are genuine and unexpired.
 */
import { describe, expect, it } from "@effect/vitest";
import { GeneratedAssetId, ProjectId } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { issueGenerationAssetUrl, verifyGenerationAssetToken } from "./GenerationAssetAccess.ts";

const fakeServerSecretStoreLayer = Layer.succeed(
  ServerSecretStore.ServerSecretStore,
  ServerSecretStore.ServerSecretStore.of({
    get: () => Effect.succeed(Option.none()),
    set: () => Effect.void,
    create: () => Effect.void,
    getOrCreateRandom: () => Effect.succeed(new Uint8Array(32).fill(7)),
    remove: () => Effect.void,
  }),
);

const projectId = ProjectId.make("project-asset-access");
const assetId = GeneratedAssetId.make("asset-asset-access-1");

describe("GenerationAssetAccess", () => {
  it.effect("issues a token that verifies back to the exact same claims", () =>
    Effect.gen(function* () {
      const issued = yield* issueGenerationAssetUrl({ projectId, assetId, kind: "preview" });
      expect(issued.relativeUrl.startsWith("/api/generation-assets/")).toBe(true);

      const token = issued.relativeUrl.slice("/api/generation-assets/".length);
      const claims = yield* verifyGenerationAssetToken(token);
      expect(Option.isSome(claims)).toBe(true);
      if (Option.isSome(claims)) {
        expect(claims.value.projectId).toBe(projectId);
        expect(claims.value.assetId).toBe(assetId);
        expect(claims.value.kind).toBe("preview");
      }
    }).pipe(Effect.provide(fakeServerSecretStoreLayer)),
  );

  it.effect("rejects a token with a tampered signature", () =>
    Effect.gen(function* () {
      const issued = yield* issueGenerationAssetUrl({ projectId, assetId, kind: "glb" });
      const token = issued.relativeUrl.slice("/api/generation-assets/".length);
      const [encodedPayload, signature] = token.split(".");
      // Flip a character in the signature — a real attacker's most direct
      // move, and the exact tamper class the spec's acceptance bar names.
      const tamperedSignature = signature === "AAAA" ? "BBBB" : "AAAA";
      const tamperedToken = `${encodedPayload}.${tamperedSignature}`;

      const claims = yield* verifyGenerationAssetToken(tamperedToken);
      expect(Option.isNone(claims)).toBe(true);
    }).pipe(Effect.provide(fakeServerSecretStoreLayer)),
  );

  it.effect(
    "rejects a token with a tampered payload (re-signing would be required, and isn't done)",
    () =>
      Effect.gen(function* () {
        const issued = yield* issueGenerationAssetUrl({ projectId, assetId, kind: "glb" });
        const token = issued.relativeUrl.slice("/api/generation-assets/".length);
        const [encodedPayload, signature] = token.split(".");
        // Swap in a DIFFERENT (also validly-encoded) payload without
        // re-signing — simulates an attacker splicing another asset's
        // encoded claims onto this token's own signature.
        const otherIssued = yield* issueGenerationAssetUrl({
          projectId,
          assetId: GeneratedAssetId.make("asset-asset-access-2"),
          kind: "glb",
        });
        const otherEncodedPayload = otherIssued.relativeUrl
          .slice("/api/generation-assets/".length)
          .split(".")[0];
        expect(otherEncodedPayload).not.toBe(encodedPayload);
        const splicedToken = `${otherEncodedPayload}.${signature}`;

        const claims = yield* verifyGenerationAssetToken(splicedToken);
        expect(Option.isNone(claims)).toBe(true);
      }).pipe(Effect.provide(fakeServerSecretStoreLayer)),
  );

  it.effect("rejects an unsigned or malformed token", () =>
    Effect.gen(function* () {
      expect(Option.isNone(yield* verifyGenerationAssetToken(""))).toBe(true);
      expect(Option.isNone(yield* verifyGenerationAssetToken("not-a-real-token"))).toBe(true);
      expect(Option.isNone(yield* verifyGenerationAssetToken("only-one-part."))).toBe(true);
      expect(Option.isNone(yield* verifyGenerationAssetToken(".only-signature"))).toBe(true);
    }).pipe(Effect.provide(fakeServerSecretStoreLayer)),
  );

  it.effect("rejects an expired token, even with a genuine signature", () =>
    Effect.gen(function* () {
      const issued = yield* issueGenerationAssetUrl({ projectId, assetId, kind: "preview" });
      const token = issued.relativeUrl.slice("/api/generation-assets/".length);

      // Confirm it verifies BEFORE expiry (rules out "always rejects" as a
      // vacuous pass), then advance past the 1-hour TTL.
      expect(Option.isSome(yield* verifyGenerationAssetToken(token))).toBe(true);
      yield* TestClock.adjust(Duration.hours(1).pipe(Duration.sum(Duration.seconds(1))));

      const claims = yield* verifyGenerationAssetToken(token);
      expect(Option.isNone(claims)).toBe(true);
    }).pipe(Effect.provide(Layer.mergeAll(fakeServerSecretStoreLayer, TestClock.layer()))),
  );
});
