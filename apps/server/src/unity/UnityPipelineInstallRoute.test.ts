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
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
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

const encodeJson = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);
const decodeProjectShell = Schema.decodeUnknownSync(OrchestrationProjectShell);
const decodePairingFile = Schema.decodeUnknownEffect(
  Schema.fromJsonString(UnityEditorPresencePairingFile),
);
const decodeInstallResult = Schema.decodeUnknownEffect(UnityPipelineInstallResult);
const PROJECT_ID = ProjectId.make("project-unity");
const PROJECT_ROOT = "/Users/piero/Projects/Deepmind";

function makeProject(workspaceRoot: string) {
  return decodeProjectShell({
    id: PROJECT_ID,
    title: "Deepmind",
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
 * `install` was called with, and returns a fixed outcome — this suite is
 * about ROUTING and AUTHORIZATION, not about CLI parsing (already covered
 * by `UnityPipelineClient.test.ts`'s own `install` describe block). */
function makeUnityPipelineClientSpy(): {
  readonly layer: Layer.Layer<UnityPipelineClient.UnityPipelineClient>;
  readonly calls: Array<{ readonly method: string; readonly workspaceRoot: string }>;
} {
  const calls: Array<{ readonly method: string; readonly workspaceRoot: string }> = [];
  const outcome: UnityPipelineClient.UnityPipelineResult<UnityPipelineClient.UnityPipelineInstallResult> =
    {
      _tag: "ok",
      value: { packageId: "com.unity.pipeline", version: "0.4.0-exp.1", alreadyInstalled: false },
    };
  const layer = Layer.succeed(
    UnityPipelineClient.UnityPipelineClient,
    UnityPipelineClient.UnityPipelineClient.of({
      isAvailable: () => Effect.succeed(true),
      status: () => Effect.die("unexpected status call"),
      play: () => Effect.die("unexpected play call"),
      stop: () => Effect.die("unexpected stop call"),
      pause: () => Effect.die("unexpected pause call"),
      list: () => Effect.die("unexpected list call"),
      install: (workspaceRoot) => {
        calls.push({ method: "install", workspaceRoot });
        return Effect.succeed(outcome);
      },
      open: () => Effect.die("unexpected open call"),
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
        "/Applications/DevGame.app/Contents/Resources/unity-packages/com.ironmind.editor-presence",
        "/Applications/DevGame.app/Contents/Resources/unity/com.ironmind.editor-presence",
        "/Applications/DevGame.app/Contents/Resources/app.asar/unity/com.ironmind.editor-presence",
        "/Users/dev/t3code-fork/unity/com.ironmind.editor-presence",
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
            packageId: "com.ironmind.editor-presence",
            version: "0.3.0",
            operation: "installed",
          },
          pairingOutcome: { _tag: "minted" },
        });
        expect(projection.requestedProjectIds).toEqual([PROJECT_ID]);
        expect(spy.calls).toEqual([{ method: "install", workspaceRoot }]);
        expect(pairing.registeredRoots).toEqual([workspaceRoot]);
        expect(pairing.issued).toEqual([
          {
            label: "Unity selection — Deepmind",
            scopes: [AuthOrchestrationOperateScope],
          },
        ]);
        expect(
          yield* fileSystem.exists(
            path.join(workspaceRoot, "Packages/com.ironmind.editor-presence/package.json.meta"),
          ),
        ).toBe(true);
        const pairingFile = yield* fileSystem.readFileString(
          path.join(workspaceRoot, "Library/com.ironmind.editor-presence/pairing.json"),
        );
        expect(yield* decodePairingFile(pairingFile)).toEqual({
          serverUrl: "http://127.0.0.1:3773",
          pairingCredential: "PAIRING1234",
        });
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("same selection-package version is a no-op success", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-unity-pipeline-install-same-",
      });
      const destination = path.join(workspaceRoot, "Packages/com.ironmind.editor-presence");
      yield* fileSystem.makeDirectory(destination, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(destination, "package.json"),
        encodeJson({ name: "com.ironmind.editor-presence", version: "0.3.0" }),
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
        packageId: "com.ironmind.editor-presence",
        version: "0.3.0",
        operation: "alreadyInstalled",
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
      const destination = path.join(workspaceRoot, "Packages/com.ironmind.editor-presence");
      yield* fileSystem.makeDirectory(destination, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(destination, "package.json"),
        encodeJson({ name: "com.ironmind.editor-presence", version: "0.1.0" }),
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
        packageId: "com.ironmind.editor-presence",
        version: "0.3.0",
        operation: "replaced",
      });
      expect(yield* fileSystem.exists(path.join(destination, "stale.txt"))).toBe(false);
      expect(yield* fileSystem.exists(path.join(destination, "package.json.meta"))).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

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
          path.join(workspaceRoot, "Library/com.ironmind.editor-presence/pairing.json"),
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
        packageId: "com.ironmind.editor-presence",
        version: "0.3.0",
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
        "Library/com.ironmind.editor-presence/pairing.json",
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
      expect(outcome.value.selectionPackage.packageId).toBe("com.ironmind.editor-presence");
      expect(
        yield* fileSystem.exists(
          path.join(workspaceRoot, "Library/com.ironmind.editor-presence/pairing.json"),
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
