/**
 * In-process coverage for `dispatchUnityPipelineInstall` — the scope-gate +
 * dispatch logic `POST /unity/pipeline-install` relies on, mirroring
 * `UnityCommandRoute.test.ts`'s own identical pattern for the SAME scope
 * (`AuthPresenceCommandScope`) and `UnitySetupProbeRoute.test.ts`'s
 * scope-gate shape. That file's own closing comment explains why there is
 * no automated HTTP round-trip test for this route family in this repo yet
 * — the same gap applies here, and was closed the same way it always is in
 * this file family: a real Node HTTP server, the exact `server.ts`
 * composition, a real bearer session, and a real `POST
 * /unity/pipeline-install` request — 200 for an owner-scoped token
 * (real install against a disposable scratch project, real manifest.json
 * line confirmed on disk), 403 for a `presence:read`-only token. Not
 * automated here for the identical reason `UnityCommandRoute.test.ts`
 * gives (this repo's `globalFetchInEffect` diagnostic, no existing
 * suppression to follow as precedent).
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import {
  AuthSessionId,
  AuthOrchestrationOperateScope,
  AuthPresenceCommandScope,
  AuthPresenceReadScope,
  OrchestrationProjectShell,
  ProjectId,
  UnityPipelineInstallResult,
  UnityEditorPresencePairingFile,
} from "@t3tools/contracts";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";

import {
  dispatchUnityPipelineInstall,
  unitySelectionPackageSourceCandidates,
} from "./UnityPipelineInstallRoute.ts";
import * as UnityPipelineClient from "./UnityPipelineClient.ts";
import * as UnityPairingHandoff from "./UnityPairingHandoff.ts";
import {
  installUnityEmbeddedSelectionPackage,
  LEGACY_UNITY_SELECTION_PACKAGE_ID,
  UNITY_SELECTION_PACKAGE_ID,
} from "./UnityEmbeddedSelectionPackage.ts";

const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeProjectShell = Schema.decodeUnknownSync(OrchestrationProjectShell);
const decodePairingFile = Schema.decodeUnknownEffect(
  Schema.fromJsonString(UnityEditorPresencePairingFile),
);
const decodeInstallResult = Schema.decodeUnknownEffect(UnityPipelineInstallResult);
const PROJECT_ID = ProjectId.make("project-unity");
const PROJECT_ROOT = "/Users/piero/Projects/Deepmind";

function makeProject(workspaceRoot: string, title = "Deepmind") {
  return decodeProjectShell({
    id: PROJECT_ID,
    title,
    workspaceRoot,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:00.000Z",
  });
}

const PROJECT = makeProject(PROJECT_ROOT);

function makeSession(
  scopes: EnvironmentAuth.AuthenticatedSession["scopes"],
): EnvironmentAuth.AuthenticatedSession {
  return {
    sessionId: AuthSessionId.make("test-session"),
    subject: "test-subject",
    method: "bearer-access-token",
    scopes,
  };
}

function makeProjectionSnapshotQuerySpy(project: typeof PROJECT | null | "fail"): {
  readonly layer: Layer.Layer<ProjectionSnapshotQuery.ProjectionSnapshotQuery>;
  readonly requestedProjectIds: ReadonlyArray<string>;
} {
  const requestedProjectIds: Array<string> = [];
  const service: ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"] = {
    getCommandReadModel: () => Effect.die("unexpected getCommandReadModel call"),
    getSnapshot: () => Effect.die("unexpected getSnapshot call"),
    getShellSnapshot: () => Effect.die("unexpected getShellSnapshot call"),
    getArchivedShellSnapshot: () => Effect.die("unexpected getArchivedShellSnapshot call"),
    searchThreads: () => Effect.die("unexpected searchThreads call"),
    getSnapshotSequence: () => Effect.die("unexpected getSnapshotSequence call"),
    getCounts: () => Effect.die("unexpected getCounts call"),
    getActiveProjectByWorkspaceRoot: () =>
      Effect.die("unexpected getActiveProjectByWorkspaceRoot call"),
    getProjectShellById: (projectId) =>
      Effect.suspend(() => {
        requestedProjectIds.push(projectId);
        // "fail" simulates the projection lookup ITSELF failing (locked DB,
        // row that no longer decodes) — a different branch from Option.none,
        // and the one merge-gate F2 found uncovered and silently swallowed.
        if (project === "fail") {
          return Effect.fail(
            new PersistenceSqlError({ operation: "test: projection lookup failure" }),
          );
        }
        return Effect.succeed(project === null ? Option.none() : Option.some(project));
      }),
    getFirstActiveThreadIdByProjectId: () =>
      Effect.die("unexpected getFirstActiveThreadIdByProjectId call"),
    getActiveSpacesForProject: () => Effect.die("unexpected getActiveSpacesForProject call"),
    getSpaceProjectId: () => Effect.die("unexpected getSpaceProjectId call"),
    getThreadCheckpointContext: () => Effect.die("unexpected getThreadCheckpointContext call"),
    getFullThreadDiffContext: () => Effect.die("unexpected getFullThreadDiffContext call"),
    getThreadShellById: () => Effect.die("unexpected getThreadShellById call"),
    getThreadDetailById: () => Effect.die("unexpected getThreadDetailById call"),
    getThreadDetailSnapshot: () => Effect.die("unexpected getThreadDetailSnapshot call"),
  };
  return {
    layer: Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, service),
    requestedProjectIds,
  };
}

/** A `UnityPipelineClient` double that records which `workspaceRoot`
 * `install`/`list`/`packageResolve` were called with, and returns a fixed
 * (optionally overridden) outcome for each — this suite is about ROUTING,
 * AUTHORIZATION, and the task #130 liveness gate, not about CLI parsing
 * (already covered by `UnityPipelineClient.test.ts`'s own `install`/`list`/
 * `packageResolve` describe blocks).
 *
 * `list`/`packageResolve` DEFAULT to "no live Editor found for this
 * project" (empty `instances`) / "ok" respectively — the common case every
 * test in this suite written before task #130 implicitly assumes, and the
 * SAFE default for the liveness gate itself (never call `packageResolve`
 * without positive evidence of a live match). Only the tests that actually
 * exercise the gate override them. */
function makeUnityPipelineClientSpy(
  options: {
    readonly install?: (
      workspaceRoot: string,
    ) => Effect.Effect<
      UnityPipelineClient.UnityPipelineResult<UnityPipelineClient.UnityPipelineInstallResult>
    >;
    readonly list?: (
      workspaceRoot: string,
    ) => Effect.Effect<
      UnityPipelineClient.UnityPipelineResult<UnityPipelineClient.UnityPipelineListResult>
    >;
    readonly packageResolve?: (
      workspaceRoot: string,
    ) => Effect.Effect<UnityPipelineClient.UnityPipelineResult<void>>;
  } = {},
): {
  readonly layer: Layer.Layer<UnityPipelineClient.UnityPipelineClient>;
  readonly calls: Array<{ readonly method: string; readonly workspaceRoot: string }>;
} {
  const calls: Array<{ readonly method: string; readonly workspaceRoot: string }> = [];
  const defaultInstallResult: UnityPipelineClient.UnityPipelineResult<UnityPipelineClient.UnityPipelineInstallResult> =
    {
      _tag: "ok",
      value: { packageId: "com.unity.pipeline", version: "0.4.0-exp.1", alreadyInstalled: false },
    };
  const defaultListResult: UnityPipelineClient.UnityPipelineResult<UnityPipelineClient.UnityPipelineListResult> =
    { _tag: "ok", value: { instances: [], latestVersion: null, unparseableInstanceCount: 0 } };
  const defaultPackageResolveResult: UnityPipelineClient.UnityPipelineResult<void> = {
    _tag: "ok",
    value: undefined,
  };
  const layer = Layer.succeed(
    UnityPipelineClient.UnityPipelineClient,
    UnityPipelineClient.UnityPipelineClient.of({
      isAvailable: () => Effect.succeed(true),
      status: () => Effect.die("unexpected status call"),
      play: () => Effect.die("unexpected play call"),
      stop: () => Effect.die("unexpected stop call"),
      pause: () => Effect.die("unexpected pause call"),
      list: (workspaceRoot) => {
        calls.push({ method: "list", workspaceRoot });
        return options.list?.(workspaceRoot) ?? Effect.succeed(defaultListResult);
      },
      install: (workspaceRoot) => {
        calls.push({ method: "install", workspaceRoot });
        return options.install?.(workspaceRoot) ?? Effect.succeed(defaultInstallResult);
      },
      open: () => Effect.die("unexpected open call"),
      packageResolve: (workspaceRoot) => {
        calls.push({ method: "packageResolve", workspaceRoot });
        return (
          options.packageResolve?.(workspaceRoot) ?? Effect.succeed(defaultPackageResolveResult)
        );
      },
      // Never exercised by this file's own tests — see UnityCommandRoute.test.ts's
      // identical comment on the same latent "full interface" gap, now
      // also covering Increment 2a's three new authoring commands.
      importAsset: () => Effect.die("unexpected importAsset call"),
      setImportSettings: () => Effect.die("unexpected setImportSettings call"),
      eval: () => Effect.die("unexpected eval call"),
    }),
  );
  return { layer, calls };
}

