/**
 * Signed, time-limited URLs onto `GET /api/generation-assets/*`
 * (`GenerationAssetRoute.ts`) — Increment 2b.1's media-serving half
 * (docs/v2/specs/increment-2b1-generation-panel.md, step 4). Mirrors
 * `assets/AssetAccess.ts`'s own sign/verify shape (reuses its generic
 * `base64UrlEncode`/`signPayload`/`timingSafeEqualBase64Url`/
 * `base64UrlDecodeUtf8` helpers from `auth/utils.ts`, per the spec's
 * explicit instruction) but is its OWN fork-owned file with its OWN
 * `ServerSecretStore` key — the spec is explicit that this is a NEW file,
 * not a widening of `AssetAccess.ts`'s vendor-owned claims union (that file
 * and `packages/contracts/src/assets.ts` are both off-limits edits for this
 * increment).
 *
 * Deliberately scoped to SIGN/VERIFY only — no filesystem resolution here.
 * `GenerationAssetRoute.ts` owns turning a verified `{projectId, assetId,
 * kind}` claim into an actual path (including the preview lazy-cache), the
 * same "route resolves, this module only proves the claim is genuine and
 * unexpired" split `AssetAccess.ts`'s `resolveAsset` uses for the
 * filesystem side but this file does NOT need, since generation assets have
 * no arbitrary-file-tree case to defend against — every real path is
 * derived from a server-known `GeneratedAsset`, never from client input.
 */
import { GeneratedAssetId, ProjectId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  signPayload,
  timingSafeEqualBase64Url,
} from "../auth/utils.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

export const GENERATION_ASSET_ROUTE_PREFIX = "/api/generation-assets";

/** A separate secret from `AssetAccess.ts`'s own `asset-access-signing-key`
 * — the spec's "a separate ServerSecretStore key" instruction. Rotating one
 * never invalidates the other's outstanding tokens. */
const SIGNING_SECRET_NAME = "generation-asset-access-signing-key";

/** Matches `AssetAccess.ts`'s own `ASSET_TOKEN_TTL_MS` — no reason for a
 * shorter or longer window; the panel re-issues a fresh URL on every poll
 * anyway (`GenerationListRoute.ts` mints one per `generation/list` call), so
 * this only bounds how long a single already-rendered `<img>` tag stays
 * valid between polls. */
const GENERATION_ASSET_TOKEN_TTL_MS = 60 * 60 * 1000;

export const GenerationAssetKind = Schema.Literals(["preview", "glb"]);
export type GenerationAssetKind = typeof GenerationAssetKind.Type;

const GenerationAssetClaimsSchema = Schema.Struct({
  version: Schema.Literal(1),
  projectId: ProjectId,
  assetId: GeneratedAssetId,
  kind: GenerationAssetKind,
  expiresAt: Schema.Number,
});
export type GenerationAssetClaims = typeof GenerationAssetClaimsSchema.Type;

const GenerationAssetClaimsJson = Schema.fromJsonString(GenerationAssetClaimsSchema);
const decodeGenerationAssetClaims = Schema.decodeUnknownOption(GenerationAssetClaimsJson);
const encodeGenerationAssetClaims = Schema.encodeSync(GenerationAssetClaimsJson);

function decodeClaims(encodedPayload: string): GenerationAssetClaims | null {
  try {
    return Option.getOrNull(decodeGenerationAssetClaims(base64UrlDecodeUtf8(encodedPayload)));
  } catch {
    return null;
  }
}

/**
 * Issues a signed URL for one `{projectId, assetId, kind}` ref. `projectId`
 * is bound INTO the signed payload (not just the query string) — the media
 * route's own cross-project check (`GenerationAssetRoute.ts`'s
 * `dispatchGenerationAsset`) compares this against the asset's OWN real
 * `projectId`, the same "re-apply the project check, never trust the
 * request alone" posture every MCP handler in handlers.ts already applies
 * by hand (merge-gate P1 #2's pattern, extended to the web media path).
 */
export const issueGenerationAssetUrl = Effect.fn("GenerationAssetAccess.issueGenerationAssetUrl")(
  function* (input: {
    readonly projectId: ProjectId;
    readonly assetId: GeneratedAssetId;
    readonly kind: GenerationAssetKind;
  }) {
    const expiresAt = (yield* Clock.currentTimeMillis) + GENERATION_ASSET_TOKEN_TTL_MS;
    const claims: GenerationAssetClaims = {
      version: 1,
      projectId: input.projectId,
      assetId: input.assetId,
      kind: input.kind,
      expiresAt,
    };
    const secretStore = yield* ServerSecretStore.ServerSecretStore;
    // Infra failure (disk/secret-store trouble) — dies rather than a typed
    // error, same posture `GenerationService.ts`'s own `crypto.randomUUIDv4
    // .pipe(Effect.orDie)` takes for the identical class of failure: there
    // is no meaningful client-facing recovery from "the server couldn't
    // load its own signing key," so this surfaces as an ordinary 500
    // rather than inventing a bespoke typed error nothing downstream acts
    // on differently.
    const signingSecret = yield* secretStore
      .getOrCreateRandom(SIGNING_SECRET_NAME, 32)
      .pipe(Effect.orDie);
    const encodedPayload = base64UrlEncode(encodeGenerationAssetClaims(claims));
    const token = `${encodedPayload}.${signPayload(encodedPayload, signingSecret)}`;
    return { relativeUrl: `${GENERATION_ASSET_ROUTE_PREFIX}/${token}`, expiresAt };
  },
);

/**
 * Verifies a token's signature and expiry and returns its decoded claims —
 * `Option.none` on ANY of: malformed token shape, bad/missing signature, an
 * unloadable signing key, undecodable claims JSON, or an expired token.
 * Never fails: every one of those is a 404 to the caller, not a 500 — same
 * "resolve to null/none on anything short of a clean, valid claim" posture
 * `AssetAccess.ts`'s `resolveAsset` uses for its own signature/decode/
 * expiry checks.
 */
export const verifyGenerationAssetToken = Effect.fn(
  "GenerationAssetAccess.verifyGenerationAssetToken",
)(function* (token: string) {
  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature) return Option.none<GenerationAssetClaims>();

  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const signingSecret = yield* secretStore.getOrCreateRandom(SIGNING_SECRET_NAME, 32).pipe(
    Effect.tapError((cause) =>
      Effect.logError("Failed to load the generation-asset signing key.", { cause }),
    ),
    Effect.orElseSucceed(() => null),
  );
  if (!signingSecret) return Option.none<GenerationAssetClaims>();
  if (!timingSafeEqualBase64Url(signature, signPayload(encodedPayload, signingSecret))) {
    return Option.none<GenerationAssetClaims>();
  }

  const claims = decodeClaims(encodedPayload);
  if (!claims) return Option.none<GenerationAssetClaims>();
  if (claims.expiresAt <= (yield* Clock.currentTimeMillis))
    return Option.none<GenerationAssetClaims>();
  return Option.some(claims);
});
