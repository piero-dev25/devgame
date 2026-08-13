/**
 * In-process coverage for `dispatchGenerationAsset` — the signed-claim
 * verification + cross-project re-check + preview lazy-cache the media
 * route (`GET /api/generation-assets/*`) relies on. Proves the spec's own
 * acceptance bar: "the signed media route verifies claims and REJECTS
 * tampered/unsigned/foreign-project refs" — plus the two "ok" paths (glb,
 * preview-with-lazy-download-then-cache-hit).
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { GeneratedAssetId, ProjectId } from "@t3tools/contracts";
import type { GeneratedAsset } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { dispatchGenerationAsset } from "./GenerationAssetRoute.ts";
import { issueGenerationAssetUrl } from "./GenerationAssetAccess.ts";
import * as GenerationService from "./GenerationService.ts";

/** `dispatchGenerationAsset`'s type declares `HttpClient` as a requirement
 * unconditionally (it's only ACTUALLY invoked on the `kind: "preview"`
 * cache-miss path) — every test must still discharge it. This inert stub
 * (never expected to be called by the notFound/tamper/glb-kind tests below)
 * is the shared default; tests that DO exercise the download path provide
 * their own recording layer instead. */
const inertHttpClientLayer = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.sync(() =>
      HttpClientResponse.fromWeb(request, new Response("unexpected call", { status: 500 })),
    ),
  ),
);

const fakeServerSecretStoreLayer = Layer.succeed(
  ServerSecretStore.ServerSecretStore,
  ServerSecretStore.ServerSecretStore.of({
    get: () => Effect.succeed(Option.none()),
    set: () => Effect.void,
    create: () => Effect.void,
    getOrCreateRandom: () => Effect.succeed(new Uint8Array(32).fill(9)),
    remove: () => Effect.void,
  }),
);

const projectId = ProjectId.make("project-asset-route");
const otherProjectId = ProjectId.make("project-asset-route-other");
const assetId = GeneratedAssetId.make("asset-route-1");

function makeGenerationServiceFake(
  assets: ReadonlyArray<GeneratedAsset>,
): Layer.Layer<GenerationService.GenerationService> {
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  const service: GenerationService.GenerationServiceShape = {
    createJob: () => Effect.die("unexpected createJob call"),
    getJob: () => Effect.die("unexpected getJob call"),
    listJobs: () => Effect.die("unexpected listJobs call"),
    getAsset: (id) => Effect.succeed(Option.fromNullishOr(byId.get(id))),
    getAssetByJobId: () => Effect.die("unexpected getAssetByJobId call"),
  };
  return Layer.succeed(GenerationService.GenerationService, service);
}

const asset = (
  overrides: Partial<GeneratedAsset> & { readonly files: { readonly glb: string } },
): GeneratedAsset => ({
  id: assetId,
  projectId,
  generationJobId: "gen-route-1" as GeneratedAsset["generationJobId"],
  modality: "model3d",
  provider: "tripo",
  preview: { imageUrl: "https://tripo.example/render.png" },
  metadata: { triangles: 100, materials: 1, images: 1, fileBytes: 1_000 },
  createdAt: 1_000,
  ...overrides,
});

