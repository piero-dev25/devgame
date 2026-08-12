// @effect-diagnostics nodeBuiltinImport:off
//
// LIVE acceptance for V2 Increment 2a (spec item 3): the REAL
// import_generated_asset handler, against a REAL generated barrel (Tripo) and a
// REAL live Unity editor, proving the imported model is TEXTURED (material's
// _BaseMap/_BumpMap bound), then cleaning the project back to pristine.
//
// GATED OFF by default. Requires a LIVE Unity editor open on the target project
// and the owner's Tripo key. Run explicitly (spends ~20 Tripo credits, convert
// is free):
//   DEVGAME_IMPORT_LIVE=1 MAFIA_PROJECT_PATH="/Users/pieroherrera/Projects/Mafia Game" \
//     pnpm vitest run src/mcp/toolkits/generation/importGeneratedAsset.live.test.ts
//
// Only the DB projection (threadId->projectId->workspaceRoot) is stubbed — it is
// unit-tested elsewhere; everything else (Tripo derive, GLB texture extraction,
// the Unity CLI sequence, the write-eval) is the real code path.
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type GeneratedAssetId,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { FetchHttpClient } from "effect/unstable/http";
import { describe } from "vite-plus/test";

import * as ServerConfig from "../../../config.ts";
import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import {
  GenerationService,
  layer as generationServiceLayer,
} from "../../../generation/GenerationService.ts";
import { Model3dProvider } from "../../../generation/providers/Model3dProvider.ts";
import { layer as tripoProviderLayer } from "../../../generation/providers/TripoProvider.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProcessRunner from "../../../processRunner.ts";
import * as UnityPipelineClient from "../../../unity/UnityPipelineClient.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { importGeneratedAsset } from "./handlers.ts";

const liveEnabled = process.env.DEVGAME_IMPORT_LIVE === "1";
const MAFIA = process.env.MAFIA_PROJECT_PATH ?? "/Users/pieroherrera/Projects/Mafia Game";

const grantedScope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-live"),
  threadId: ThreadId.make("thread-live"),
  providerSessionId: "provider-session-live",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["preview", "generation"]),
  issuedAt: 1,
};
const liveProjectId = ProjectId.make("live-import-project");

// Only the two projection reads import_generated_asset performs are stubbed to
// point at the live Mafia Game workspace; every other Service method dies loudly.
const projectionStub = (): ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"] =>
  new Proxy({} as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"], {
    get: (_t, prop) => {
      if (prop === "getThreadShellById") {
        return () =>
          Effect.succeed(
            Option.some({ id: grantedScope.threadId, projectId: liveProjectId } as never),
          );
      }
      if (prop === "getProjectShellById") {
        return () => Effect.succeed(Option.some({ workspaceRoot: MAFIA } as never));
      }
      return () => Effect.die(`unexpected ProjectionSnapshotQuery.${String(prop)} call`);
    },
  });

const InfraLayer = Layer.mergeAll(
  ServerSecretStore.layer,
  NodeCrypto.layer,
  FetchHttpClient.layer,
).pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-import-live-" })),
  Layer.provideMerge(NodeServices.layer),
);

const RuntimeLayer = Layer.mergeAll(
  generationServiceLayer({ pollIntervalMs: 5000, pollDeadlineMs: 300_000 }).pipe(
    Layer.provide(tripoProviderLayer),
  ),
  tripoProviderLayer, // Model3dProvider for the handler's own deriveFbx
  UnityPipelineClient.layer.pipe(Layer.provide(ProcessRunner.layer)),
  Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, projectionStub()),
).pipe(Layer.provideMerge(InfraLayer));

describe.runIf(liveEnabled)("import_generated_asset (LIVE Tripo + LIVE Unity)", () => {
  it.live(
    "generates a barrel, imports it into the live editor, and proves it is textured",
    () =>
      Effect.gen(function* () {
        const service = yield* GenerationService;
        const unity = yield* UnityPipelineClient.UnityPipelineClient;

        // 1) real generation
        const job = yield* service.createJob({
          projectId: liveProjectId,
          threadId: grantedScope.threadId,
          prompt: "a stylized low-poly wooden barrel, game asset",
          parameters: { faceLimit: 6000 },
        });
        let terminal = job;
        while (terminal.status !== "succeeded" && terminal.status !== "failed") {
          yield* Effect.sleep(Duration.seconds(5));
          const cur = yield* service.getJob(job.id);
          if (Option.isSome(cur)) terminal = cur.value;
        }
        expect(terminal.status).toBe("succeeded");
        expect(terminal.assetId).not.toBeNull();
        const assetId = terminal.assetId as GeneratedAssetId;

        // 2) the REAL tool — derive FBX, extract textures, drive the live editor
        const result = yield* importGeneratedAsset({ assetId }).pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, grantedScope),
        );

        // 3) tool contract
        expect(result.assetPath).toBe(`Assets/DevGame/${assetId}/model.fbx`);
        expect(result.materialPath).toBe(`Assets/DevGame/${assetId}/material.mat`);
        expect(result.texturesCarried).toBe(true);
        expect(result.unityStats.triangles).toBeGreaterThan(1000);
        expect(result.unityStats.triangles).toBeLessThan(20_000);

        // 4) INDEPENDENT textured proof: read the created material back from the
        // live editor and assert the PBR maps actually bound.
        const probe = yield* unity.eval(
          MAFIA,
          [
            `var m = UnityEditor.AssetDatabase.LoadAssetAtPath<UnityEngine.Material>("${result.materialPath}");`,
            `return new { shader = m.shader.name, hasBaseMap = m.GetTexture("_BaseMap") != null, hasBumpMap = m.GetTexture("_BumpMap") != null };`,
          ].join("\n"),
        );
        expect(probe._tag).toBe("ok");
        if (probe._tag === "ok") {
          const v = probe.value as { shader: string; hasBaseMap: boolean; hasBumpMap: boolean };
          yield* Effect.logInfo(
            `LIVE material probe: shader=${v.shader} hasBaseMap=${v.hasBaseMap} hasBumpMap=${v.hasBumpMap}`,
          );
          expect(v.hasBaseMap).toBe(true); // textured, not white
          expect(v.hasBumpMap).toBe(true);
          expect(v.shader).toContain("Lit");
        }

        return assetId;
      }).pipe(
        // 5) cleanup ALWAYS: delete the imported subtree + refresh so Mafia Game
        // returns to pristine even if an assertion above failed.
        Effect.ensuring(
          Effect.gen(function* () {
            const unity = yield* UnityPipelineClient.UnityPipelineClient;
            yield* unity
              .eval(
                MAFIA,
                [
                  `UnityEditor.AssetDatabase.DeleteAsset("Assets/DevGame");`,
                  `UnityEditor.AssetDatabase.Refresh();`,
                  `return new { deleted = true };`,
                ].join("\n"),
              )
              .pipe(Effect.ignore);
          }).pipe(Effect.provide(RuntimeLayer), Effect.orDie),
        ),
        Effect.provide(RuntimeLayer),
      ),
    { timeout: 420_000 },
  );
});
