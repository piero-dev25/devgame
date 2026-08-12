// @effect-diagnostics nodeBuiltinImport:off
//
// LIVE acceptance for V2 Increment 1 (spec item 3): a real Tripo round-trip
// through the real GenerationService — submit → server-owned poll loop →
// GLB download → server-side inspection → recorded GeneratedAsset.
//
// GATED OFF by default (like the repo's GrokAcpCliProbe live probes) so CI
// never spends credits. Run explicitly:
//   DEVGAME_GENERATION_LIVE=1 pnpm vitest run src/generation/GenerationService.live.test.ts
// Requires the owner's Tripo key at ~/.config/devgame/tripo-api-key (D3) and
// spends ~20 Tripo credits. Generation takes ~90-180s; deadline is generous.
import { expect, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { FetchHttpClient } from "effect/unstable/http";
import { describe } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { GenerationService, layer as generationServiceLayer } from "./GenerationService.ts";
import { layer as tripoProviderLayer } from "./providers/TripoProvider.ts";

const liveEnabled = process.env.DEVGAME_GENERATION_LIVE === "1";

// The real server provides ServerSecretStore (where TripoProvider reads/seeds
// the key) + Crypto; wire the same real layers here.
const InfraLayer = Layer.mergeAll(
  ServerSecretStore.layer,
  NodeCrypto.layer,
  FetchHttpClient.layer,
).pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-generation-live-" })),
  Layer.provideMerge(NodeServices.layer),
);

const LiveLayer = generationServiceLayer({ pollIntervalMs: 5000, pollDeadlineMs: 300_000 }).pipe(
  Layer.provide(tripoProviderLayer),
  Layer.provideMerge(InfraLayer),
);

describe.runIf(liveEnabled)("GenerationService (LIVE Tripo)", () => {
  it.live(
    "generates a barrel, polls to success, and inspects a real triangle count",
    () =>
      Effect.gen(function* () {
        const service = yield* GenerationService;

        const job = yield* service.createJob({
          projectId: ProjectId.make("live-project"),
          threadId: ThreadId.make("live-thread"),
          prompt: "a stylized low-poly wooden barrel, game asset",
          parameters: { faceLimit: 6000 },
        });
        expect(job.status).toBe("created");

        // Poll the SERVER-owned job (the request effect already returned;
        // the poll loop lives in the service scope).
        let terminal = job;
        while (terminal.status !== "succeeded" && terminal.status !== "failed") {
          yield* Effect.sleep(Duration.seconds(5));
          const current = yield* service.getJob(job.id);
          if (Option.isSome(current)) terminal = current.value;
        }

        expect(terminal.status).toBe("succeeded");
        expect(terminal.assetId).not.toBeNull();

        const asset = yield* service.getAssetByJobId(job.id);
        expect(Option.isSome(asset)).toBe(true);
        if (Option.isSome(asset)) {
          // Real generated barrel: face_limit=6000 → a few thousand tris,
          // never zero and never the ~500k uncapped default (proves the cap
          // took AND that inspection read the real mesh).
          expect(asset.value.metadata.triangles).toBeGreaterThan(1000);
          expect(asset.value.metadata.triangles).toBeLessThan(20_000);
          expect(asset.value.metadata.fileBytes).toBeGreaterThan(0);
        }
      }).pipe(Effect.provide(LiveLayer)),
    { timeout: 360_000 },
  );
});