describe("dispatchGenerationAsset", () => {
  it.effect("rejects an unsigned or malformed token", () =>
    Effect.gen(function* () {
      const generation = makeGenerationServiceFake([]);
      const outcome = yield* dispatchGenerationAsset("not-a-real-token").pipe(
        Effect.provide(
          Layer.mergeAll(
            generation,
            fakeServerSecretStoreLayer,
            inertHttpClientLayer,
            NodeServices.layer,
          ),
        ),
      );
      expect(outcome).toEqual({ _tag: "notFound" });
    }),
  );

  it.effect("rejects a token with a tampered signature", () =>
    Effect.gen(function* () {
      const generation = makeGenerationServiceFake([
        asset({ files: { glb: "/tmp/does-not-matter/model.glb" } }),
      ]);
      const issued = yield* issueGenerationAssetUrl({ projectId, assetId, kind: "glb" }).pipe(
        Effect.provide(fakeServerSecretStoreLayer),
      );
      const token = issued.relativeUrl.slice("/api/generation-assets/".length);
      const [encodedPayload, signature] = token.split(".");
      const tamperedToken = `${encodedPayload}.${signature === "AAAA" ? "BBBB" : "AAAA"}`;

      const outcome = yield* dispatchGenerationAsset(tamperedToken).pipe(
        Effect.provide(
          Layer.mergeAll(
            generation,
            fakeServerSecretStoreLayer,
            inertHttpClientLayer,
            NodeServices.layer,
          ),
        ),
      );
      expect(outcome).toEqual({ _tag: "notFound" });
    }),
  );

  it.effect(
    "rejects a genuinely-signed token whose claimed projectId does not match the asset's real project",
    () =>
      Effect.gen(function* () {
        // The asset REALLY belongs to `otherProjectId` — the token below is
        // genuinely signed (not tampered) but claims `projectId`, simulating
        // exactly the drift `GenerationAssetAccess.ts`'s own doc comment
        // names: "a future bug where these could drift." The re-check in
        // `dispatchGenerationAsset` — not the signature itself — is what must
        // catch this.
        const generation = makeGenerationServiceFake([
          asset({ projectId: otherProjectId, files: { glb: "/tmp/does-not-matter/model.glb" } }),
        ]);
        const issued = yield* issueGenerationAssetUrl({ projectId, assetId, kind: "glb" }).pipe(
          Effect.provide(fakeServerSecretStoreLayer),
        );
        const token = issued.relativeUrl.slice("/api/generation-assets/".length);

        const outcome = yield* dispatchGenerationAsset(token).pipe(
          Effect.provide(
            Layer.mergeAll(
              generation,
              fakeServerSecretStoreLayer,
              inertHttpClientLayer,
              NodeServices.layer,
            ),
          ),
        );
        expect(outcome).toEqual({ _tag: "notFound" });
      }),
  );

  it.effect("rejects a genuinely-signed token for an assetId that no longer exists", () =>
    Effect.gen(function* () {
      const generation = makeGenerationServiceFake([]);
      const issued = yield* issueGenerationAssetUrl({ projectId, assetId, kind: "glb" }).pipe(
        Effect.provide(fakeServerSecretStoreLayer),
      );
      const token = issued.relativeUrl.slice("/api/generation-assets/".length);

      const outcome = yield* dispatchGenerationAsset(token).pipe(
        Effect.provide(
          Layer.mergeAll(
            generation,
            fakeServerSecretStoreLayer,
            inertHttpClientLayer,
            NodeServices.layer,
          ),
        ),
      );
      expect(outcome).toEqual({ _tag: "notFound" });
    }),
  );

  it.effect("resolves a valid glb-kind token to the asset's real (unredacted) path", () =>
    Effect.gen(function* () {
      const realGlbPath = "/state/generated/project-asset-route/asset-route-1/model.glb";
      const generation = makeGenerationServiceFake([asset({ files: { glb: realGlbPath } })]);
      const issued = yield* issueGenerationAssetUrl({ projectId, assetId, kind: "glb" }).pipe(
        Effect.provide(fakeServerSecretStoreLayer),
      );
      const token = issued.relativeUrl.slice("/api/generation-assets/".length);

      const outcome = yield* dispatchGenerationAsset(token).pipe(
        Effect.provide(
          Layer.mergeAll(
            generation,
            fakeServerSecretStoreLayer,
            inertHttpClientLayer,
            NodeServices.layer,
          ),
        ),
      );
      expect(outcome).toEqual({ _tag: "ok", path: realGlbPath, contentType: "model/gltf-binary" });
    }),
  );

  it.effect(
    "lazily downloads and caches the preview image on first request, then serves the cached file on a second request WITHOUT re-downloading",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const assetDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-gen-asset-route-",
        });
        const glbPath = path.join(assetDir, "model.glb");
        yield* fileSystem.writeFileString(glbPath, "not-a-real-glb");

        const generation = makeGenerationServiceFake([asset({ files: { glb: glbPath } })]);
        const issued = yield* issueGenerationAssetUrl({ projectId, assetId, kind: "preview" }).pipe(
          Effect.provide(fakeServerSecretStoreLayer),
        );
        const token = issued.relativeUrl.slice("/api/generation-assets/".length);

        let downloadCount = 0;
        const fakeImageBytes = new Uint8Array([1, 2, 3, 4]);
        const httpClientLayer = Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            downloadCount += 1;
            return Effect.sync(() =>
              HttpClientResponse.fromWeb(
                request,
                new Response(fakeImageBytes, {
                  status: 200,
                  headers: { "content-type": "image/png" },
                }),
              ),
            );
          }),
        );

        const dependencies = Layer.mergeAll(
          generation,
          fakeServerSecretStoreLayer,
          httpClientLayer,
        );

        const first = yield* dispatchGenerationAsset(token).pipe(Effect.provide(dependencies));
        expect(first._tag).toBe("ok");
        if (first._tag !== "ok") return;
        expect(first.contentType).toBe("image/png");
        expect(first.path).toBe(path.join(assetDir, "preview.png"));
        expect(downloadCount).toBe(1);
        const written = yield* fileSystem.readFile(first.path);
        expect(Array.from(written)).toEqual(Array.from(fakeImageBytes));

        // Second request — the manifest sidecar should short-circuit the
        // download entirely.
        const second = yield* dispatchGenerationAsset(token).pipe(Effect.provide(dependencies));
        expect(second).toEqual(first);
        expect(downloadCount).toBe(1);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("returns notFound (never a 500) when the preview download fails", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const assetDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-gen-asset-route-fail-",
      });
      const glbPath = path.join(assetDir, "model.glb");
      yield* fileSystem.writeFileString(glbPath, "not-a-real-glb");

      const generation = makeGenerationServiceFake([asset({ files: { glb: glbPath } })]);
      const issued = yield* issueGenerationAssetUrl({ projectId, assetId, kind: "preview" }).pipe(
        Effect.provide(fakeServerSecretStoreLayer),
      );
      const token = issued.relativeUrl.slice("/api/generation-assets/".length);

      const httpClientLayer = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() =>
            HttpClientResponse.fromWeb(request, new Response("nope", { status: 500 })),
          ),
        ),
      );

      const outcome = yield* dispatchGenerationAsset(token).pipe(
        Effect.provide(Layer.mergeAll(generation, fakeServerSecretStoreLayer, httpClientLayer)),
      );
      expect(outcome).toEqual({ _tag: "notFound" });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "SECURITY (fix round finding 3): a remote content-type outside the image allowlist is NEVER served or cached — never reflected verbatim",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const assetDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-gen-asset-route-contenttype-",
        });
        const glbPath = path.join(assetDir, "model.glb");
        yield* fileSystem.writeFileString(glbPath, "not-a-real-glb");

        const generation = makeGenerationServiceFake([asset({ files: { glb: glbPath } })]);
        const issued = yield* issueGenerationAssetUrl({ projectId, assetId, kind: "preview" }).pipe(
          Effect.provide(fakeServerSecretStoreLayer),
        );
        const token = issued.relativeUrl.slice("/api/generation-assets/".length);

        // A misbehaving/compromised remote CDN — returns real bytes but
        // claims `text/html`, the exact stored-content-injection shape the
        // finding describes: without the allowlist clamp, this would be
        // cached AND later served, from THIS app's own origin, as
        // text/html (with nosniff, so a browser trusts it outright).
        const htmlPayload = "<script>alert(document.cookie)</script>";
        const httpClientLayer = Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.sync(() =>
              HttpClientResponse.fromWeb(
                request,
                new Response(htmlPayload, {
                  status: 200,
                  headers: { "content-type": "text/html" },
                }),
              ),
            ),
          ),
        );

        const outcome = yield* dispatchGenerationAsset(token).pipe(
          Effect.provide(Layer.mergeAll(generation, fakeServerSecretStoreLayer, httpClientLayer)),
        );

        // Never reflected as text/html, in ANY outcome shape — either
        // rejected outright (notFound) or, if ever changed to substitute a
        // safe fallback type instead, definitely not the attacker-supplied
        // one.
        if (outcome._tag === "ok") {
          expect(outcome.contentType).not.toBe("text/html");
        } else {
          expect(outcome).toEqual({ _tag: "notFound" });
        }

        // Never cached to disk under any name either — a hostile response
        // must leave NOTHING behind for a later request to serve.
        const entries = yield* fileSystem.readDirectory(assetDir);
        const cachedFiles = entries.filter((entry) => entry !== "model.glb");
        expect(cachedFiles).toEqual([]);
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