function makeUnityPairingHandoffSpy(
  options: {
    readonly alreadyPaired?: boolean;
    readonly issueFails?: boolean;
  } = {},
) {
  const registeredRoots: Array<string> = [];
  const issued: Array<{
    readonly label?: string;
    readonly scopes?: ReadonlyArray<string>;
    readonly ttl?: Duration.Duration;
  }> = [];
  const layer = Layer.effect(
    UnityPairingHandoff.UnityPairingHandoff,
    UnityPairingHandoff.make({
      serverUrl: "http://127.0.0.1:3773",
      isAlreadyPaired: (workspaceRoot) => {
        registeredRoots.push(workspaceRoot);
        return Effect.succeed(options.alreadyPaired ?? false);
      },
      issuePairingCredential: (input) => {
        issued.push(input);
        return options.issueFails
          ? new UnityPairingHandoff.UnityPairingHandoffDependencyError({
              operation: "credentialMint",
              cause: "pairing mint failed",
            })
          : Effect.succeed({ credential: "PAIRING1234" });
      },
    }),
  ).pipe(Layer.provide(NodeServices.layer));
  return { issued, layer, registeredRoots };
}

/** Provides the CLI double and projection-store double around one dispatch. */
const runDispatchTest = (
  spy: ReturnType<typeof makeUnityPipelineClientSpy>,
  session: EnvironmentAuth.AuthenticatedSession,
  projection: ReturnType<typeof makeProjectionSnapshotQuerySpy>,
  pairing: ReturnType<typeof makeUnityPairingHandoffSpy> = makeUnityPairingHandoffSpy(),
) =>
  dispatchUnityPipelineInstall(session, PROJECT_ID).pipe(
    Effect.provide(Layer.mergeAll(spy.layer, projection.layer, pairing.layer, NodeServices.layer)),
  );

const runTempProjectDispatch = Effect.fn("runTempProjectDispatch")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3code-unity-pipeline-install-",
  });
  const spy = makeUnityPipelineClientSpy();
  const projection = makeProjectionSnapshotQuerySpy(makeProject(workspaceRoot));
  const session = makeSession([AuthPresenceCommandScope]);
  const pairing = makeUnityPairingHandoffSpy();
  const outcome = yield* runDispatchTest(spy, session, projection, pairing);
  return { fileSystem, outcome, pairing, projection, spy, workspaceRoot };
});

