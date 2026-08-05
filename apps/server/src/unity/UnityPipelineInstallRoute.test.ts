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
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  AuthSessionId,
  AuthOrchestrationOperateScope,
  AuthPresenceCommandScope,
  AuthPresenceReadScope,
  OrchestrationProjectShell,
  ProjectId,
  UnityPipelineInstallResult,
} from "@t3tools/contracts";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";

import { dispatchUnityPipelineInstall } from "./UnityPipelineInstallRoute.ts";
import * as UnityPipelineClient from "./UnityPipelineClient.ts";

const PROJECT_ID = ProjectId.make("project-unity");
const PROJECT_ROOT = "/Users/piero/Projects/Deepmind";

const PROJECT = Schema.decodeUnknownSync(OrchestrationProjectShell)({
  id: PROJECT_ID,
  title: "Deepmind",
  workspaceRoot: PROJECT_ROOT,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-08-05T00:00:00.000Z",
  updatedAt: "2026-08-05T00:00:00.000Z",
});

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

/** Provides the CLI double and projection-store double around one dispatch. */
const runDispatchTest = (
  spy: ReturnType<typeof makeUnityPipelineClientSpy>,
  session: EnvironmentAuth.AuthenticatedSession,
  projection: ReturnType<typeof makeProjectionSnapshotQuerySpy>,
) =>
  dispatchUnityPipelineInstall(session, PROJECT_ID).pipe(
    Effect.provide(Layer.mergeAll(spy.layer, projection.layer)),
  );

describe("dispatchUnityPipelineInstall", () => {
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
    "known projectId resolves through the projection store and installs into its canonical root",
    () =>
      Effect.gen(function* () {
        const spy = makeUnityPipelineClientSpy();
        const projection = makeProjectionSnapshotQuerySpy(PROJECT);
        const session = makeSession([AuthPresenceCommandScope]);
        const outcome = yield* runDispatchTest(spy, session, projection);
        expect(outcome._tag).toBe("ok");
        if (outcome._tag !== "ok") return;
        expect(outcome.value).toEqual({
          _tag: "ok",
          value: {
            packageId: "com.unity.pipeline",
            version: "0.4.0-exp.1",
            alreadyInstalled: false,
          },
        });
        expect(projection.requestedProjectIds).toEqual([PROJECT_ID]);
        expect(spy.calls).toEqual([{ method: "install", workspaceRoot: PROJECT_ROOT }]);
      }),
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
        const decoded = yield* Schema.decodeUnknownEffect(UnityPipelineInstallResult)(
          outcome.value,
        );
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