describe("dispatchUnityPipelineInstall", () => {
  it.effect("resolves the packaged desktop resource before every repo-path dev fallback", () =>
    Effect.gen(function* () {
      expect(
        yield* unitySelectionPackageSourceCandidates({
          moduleUrl:
            "file:///Applications/DevGame.app/Contents/Resources/app.asar/apps/server/dist/bin.mjs",
          cwd: "/Users/dev/t3code-fork",
        }),
      ).toEqual([
        "/Applications/DevGame.app/Contents/Resources/unity-packages/com.devgame.editor-presence",
        "/Applications/DevGame.app/Contents/Resources/unity/com.devgame.editor-presence",
        "/Applications/DevGame.app/Contents/Resources/app.asar/unity/com.devgame.editor-presence",
        "/Users/dev/t3code-fork/unity/com.devgame.editor-presence",
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "refuses a session without the dedicated presence:command scope, without ever calling UnityPipelineClient",
    () =>
      Effect.gen(function* () {
        const spy = makeUnityPipelineClientSpy();
        const projection = makeProjectionSnapshotQuerySpy(PROJECT);
        const session = makeSession([AuthOrchestrationOperateScope]);
        const outcome = yield* runDispatchTest(spy, session, projection);
        expect(outcome).toEqual({ _tag: "insufficientScope" });
        expect(spy.calls).toEqual([]);
        expect(projection.requestedProjectIds).toEqual([]);
      }),
  );

  it.effect(
    "presence:read alone does NOT satisfy presence:command — this route mutates the project, that scope doesn't authorize mutation",
    () =>
      Effect.gen(function* () {
        const spy = makeUnityPipelineClientSpy();
        const projection = makeProjectionSnapshotQuerySpy(PROJECT);
        const session = makeSession([AuthPresenceReadScope]);
        const outcome = yield* runDispatchTest(spy, session, projection);
        expect(outcome).toEqual({ _tag: "insufficientScope" });
        expect(spy.calls).toEqual([]);
        expect(projection.requestedProjectIds).toEqual([]);
      }),
  );

  it.effect(
    "known projectId resolves through the projection store and one install reports both package outcomes",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const { fileSystem, outcome, pairing, projection, spy, workspaceRoot } =
          yield* runTempProjectDispatch();
        expect(outcome._tag).toBe("ok");
        if (outcome._tag !== "ok") return;
        expect(outcome.value).toEqual({
          _tag: "ok",
          value: {
            packageId: "com.unity.pipeline",
            version: "0.4.0-exp.1",
            alreadyInstalled: false,
          },
          selectionPackage: {
            packageId: "com.devgame.editor-presence",
            version: "0.4.0",
            operation: "installed",
            legacyCleanup: { packagesDirectory: "absent", libraryDirectory: "absent" },
          },
          pairingOutcome: { _tag: "minted" },
          // No live matched Editor in this fixture (the spy's own default
          // `list()`) — task #130's liveness gate correctly never attempts
          // `packageResolve` here.
          packageResolve: "skipped_no_editor",
        });
        expect(projection.requestedProjectIds).toEqual([PROJECT_ID]);
        expect(spy.calls).toEqual([
          { method: "install", workspaceRoot },
          { method: "list", workspaceRoot },
        ]);
        expect(pairing.registeredRoots).toEqual([workspaceRoot]);
        expect(pairing.issued).toEqual([
          {
            label: "Unity selection — Deepmind",
            scopes: [AuthOrchestrationOperateScope],
            ttl: Duration.hours(24),
          },
        ]);
        expect(
          yield* fileSystem.exists(
            path.join(workspaceRoot, "Packages/com.devgame.editor-presence/package.json.meta"),
          ),
        ).toBe(true);
        const pairingFile = yield* fileSystem.readFileString(
          path.join(workspaceRoot, "Library/com.devgame.editor-presence/pairing.json"),
        );
        expect(yield* decodePairingFile(pairingFile)).toEqual({
          serverUrl: "http://127.0.0.1:3773",
          pairingCredential: "PAIRING1234",
        });
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  describe("package_resolve nudge (task #130) — the last zero-touch wire, non-fatal to the install either way", () => {
    function liveMatchedInstance(
      projectPath: string,
      overrides: Partial<UnityPipelineClient.UnityPipelineListInstance> = {},
    ): UnityPipelineClient.UnityPipelineListInstance {
      return {
        projectPath,
        pid: 111,
        isRunning: true,
        hasPipelinePackage: true,
        isReachable: true,
        pipelineVersion: "0.4.0-exp.1",
        updateAvailable: false,
        safeMode: false,
        ...overrides,
      };
    }

    it.effect(
      "a live matched RUNNING instance triggers packageResolve, cwd'd to the project — outcome reports 'invoked'",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3code-unity-pipeline-install-resolve-invoked-",
          });
          const list = (root: string) =>
            Effect.succeed({
              _tag: "ok" as const,
              value: {
                instances: [liveMatchedInstance(root)],
                latestVersion: null,
                unparseableInstanceCount: 0,
              },
            });
          const spy = makeUnityPipelineClientSpy({ list });
          const projection = makeProjectionSnapshotQuerySpy(makeProject(workspaceRoot));
          const outcome = yield* runDispatchTest(
            spy,
            makeSession([AuthPresenceCommandScope]),
            projection,
          );

          expect(outcome._tag).toBe("ok");
          if (outcome._tag !== "ok" || outcome.value._tag !== "ok") return;
          expect(outcome.value.packageResolve).toBe("invoked");
          expect(spy.calls).toEqual([
            { method: "install", workspaceRoot },
            { method: "list", workspaceRoot },
            { method: "packageResolve", workspaceRoot },
          ]);
        }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.effect("merge-gate R3: the pairing handoff prepares BEFORE packageResolve is invoked", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3code-unity-pipeline-install-order-",
        });
        // A single shared timeline across two otherwise-independent test
        // doubles (the pipeline client spy and the pairing handoff) —
        // neither spy's own call log carries a timestamp comparable to
        // the other's, so proving an ORDER fact between them needs one
        // recorder both write into.
        const order: Array<string> = [];
        const list = (root: string) =>
          Effect.succeed({
            _tag: "ok" as const,
            value: {
              instances: [liveMatchedInstance(root)],
              latestVersion: null,
              unparseableInstanceCount: 0,
            },
          });
        const packageResolve = () => {
          order.push("packageResolve");
          return Effect.succeed({ _tag: "ok" as const, value: undefined });
        };
        const spy = makeUnityPipelineClientSpy({ list, packageResolve });
        const projection = makeProjectionSnapshotQuerySpy(makeProject(workspaceRoot));
        // Deliberately NOT `makeUnityPairingHandoffSpy` — that helper's
        // own recording (`registeredRoots`/`issued`) isn't on the shared
        // `order` timeline either, so this constructs the dependency
        // directly to hook the exact moment `prepare` starts working.
        const pairingLayer = Layer.effect(
          UnityPairingHandoff.UnityPairingHandoff,
          UnityPairingHandoff.make({
            serverUrl: "http://127.0.0.1:3773",
            isAlreadyPaired: () => {
              order.push("pairing.prepare");
              return Effect.succeed(false);
            },
            issuePairingCredential: () => Effect.succeed({ credential: "PAIRING1234" }),
          }),
        ).pipe(Layer.provide(NodeServices.layer));

        const outcome = yield* dispatchUnityPipelineInstall(
          makeSession([AuthPresenceCommandScope]),
          PROJECT_ID,
        ).pipe(
          Effect.provide(
            Layer.mergeAll(spy.layer, projection.layer, pairingLayer, NodeServices.layer),
          ),
        );

        expect(outcome._tag).toBe("ok");
        if (outcome._tag !== "ok" || outcome.value._tag !== "ok") return;
        expect(outcome.value.packageResolve).toBe("invoked");
        expect(outcome.value.pairingOutcome).toEqual({ _tag: "minted" });
        expect(order).toEqual(["pairing.prepare", "packageResolve"]);
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.effect(
      "no matched instance (empty list) skips packageResolve entirely — outcome reports 'skipped_no_editor'",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3code-unity-pipeline-install-resolve-noeditor-",
          });
          // Default spy: list() reports zero instances.
          const spy = makeUnityPipelineClientSpy();
          const projection = makeProjectionSnapshotQuerySpy(makeProject(workspaceRoot));
          const outcome = yield* runDispatchTest(
            spy,
            makeSession([AuthPresenceCommandScope]),
            projection,
          );

          expect(outcome._tag).toBe("ok");
          if (outcome._tag !== "ok" || outcome.value._tag !== "ok") return;
          expect(outcome.value.packageResolve).toBe("skipped_no_editor");
          expect(spy.calls.map((call) => call.method)).toEqual(["install", "list"]);
        }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.effect(
      "a matched instance that isn't RUNNING (stale lock, F13's own scenario) is treated as no live editor — never cold-starts Unity",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3code-unity-pipeline-install-resolve-stale-",
          });
          const list = (root: string) =>
            Effect.succeed({
              _tag: "ok" as const,
              value: {
                instances: [
                  liveMatchedInstance(root, {
                    isRunning: false,
                    pid: null,
                    hasPipelinePackage: false,
                    isReachable: false,
                    pipelineVersion: null,
                    updateAvailable: null,
                    safeMode: null,
                  }),
                ],
                latestVersion: null,
                unparseableInstanceCount: 0,
              },
            });
          const spy = makeUnityPipelineClientSpy({ list });
          const projection = makeProjectionSnapshotQuerySpy(makeProject(workspaceRoot));
          const outcome = yield* runDispatchTest(
            spy,
            makeSession([AuthPresenceCommandScope]),
            projection,
          );

          expect(outcome._tag).toBe("ok");
          if (outcome._tag !== "ok" || outcome.value._tag !== "ok") return;
          expect(outcome.value.packageResolve).toBe("skipped_no_editor");
          expect(spy.calls.map((call) => call.method)).toEqual(["install", "list"]);
        }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.effect(
      "a live matched instance whose packageResolve call FAILS is reported 'failed', but never fails the install itself",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3code-unity-pipeline-install-resolve-failed-",
          });
          const list = (root: string) =>
            Effect.succeed({
              _tag: "ok" as const,
              value: {
                instances: [liveMatchedInstance(root)],
                latestVersion: null,
                unparseableInstanceCount: 0,
              },
            });
          const packageResolve = () =>
            Effect.succeed({
              _tag: "error" as const,
              message: "Cannot connect to Unity Editor Pipeline server at 127.0.0.1:7801",
            });
          const spy = makeUnityPipelineClientSpy({ list, packageResolve });
          const projection = makeProjectionSnapshotQuerySpy(makeProject(workspaceRoot));
          const outcome = yield* runDispatchTest(
            spy,
            makeSession([AuthPresenceCommandScope]),
            projection,
          );

          expect(outcome._tag).toBe("ok");
          if (outcome._tag !== "ok" || outcome.value._tag !== "ok") return;
          // The install ITSELF is still an honest success — package_resolve
          // failing is explicitly non-fatal, per this route's own doc
          // comment (mirrors the pairing-mint-failure test's own posture).
          expect(outcome.value.value.packageId).toBe("com.unity.pipeline");
          expect(outcome.value.selectionPackage.operation).toBe("installed");
          expect(outcome.value.packageResolve).toBe("failed");
        }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.effect(
      "list() itself failing (CLI error) is treated as 'no confirmed live editor', not a guess — skips packageResolve",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3code-unity-pipeline-install-resolve-listfail-",
          });
          const list = () =>
            Effect.succeed({ _tag: "error" as const, message: "unity CLI vanished mid-call" });
          const spy = makeUnityPipelineClientSpy({ list });
          const projection = makeProjectionSnapshotQuerySpy(makeProject(workspaceRoot));
          const outcome = yield* runDispatchTest(
            spy,
            makeSession([AuthPresenceCommandScope]),
            projection,
          );

          expect(outcome._tag).toBe("ok");
          if (outcome._tag !== "ok" || outcome.value._tag !== "ok") return;
          expect(outcome.value.packageResolve).toBe("skipped_no_editor");
          expect(spy.calls.map((call) => call.method)).toEqual(["install", "list"]);
        }).pipe(Effect.provide(NodeServices.layer)),
    );

    // Round-18 observability gap: this route's own packageResolve outcome
    // was completely invisible in server logs — no span, no log line for
    // "invoked" or "skipped_no_editor" at all (only "failed" had one) — so
    // round-18's forensics could not tell whether the nudge ran, was
    // skipped, or failed; only Editor.log's OWN timestamps, read minutes
    // later, hinted the import started late. Captured-logger pattern (this
    // file's own merge-gate R1 tests, above) — a branch-result assertion
    // alone would pass even with the log call deleted entirely, so each
    // test here pins something the log call SPECIFICALLY carries, not just
    // "some log exists."
    describe("round-18: the packageResolve outcome is now logged (was previously invisible)", () => {
      function captureLogger(): {
        readonly messages: Array<unknown>;
        readonly layer: Layer.Layer<never>;
      } {
        const messages: Array<unknown> = [];
        const logger = Logger.make<unknown, void>((options) => {
          if (Array.isArray(options.message)) {
            messages.push(...options.message);
          } else {
            messages.push(options.message);
          }
        });
        return { messages, layer: Logger.layer([logger], { mergeWithExisting: false }) };
      }

      function findPackageResolveLog(
        messages: ReadonlyArray<unknown>,
      ): Record<string, unknown> | undefined {
        return messages.find(
          (message): message is Record<string, unknown> =>
            typeof message === "object" && message !== null && "packageResolve" in message,
        );
      }

      it.effect("logs 'invoked' for a live matched RUNNING instance", () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3code-unity-pipeline-install-resolve-log-invoked-",
          });
          const list = (root: string) =>
            Effect.succeed({
              _tag: "ok" as const,
              value: {
                instances: [liveMatchedInstance(root)],
                latestVersion: null,
                unparseableInstanceCount: 0,
              },
            });
          const spy = makeUnityPipelineClientSpy({ list });
          const projection = makeProjectionSnapshotQuerySpy(makeProject(workspaceRoot));
          const { messages, layer } = captureLogger();

          yield* runDispatchTest(spy, makeSession([AuthPresenceCommandScope]), projection).pipe(
            Effect.provide(layer),
          );

          const log = findPackageResolveLog(messages);
          expect(log).toBeDefined();
          expect(log?.packageResolve).toBe("invoked");
          expect(log?.skipReason).toBeUndefined();
        }).pipe(Effect.provide(NodeServices.layer)),
      );

      it.effect(
        "logs 'skipped_no_editor' with a DISTINCT reason for 'no matched instance' vs 'matched but not running'",
        () =>
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem;

            const noMatchWorkspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
              prefix: "t3code-unity-pipeline-install-resolve-log-nomatch-",
            });
            const noMatchSpy = makeUnityPipelineClientSpy(); // default: empty instances
            const noMatchProjection = makeProjectionSnapshotQuerySpy(
              makeProject(noMatchWorkspaceRoot),
            );
            const noMatchCapture = captureLogger();
            yield* runDispatchTest(
              noMatchSpy,
              makeSession([AuthPresenceCommandScope]),
              noMatchProjection,
            ).pipe(Effect.provide(noMatchCapture.layer));
            const noMatchLog = findPackageResolveLog(noMatchCapture.messages);

            const staleWorkspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
              prefix: "t3code-unity-pipeline-install-resolve-log-stale-",
            });
            const staleList = (root: string) =>
              Effect.succeed({
                _tag: "ok" as const,
                value: {
                  instances: [liveMatchedInstance(root, { isRunning: false, pid: null })],
                  latestVersion: null,
                  unparseableInstanceCount: 0,
                },
              });
            const staleSpy = makeUnityPipelineClientSpy({ list: staleList });
            const staleProjection = makeProjectionSnapshotQuerySpy(makeProject(staleWorkspaceRoot));
            const staleCapture = captureLogger();
            yield* runDispatchTest(
              staleSpy,
              makeSession([AuthPresenceCommandScope]),
              staleProjection,
            ).pipe(Effect.provide(staleCapture.layer));
            const staleLog = findPackageResolveLog(staleCapture.messages);

            expect(noMatchLog).toBeDefined();
            expect(staleLog).toBeDefined();
            expect(noMatchLog?.packageResolve).toBe("skipped_no_editor");
            expect(staleLog?.packageResolve).toBe("skipped_no_editor");
            expect(typeof noMatchLog?.skipReason).toBe("string");
            expect(typeof staleLog?.skipReason).toBe("string");
            // The load-bearing assertion: these two skip reasons must be
            // genuinely DIFFERENT strings, not the same generic "skipped"
            // filler — a vacuous implementation (log the tag alone, no real
            // reason) would pass every assertion above this one.
            expect(noMatchLog?.skipReason).not.toBe(staleLog?.skipReason);
          }).pipe(Effect.provide(NodeServices.layer)),
      );

      it.effect(
        "logs 'failed' with the underlying outcome when a live editor's resolve call itself fails",
        () =>
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem;
            const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
              prefix: "t3code-unity-pipeline-install-resolve-log-failed-",
            });
            const list = (root: string) =>
              Effect.succeed({
                _tag: "ok" as const,
                value: {
                  instances: [liveMatchedInstance(root)],
                  latestVersion: null,
                  unparseableInstanceCount: 0,
                },
              });
            const packageResolve = () =>
              Effect.succeed({
                _tag: "error" as const,
                message: "Cannot connect to Unity Editor Pipeline server at 127.0.0.1:7801",
              });
            const spy = makeUnityPipelineClientSpy({ list, packageResolve });
            const projection = makeProjectionSnapshotQuerySpy(makeProject(workspaceRoot));
            const { messages, layer } = captureLogger();

            yield* runDispatchTest(spy, makeSession([AuthPresenceCommandScope]), projection).pipe(
              Effect.provide(layer),
            );

            const log = findPackageResolveLog(messages);
            expect(log).toBeDefined();
            expect(log?.packageResolve).toBe("failed");
          }).pipe(Effect.provide(NodeServices.layer)),
      );
    });
  });

  it.effect("caps the project-title portion of the minted credential label", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-unity-pairing-label-",
      });
      const longTitle = "A".repeat(80);
      const spy = makeUnityPipelineClientSpy();
      const projection = makeProjectionSnapshotQuerySpy(makeProject(workspaceRoot, longTitle));
      const pairing = makeUnityPairingHandoffSpy();

      yield* runDispatchTest(spy, makeSession([AuthPresenceCommandScope]), projection, pairing);

      expect(pairing.issued[0]?.label).toBe(`Unity selection — ${"A".repeat(63)}…`);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("restricts the handoff directory and file to the local user", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { fileSystem, workspaceRoot } = yield* runTempProjectDispatch();
      const pairingDirectory = path.join(workspaceRoot, "Library/com.devgame.editor-presence");

      expect((yield* fileSystem.stat(pairingDirectory)).mode & 0o777).toBe(0o700);
      expect(
        (yield* fileSystem.stat(path.join(pairingDirectory, "pairing.json"))).mode & 0o777,
      ).toBe(0o600);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("publishes the completed handoff with a temp-file rename", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-unity-pairing-atomic-",
      });
      const renameCalls: Array<{ readonly from: string; readonly to: string }> = [];
      const recordingFileSystem: FileSystem.FileSystem = {
        ...fileSystem,
        rename: (from, to) =>
          Effect.sync(() => renameCalls.push({ from, to })).pipe(
            Effect.andThen(fileSystem.rename(from, to)),
          ),
      };
      const handoff = yield* UnityPairingHandoff.make({
        serverUrl: "http://127.0.0.1:3773",
        isAlreadyPaired: () => Effect.succeed(false),
        issuePairingCredential: () => Effect.succeed({ credential: "PAIRING1234" }),
      }).pipe(Effect.provideService(FileSystem.FileSystem, recordingFileSystem));
      const outcome = yield* handoff.prepare({
        workspaceRoot,
        projectTitle: "Deepmind",
        forceMint: false,
      });
      const pairingPath = path.join(
        workspaceRoot,
        "Library/com.devgame.editor-presence/pairing.json",
      );

      expect(outcome).toEqual({ _tag: "minted" });
      expect(renameCalls).toHaveLength(1);
      expect(renameCalls[0]?.to).toBe(pairingPath);
      expect(renameCalls[0]?.from).not.toBe(pairingPath);
      expect(yield* fileSystem.readDirectory(path.dirname(pairingPath))).toEqual(["pairing.json"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  // Round-18 live finding (2026-08-11, evidence/qa-round18/REPORT.md + server
  // trace): the S14 upgrade CTA rendered and the click ran —
  // `installUnityEmbeddedSelectionPackage` succeeded, legacy swept from disk
  // — then `prepare`'s `alreadyPaired` early-exit fired because a publisher
  // WAS registered: the LEGACY package's own, the very one this same call
  // just swept. No credential was minted, no pairing.json written. On
  // Unity's next reload, that legacy publisher died with its package, the
  // new package loaded with nothing to redeem, and the project ended up
  // unpaired (CTA back, S10) — the one-click migration promise broken for
  // exactly the legacy population it exists to serve.
  describe("round-18: forceMint bypasses a stale alreadyPaired read after a legacy sweep", () => {
    it.effect(
      "a REGISTERED publisher mints anyway when forceMint is true — the alreadyPaired early-exit is bypassed",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3code-unity-pairing-force-mint-",
          });
          let issueCallCount = 0;
          const handoff = yield* UnityPairingHandoff.make({
            serverUrl: "http://127.0.0.1:3773",
            isAlreadyPaired: () => Effect.succeed(true),
            issuePairingCredential: () => {
              issueCallCount += 1;
              return Effect.succeed({ credential: "PAIRING1234" });
            },
          });
          const outcome = yield* handoff.prepare({
            workspaceRoot,
            projectTitle: "Deepmind",
            forceMint: true,
          });

          expect(outcome).toEqual({ _tag: "minted" });
          expect(issueCallCount).toBe(1);
          const pairingPath = path.join(
            workspaceRoot,
            "Library/com.devgame.editor-presence/pairing.json",
          );
          expect(yield* fileSystem.exists(pairingPath)).toBe(true);
        }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.effect(
      "WITHOUT forceMint, a registered publisher still short-circuits exactly as before — the healthy-paired-project direction stays correct",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3code-unity-pairing-no-force-mint-",
          });
          let issueCallCount = 0;
          const handoff = yield* UnityPairingHandoff.make({
            serverUrl: "http://127.0.0.1:3773",
            isAlreadyPaired: () => Effect.succeed(true),
            issuePairingCredential: () => {
              issueCallCount += 1;
              return Effect.succeed({ credential: "PAIRING1234" });
            },
          });
          const outcome = yield* handoff.prepare({
            workspaceRoot,
            projectTitle: "Deepmind",
            forceMint: false,
          });

          expect(outcome).toEqual({ _tag: "alreadyPaired" });
          expect(issueCallCount).toBe(0);
        }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.effect(
      "the ROUTE forces the mint when the legacy sweep actually removed something this same call — the exact live repro",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3code-unity-pipeline-install-legacy-repair-",
          });
          const legacyPackagesDirectory = path.join(
            workspaceRoot,
            "Packages",
            LEGACY_UNITY_SELECTION_PACKAGE_ID,
          );
          yield* fileSystem.makeDirectory(legacyPackagesDirectory, { recursive: true });
          yield* fileSystem.writeFileString(
            path.join(legacyPackagesDirectory, "package.json"),
            encodeJson({ name: LEGACY_UNITY_SELECTION_PACKAGE_ID, version: "0.3.1" }),
          );

          const spy = makeUnityPipelineClientSpy();
          const projection = makeProjectionSnapshotQuerySpy(makeProject(workspaceRoot));
          // The publisher registered here IS the legacy package's own —
          // `isAlreadyPaired` reading `true` is exactly round-18's live
          // symptom, not a fixture mistake.
          const pairing = makeUnityPairingHandoffSpy({ alreadyPaired: true });
          const outcome = yield* runDispatchTest(
            spy,
            makeSession([AuthPresenceCommandScope]),
            projection,
            pairing,
          );

          expect(outcome._tag).toBe("ok");
          if (outcome._tag !== "ok" || outcome.value._tag !== "ok") return;
          expect(outcome.value.selectionPackage.legacyCleanup).toEqual({
            packagesDirectory: "removed",
            libraryDirectory: "absent",
          });
          // The bug: this used to be `{ _tag: "alreadyPaired" }` with NO
          // pairing.json ever written.
          expect(outcome.value.pairingOutcome).toEqual({ _tag: "minted" });
          expect(pairing.issued).toHaveLength(1);
          const pairingFile = yield* fileSystem.readFileString(
            path.join(workspaceRoot, "Library/com.devgame.editor-presence/pairing.json"),
          );
          expect(yield* decodePairingFile(pairingFile)).toEqual({
            serverUrl: "http://127.0.0.1:3773",
            pairingCredential: "PAIRING1234",
          });
        }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.effect(
      "the ROUTE also forces the mint when only the stranded Library legacy directory was swept — libraryDirectory 'removed' alone counts too, not just packagesDirectory",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3code-unity-pipeline-install-legacy-library-repair-",
          });
          const legacyLibraryDirectory = path.join(
            workspaceRoot,
            "Library",
            LEGACY_UNITY_SELECTION_PACKAGE_ID,
          );
          yield* fileSystem.makeDirectory(legacyLibraryDirectory, { recursive: true });
          yield* fileSystem.writeFileString(
            path.join(legacyLibraryDirectory, "pairing.json"),
            "stale",
          );

          const spy = makeUnityPipelineClientSpy();
          const projection = makeProjectionSnapshotQuerySpy(makeProject(workspaceRoot));
          const pairing = makeUnityPairingHandoffSpy({ alreadyPaired: true });
          const outcome = yield* runDispatchTest(
            spy,
            makeSession([AuthPresenceCommandScope]),
            projection,
            pairing,
          );

          expect(outcome._tag).toBe("ok");
          if (outcome._tag !== "ok" || outcome.value._tag !== "ok") return;
          expect(outcome.value.selectionPackage.legacyCleanup).toEqual({
            packagesDirectory: "absent",
            libraryDirectory: "removed",
          });
          expect(outcome.value.pairingOutcome).toEqual({ _tag: "minted" });
        }).pipe(Effect.provide(NodeServices.layer)),
    );
  });

  it.effect("same selection-package version is a no-op success", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-unity-pipeline-install-same-",
      });
      const destination = path.join(workspaceRoot, "Packages/com.devgame.editor-presence");
      yield* fileSystem.makeDirectory(destination, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(destination, "package.json"),
        // Must match the embedded SOURCE package's real on-disk version
        // (unity/com.devgame.editor-presence/package.json, currently
        // 0.4.0) — this test's whole premise is "destination already at the
        // same version as source," so this fixture has to track that
        // version, not a hardcoded historical one, or it silently starts
        // testing the "replaced" path instead of "alreadyInstalled".
        encodeJson({ name: "com.devgame.editor-presence", version: "0.4.0" }),
      );
      yield* fileSystem.writeFileString(path.join(destination, "keep-on-no-op.txt"), "sentinel");

      const spy = makeUnityPipelineClientSpy();
      const projection = makeProjectionSnapshotQuerySpy(makeProject(workspaceRoot));
      const outcome = yield* runDispatchTest(
        spy,
        makeSession([AuthPresenceCommandScope]),
        projection,
      );

      expect(outcome._tag).toBe("ok");
      if (outcome._tag !== "ok" || outcome.value._tag !== "ok") return;
      expect(outcome.value.selectionPackage).toEqual({
        packageId: "com.devgame.editor-presence",
        version: "0.4.0",
        operation: "alreadyInstalled",
        legacyCleanup: { packagesDirectory: "absent", libraryDirectory: "absent" },
      });
      expect(yield* fileSystem.exists(path.join(destination, "keep-on-no-op.txt"))).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("different selection-package version replaces the destination directory whole", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-unity-pipeline-install-replace-",
      });
      const destination = path.join(workspaceRoot, "Packages/com.devgame.editor-presence");
      yield* fileSystem.makeDirectory(destination, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(destination, "package.json"),
        encodeJson({ name: "com.devgame.editor-presence", version: "0.1.0" }),
      );
      yield* fileSystem.writeFileString(path.join(destination, "stale.txt"), "remove me");

      const spy = makeUnityPipelineClientSpy();
      const projection = makeProjectionSnapshotQuerySpy(makeProject(workspaceRoot));
      const outcome = yield* runDispatchTest(
        spy,
        makeSession([AuthPresenceCommandScope]),
        projection,
      );

      expect(outcome._tag).toBe("ok");
      if (outcome._tag !== "ok" || outcome.value._tag !== "ok") return;
      expect(outcome.value.selectionPackage).toEqual({
        packageId: "com.devgame.editor-presence",
        version: "0.4.0",
        operation: "replaced",
        legacyCleanup: { packagesDirectory: "absent", libraryDirectory: "absent" },
      });
      expect(yield* fileSystem.exists(path.join(destination, "stale.txt"))).toBe(false);
      expect(yield* fileSystem.exists(path.join(destination, "package.json.meta"))).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  describe("legacy (com.ironmind.editor-presence) cleanup migration", () => {
    it.effect("sweeps a stranded legacy Packages directory and reports it removed", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3code-unity-pipeline-install-legacy-packages-",
        });
        const legacyPackagesDirectory = path.join(
          workspaceRoot,
          "Packages",
          LEGACY_UNITY_SELECTION_PACKAGE_ID,
        );
        yield* fileSystem.makeDirectory(legacyPackagesDirectory, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(legacyPackagesDirectory, "package.json"),
          encodeJson({ name: LEGACY_UNITY_SELECTION_PACKAGE_ID, version: "0.3.1" }),
        );

        const spy = makeUnityPipelineClientSpy();
        const projection = makeProjectionSnapshotQuerySpy(makeProject(workspaceRoot));
        const outcome = yield* runDispatchTest(
          spy,
          makeSession([AuthPresenceCommandScope]),
          projection,
        );

        expect(outcome._tag).toBe("ok");
        if (outcome._tag !== "ok" || outcome.value._tag !== "ok") return;
        expect(outcome.value.selectionPackage.legacyCleanup).toEqual({
          packagesDirectory: "removed",
          libraryDirectory: "absent",
        });
        expect(yield* fileSystem.exists(legacyPackagesDirectory)).toBe(false);
        // The new-id package still lands correctly alongside the sweep — the
        // migration must never trade "legacy gone" for "new package missing".
        expect(
          yield* fileSystem.exists(
            path.join(workspaceRoot, "Packages", UNITY_SELECTION_PACKAGE_ID, "package.json"),
          ),
        ).toBe(true);
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.effect("sweeps a stranded legacy Library pairing directory and reports it removed", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3code-unity-pipeline-install-legacy-library-",
        });
        // Same fixture shape this file already uses for the CURRENT-id
        // pairing handoff (see "a stale unredeemed pairing.json..." above),
        // repurposed at the LEGACY id to simulate a pre-rename stranded
        // pairing directory a project picked up before 2026-08-11.
        const legacyLibraryDirectory = path.join(
          workspaceRoot,
          "Library",
          LEGACY_UNITY_SELECTION_PACKAGE_ID,
        );
        yield* fileSystem.makeDirectory(legacyLibraryDirectory, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(legacyLibraryDirectory, "pairing.json"),
          encodeJson({ serverUrl: "http://127.0.0.1:3773", pairingCredential: "STRANDED0000" }),
        );

        const spy = makeUnityPipelineClientSpy();
        const projection = makeProjectionSnapshotQuerySpy(makeProject(workspaceRoot));
        const outcome = yield* runDispatchTest(
          spy,
          makeSession([AuthPresenceCommandScope]),
          projection,
        );

        expect(outcome._tag).toBe("ok");
        if (outcome._tag !== "ok" || outcome.value._tag !== "ok") return;
        expect(outcome.value.selectionPackage.legacyCleanup).toEqual({
          packagesDirectory: "absent",
          libraryDirectory: "removed",
        });
        expect(yield* fileSystem.exists(legacyLibraryDirectory)).toBe(false);
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.effect(
      "a legacy directory the process cannot delete is reported failed, but never fails the install",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3code-unity-pipeline-install-legacy-undeletable-",
          });
          const legacyPackagesDirectory = path.join(
            workspaceRoot,
            "Packages",
            LEGACY_UNITY_SELECTION_PACKAGE_ID,
          );
          yield* fileSystem.makeDirectory(legacyPackagesDirectory, { recursive: true });
          yield* fileSystem.writeFileString(
            path.join(legacyPackagesDirectory, "package.json"),
            encodeJson({ name: LEGACY_UNITY_SELECTION_PACKAGE_ID, version: "0.3.1" }),
          );
          const undeletableFileSystem: FileSystem.FileSystem = {
            ...fileSystem,
            remove: (removePath, options) =>
              removePath === legacyPackagesDirectory
                ? Effect.fail(
                    PlatformError.systemError({
                      _tag: "PermissionDenied",
                      module: "FileSystem",
                      method: "remove",
                      pathOrDescriptor: removePath,
                    }),
                  )
                : fileSystem.remove(removePath, options),
          };

          // Calling the install function directly (bypassing the full HTTP
          // dispatch) is the only way to inject a FileSystem override for
          // just this one path while every other operation — including the
          // REAL source-package copy — still runs for real.
          const outcome = yield* installUnityEmbeddedSelectionPackage(workspaceRoot).pipe(
            Effect.provideService(FileSystem.FileSystem, undeletableFileSystem),
          );

          expect(outcome.operation).toBe("installed");
          expect(outcome.legacyCleanup).toEqual({
            packagesDirectory: "failed",
            libraryDirectory: "absent",
          });
          // Left in place, not silently lost — the whole point of "failed"
          // over "removed" is that a human can still find and clear it.
          expect(yield* fileSystem.exists(legacyPackagesDirectory)).toBe(true);
        }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.effect(
      "merge-gate R1 (three-way ruling): a probe error whose fallback remove SUCCEEDS reports removed",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3code-unity-pipeline-install-legacy-exists-fails-removes-",
          });
          const legacyLibraryDirectory = path.join(
            workspaceRoot,
            "Library",
            LEGACY_UNITY_SELECTION_PACKAGE_ID,
          );
          // A REAL legacy directory, so that once the probe error falls
          // through to the same attempt-and-decide `remove` the confirmed-
          // present branch uses, there is genuinely something there for it
          // to remove — `remove` itself is NOT stubbed here.
          yield* fileSystem.makeDirectory(legacyLibraryDirectory, { recursive: true });
          yield* fileSystem.writeFileString(
            path.join(legacyLibraryDirectory, "pairing.json"),
            "stale",
          );
          const flakyExistsFileSystem: FileSystem.FileSystem = {
            ...fileSystem,
            exists: (existsPath) =>
              existsPath === legacyLibraryDirectory
                ? Effect.fail(
                    PlatformError.systemError({
                      _tag: "PermissionDenied",
                      module: "FileSystem",
                      method: "access",
                      pathOrDescriptor: existsPath,
                    }),
                  )
                : fileSystem.exists(existsPath),
          };

          // Calling the install function directly (bypassing the full HTTP
          // dispatch) is the only way to inject a FileSystem override for
          // just this one path while every other operation — including the
          // REAL source-package copy — still runs for real.
          const outcome = yield* installUnityEmbeddedSelectionPackage(workspaceRoot).pipe(
            Effect.provideService(FileSystem.FileSystem, flakyExistsFileSystem),
          );

          expect(outcome.operation).toBe("installed");
          // The reviewer's ruling: a probe error is NOT "failed" on its
          // own — it falls through to a real remove attempt. That attempt
          // genuinely succeeded (the directory really was there), which is
          // a real mutation of the user's project and must surface as
          // "removed" so the install report's "removed the old package"
          // line actually fires.
          expect(outcome.legacyCleanup).toEqual({
            packagesDirectory: "absent",
            libraryDirectory: "removed",
          });
          expect(yield* fileSystem.exists(legacyLibraryDirectory)).toBe(false);
        }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.effect(
      "merge-gate R1 (three-way ruling): a probe error over a PRESENT, UNREMOVABLE directory reports failed, and the cause is actually logged (not silently swallowed)",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3code-unity-pipeline-install-legacy-exists-fails-remove-fails-",
          });
          const legacyLibraryDirectory = path.join(
            workspaceRoot,
            "Library",
            LEGACY_UNITY_SELECTION_PACKAGE_ID,
          );
          yield* fileSystem.makeDirectory(legacyLibraryDirectory, { recursive: true });
          yield* fileSystem.writeFileString(
            path.join(legacyLibraryDirectory, "pairing.json"),
            "stale",
          );
          const undeletableFlakyFileSystem: FileSystem.FileSystem = {
            ...fileSystem,
            exists: (existsPath) =>
              existsPath === legacyLibraryDirectory
                ? Effect.fail(
                    PlatformError.systemError({
                      _tag: "PermissionDenied",
                      module: "FileSystem",
                      method: "access",
                      pathOrDescriptor: existsPath,
                    }),
                  )
                : fileSystem.exists(existsPath),
            remove: (removePath, options) =>
              removePath === legacyLibraryDirectory
                ? Effect.fail(
                    PlatformError.systemError({
                      _tag: "PermissionDenied",
                      module: "FileSystem",
                      method: "remove",
                      pathOrDescriptor: removePath,
                    }),
                  )
                : fileSystem.remove(removePath, options),
          };

          // Captured-logger pattern — auth/http.test.ts precedent. A
          // branch-result assertion alone passes even with the log call
          // deleted; this repo has proven that exact mutation. This test
          // red-proves the LOGGING assertion specifically, not just the
          // outcome string.
          const messages: Array<unknown> = [];
          const logger = Logger.make<unknown, void>((options) => {
            if (Array.isArray(options.message)) {
              messages.push(...options.message);
            } else {
              messages.push(options.message);
            }
          });

          const outcome = yield* installUnityEmbeddedSelectionPackage(workspaceRoot).pipe(
            Effect.provideService(FileSystem.FileSystem, undeletableFlakyFileSystem),
            Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
          );

          expect(outcome.operation).toBe("installed");
          // Neither the probe nor the fallback remove could confirm or
          // clear this directory — "failed" is what lets a human find and
          // clear it, per the ruling. NEVER "absent" from this branch: it
          // is the one branch entered precisely because absence could not
          // be established.
          expect(outcome.legacyCleanup).toEqual({
            packagesDirectory: "absent",
            libraryDirectory: "failed",
          });
          // Left in place, not silently lost.
          expect(yield* fileSystem.exists(legacyLibraryDirectory)).toBe(true);

          // NOT a bare `"cause" in message` search: the exists PROBE's own
          // failure is ALSO logged with a `{cause, directory}` shape (same
          // directory, unchanged, upstream of this branch) — a generic
          // search matches THAT log too and stays green even with the
          // remove-failure's own log call deleted entirely. Distinguish by
          // the underlying `PlatformError`'s `method`: "access" is the
          // probe, "remove" is what this test is actually about.
          const removeFailureLog = messages.find(
            (message): message is Record<string, unknown> =>
              typeof message === "object" &&
              message !== null &&
              "cause" in message &&
              (message as { cause?: { reason?: { method?: unknown } } }).cause?.reason?.method ===
                "remove",
          );
          expect(removeFailureLog).toBeDefined();
          expect(removeFailureLog?.directory).toBe(legacyLibraryDirectory);
        }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.effect(
      "merge-gate R1 (three-way ruling): a probe error over a directory that was never there reports failed, distinguishably logged",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3code-unity-pipeline-install-legacy-exists-fails-nothing-there-",
          });
          const legacyLibraryDirectory = path.join(
            workspaceRoot,
            "Library",
            LEGACY_UNITY_SELECTION_PACKAGE_ID,
          );
          // Deliberately NOT creating this directory — the probe errors,
          // but nothing is genuinely there for the fallback
          // `remove(..., force: false)` to find either. Only `exists` is
          // stubbed; `remove` runs for real and hits a real ENOENT.
          const flakyExistsNothingThereFileSystem: FileSystem.FileSystem = {
            ...fileSystem,
            exists: (existsPath) =>
              existsPath === legacyLibraryDirectory
                ? Effect.fail(
                    PlatformError.systemError({
                      _tag: "PermissionDenied",
                      module: "FileSystem",
                      method: "access",
                      pathOrDescriptor: existsPath,
                    }),
                  )
                : fileSystem.exists(existsPath),
          };
          const messages: Array<unknown> = [];
          const logger = Logger.make<unknown, void>((options) => {
            if (Array.isArray(options.message)) {
              messages.push(...options.message);
            } else {
              messages.push(options.message);
            }
          });

          const outcome = yield* installUnityEmbeddedSelectionPackage(workspaceRoot).pipe(
            Effect.provideService(FileSystem.FileSystem, flakyExistsNothingThereFileSystem),
            Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
          );

          expect(outcome.operation).toBe("installed");
          // Conflicting signals (the probe couldn't confirm, the fallback
          // remove found nothing) resolve to "failed", NEVER "absent" —
          // this branch is entered precisely because absence could not be
          // established on the probe's own say-so.
          expect(outcome.legacyCleanup).toEqual({
            packagesDirectory: "absent",
            libraryDirectory: "failed",
          });

          const loggedTexts = messages.filter((message): message is string => {
            return typeof message === "string";
          });
          expect(loggedTexts.some((text) => text.includes("turned out to be absent"))).toBe(true);
          // Distinguishable from a REAL deletion failure's message — nobody
          // reading this log should go looking for a directory that was
          // never there.
          expect(
            loggedTexts.some((text) => text.includes("legacy cleanup failed after a probe error")),
          ).toBe(false);
        }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.effect(
      "a DANGLING legacy symlink (exists() follows links -> false) is still unlinked, reported absent",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3code-unity-pipeline-install-legacy-dangling-symlink-",
          });
          const legacyPackagesDirectory = path.join(
            workspaceRoot,
            "Packages",
            LEGACY_UNITY_SELECTION_PACKAGE_ID,
          );
          yield* fileSystem.makeDirectory(path.dirname(legacyPackagesDirectory), {
            recursive: true,
          });
          // Points at a target that is never created — `exists` follows
          // symlinks (`access` semantics), so it resolves ENOENT on the
          // MISSING TARGET and reports `false`, even though the link itself
          // is a real, removable directory entry. Merge-gate R2.
          yield* fileSystem.symlink(
            path.join(workspaceRoot, "nonexistent-legacy-target"),
            legacyPackagesDirectory,
          );

          const outcome = yield* installUnityEmbeddedSelectionPackage(workspaceRoot);

          expect(outcome.legacyCleanup.packagesDirectory).toBe("absent");
          // The link itself — not a "real" directory, so `exists` on the
          // link path with `{ symlinks: false }`-equivalent semantics isn't
          // available here; `lstat`-free confirmation is the practical one:
          // readDirectory on the parent no longer lists the stale entry.
          expect(yield* fileSystem.readDirectory(path.dirname(legacyPackagesDirectory))).toEqual([
            UNITY_SELECTION_PACKAGE_ID,
          ]);
        }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.effect(
      "merge-gate R8: a step-1 pipeline install failure returns early — the legacy sweep never runs",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3code-unity-pipeline-install-step1-failure-",
          });
          const legacyPackagesDirectory = path.join(
            workspaceRoot,
            "Packages",
            LEGACY_UNITY_SELECTION_PACKAGE_ID,
          );
          const legacyLibraryDirectory = path.join(
            workspaceRoot,
            "Library",
            LEGACY_UNITY_SELECTION_PACKAGE_ID,
          );
          yield* fileSystem.makeDirectory(legacyPackagesDirectory, { recursive: true });
          yield* fileSystem.writeFileString(
            path.join(legacyPackagesDirectory, "package.json"),
            encodeJson({ name: LEGACY_UNITY_SELECTION_PACKAGE_ID, version: "0.3.1" }),
          );
          yield* fileSystem.makeDirectory(legacyLibraryDirectory, { recursive: true });
          yield* fileSystem.writeFileString(
            path.join(legacyLibraryDirectory, "pairing.json"),
            "stale",
          );

          // Only the ONE fixture directory contents actually matter for this
          // test's claim ("no remove calls happened"); a recording FileSystem
          // makes that claim direct instead of inferring it from survival.
          const removeCalls: Array<string> = [];
          const recordingFileSystem: FileSystem.FileSystem = {
            ...fileSystem,
            remove: (removePath, opts) => {
              removeCalls.push(removePath);
              return fileSystem.remove(removePath, opts);
            },
          };

          const spy = makeUnityPipelineClientSpy({
            install: () =>
              Effect.succeed({ _tag: "error" as const, message: "Not a Unity project" }),
          });
          const projection = makeProjectionSnapshotQuerySpy(makeProject(workspaceRoot));
          const pairing = makeUnityPairingHandoffSpy();
          const session = makeSession([AuthPresenceCommandScope]);

          const outcome = yield* dispatchUnityPipelineInstall(session, PROJECT_ID).pipe(
            Effect.provideService(FileSystem.FileSystem, recordingFileSystem),
            Effect.provide(
              Layer.mergeAll(spy.layer, projection.layer, pairing.layer, NodeServices.layer),
            ),
          );

          expect(outcome).toEqual({
            _tag: "ok",
            value: { _tag: "error", message: "Not a Unity project" },
          });
          expect(spy.calls).toEqual([{ method: "install", workspaceRoot }]);
          // The load-bearing proof: NOT "the fixtures still exist" (which a
          // no-op cleanup and a cleanup that ran-but-failed both look like),
          // but that `remove` was never even CALLED.
          expect(removeCalls).toEqual([]);
          expect(yield* fileSystem.exists(legacyPackagesDirectory)).toBe(true);
          expect(yield* fileSystem.exists(legacyLibraryDirectory)).toBe(true);
        }).pipe(Effect.provide(NodeServices.layer)),
    );
  });

  // The "no legacy present" direction of the round-18 fix above: a healthy
  // paired project (no legacy directory on disk at all, so
  // `legacyCleanup` reads all-"absent" and the route never sets
  // `forceMint`) must keep this exact quiet behavior — the fix only
  // changes what happens WHEN a legacy sweep actually occurred.
  it.effect("an already-registered selection publisher skips minting entirely", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-unity-pipeline-install-paired-",
      });
      const spy = makeUnityPipelineClientSpy();
      const projection = makeProjectionSnapshotQuerySpy(makeProject(workspaceRoot));
      const pairing = makeUnityPairingHandoffSpy({ alreadyPaired: true });
      const outcome = yield* runDispatchTest(
        spy,
        makeSession([AuthPresenceCommandScope]),
        projection,
        pairing,
      );

      expect(outcome._tag).toBe("ok");
      if (outcome._tag !== "ok" || outcome.value._tag !== "ok") return;
      expect(outcome.value.pairingOutcome).toEqual({ _tag: "alreadyPaired" });
      expect(pairing.registeredRoots).toEqual([workspaceRoot]);
      expect(pairing.issued).toEqual([]);
      expect(
        yield* fileSystem.exists(
          path.join(workspaceRoot, "Library/com.devgame.editor-presence/pairing.json"),
        ),
      ).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("an unwritable Library path reports pairing as a typed partial failure", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-unity-pipeline-install-unwritable-",
      });
      yield* fileSystem.writeFileString(path.join(workspaceRoot, "Library"), "not a directory");
      const spy = makeUnityPipelineClientSpy();
      const projection = makeProjectionSnapshotQuerySpy(makeProject(workspaceRoot));
      const pairing = makeUnityPairingHandoffSpy();
      const outcome = yield* runDispatchTest(
        spy,
        makeSession([AuthPresenceCommandScope]),
        projection,
        pairing,
      );

      expect(outcome._tag).toBe("ok");
      if (outcome._tag !== "ok" || outcome.value._tag !== "ok") return;
      expect(outcome.value.value.packageId).toBe("com.unity.pipeline");
      expect(outcome.value.selectionPackage).toMatchObject({
        packageId: "com.devgame.editor-presence",
        version: "0.4.0",
      });
      expect(outcome.value.pairingOutcome).toEqual({
        _tag: "skipped",
        reason: "Pairing credential was minted, but the Unity handoff file could not be written.",
      });
      expect(pairing.issued).toHaveLength(1);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("a stale unredeemed pairing.json is replaced with a freshly minted credential", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-unity-pipeline-install-stale-pairing-",
      });
      const pairingPath = path.join(
        workspaceRoot,
        "Library/com.devgame.editor-presence/pairing.json",
      );
      yield* fileSystem.makeDirectory(path.dirname(pairingPath), { recursive: true });
      yield* fileSystem.writeFileString(
        pairingPath,
        encodeJson({
          serverUrl: "http://stale.invalid",
          pairingCredential: "EXPIRED00000",
        }),
      );
      const spy = makeUnityPipelineClientSpy();
      const projection = makeProjectionSnapshotQuerySpy(makeProject(workspaceRoot));
      const pairing = makeUnityPairingHandoffSpy();
      const outcome = yield* runDispatchTest(
        spy,
        makeSession([AuthPresenceCommandScope]),
        projection,
        pairing,
      );

      expect(outcome._tag).toBe("ok");
      if (outcome._tag !== "ok" || outcome.value._tag !== "ok") return;
      expect(outcome.value.pairingOutcome).toEqual({ _tag: "minted" });
      expect(yield* decodePairingFile(yield* fileSystem.readFileString(pairingPath))).toEqual({
        serverUrl: "http://127.0.0.1:3773",
        pairingCredential: "PAIRING1234",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("a mint failure remains an honest package-install success with pairing skipped", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-unity-pipeline-install-mint-failure-",
      });
      const spy = makeUnityPipelineClientSpy();
      const projection = makeProjectionSnapshotQuerySpy(makeProject(workspaceRoot));
      const pairing = makeUnityPairingHandoffSpy({ issueFails: true });
      const outcome = yield* runDispatchTest(
        spy,
        makeSession([AuthPresenceCommandScope]),
        projection,
        pairing,
      );

      expect(outcome._tag).toBe("ok");
      if (outcome._tag !== "ok" || outcome.value._tag !== "ok") return;
      expect(outcome.value.pairingOutcome).toEqual({
        _tag: "skipped",
        reason: "Could not mint a Unity pairing credential.",
      });
      expect(outcome.value.selectionPackage.packageId).toBe("com.devgame.editor-presence");
      expect(
        yield* fileSystem.exists(
          path.join(workspaceRoot, "Library/com.devgame.editor-presence/pairing.json"),
        ),
      ).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "unknown projectId returns a contract-decodable error without installing anywhere",
    () =>
      Effect.gen(function* () {
        const spy = makeUnityPipelineClientSpy();
        const projection = makeProjectionSnapshotQuerySpy(null);
        const session = makeSession([AuthPresenceCommandScope]);
        const outcome = yield* runDispatchTest(spy, session, projection);

        expect(outcome).toEqual({
          _tag: "ok",
          value: { _tag: "error", message: "Project not found." },
        });
        if (outcome._tag !== "ok") return;
        const decoded = yield* decodeInstallResult(outcome.value);
        expect(decoded).toEqual({
          _tag: "error",
          message: "Project not found.",
        });
        expect(projection.requestedProjectIds).toEqual([PROJECT_ID]);
        expect(spy.calls).toEqual([]);
      }),
  );

  it.effect(
    "a FAILED projection lookup collapses to its own typed error without installing anywhere",
    () =>
      Effect.gen(function* () {
        const spy = makeUnityPipelineClientSpy();
        const projection = makeProjectionSnapshotQuerySpy("fail");
        const session = makeSession([AuthPresenceCommandScope]);
        const outcome = yield* runDispatchTest(spy, session, projection);

        // Merge-gate F2: the WRITE route's lookup-failure branch had zero
        // coverage. "Could not resolve project." (infrastructure failed) vs
        // "Project not found." (id genuinely unknown) is the triage seam.
        expect(outcome).toEqual({
          _tag: "ok",
          value: { _tag: "error", message: "Could not resolve project." },
        });
        expect(projection.requestedProjectIds).toEqual([PROJECT_ID]);
        expect(spy.calls).toEqual([]);
      }),
  );
});
