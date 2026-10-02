/**
 * `dispatchRunStart` / `dispatchRunStop` / `dispatchRunStatus`: scope gates,
 * server-side project and thread resolution, and how service failures reach
 * the wire. Runs the real RunService over temp project roots; the projection
 * is a fake that knows which projects and threads exist.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  AuthTerminalOperateScope,
  OrchestrationProjectShell,
  PROJECT_RUNTIME_START_PATH,
  PROJECT_RUNTIME_STATUS_PATH,
  PROJECT_RUNTIME_STOP_PATH,
  ProjectId,
  RUN_PROFILES_FILE_NAME,
  ThreadId,
} from "@t3tools/contracts";
import { isDevProxiedPath } from "@t3tools/shared/devProxy";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as RunEvidence from "./RunEvidence.ts";
import * as RunProfiles from "./RunProfiles.ts";
import { dispatchRunStart, dispatchRunStatus, dispatchRunStop } from "./RunRoute.ts";
import * as RunService from "./RunService.ts";

const PROJECT_A = ProjectId.make("run-route-a");
const PROJECT_B = ProjectId.make("run-route-b");
const THREAD_A = ThreadId.make("thread-of-a");
const THREAD_B = ThreadId.make("thread-of-b");

const WorkspaceEntriesLayer = WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer));

/** A fresh service per test, so one test's runs never show up in another's status. */
const ServiceLayer = RunService.layer.pipe(
  Layer.provide(
    RunProfiles.layer.pipe(
      Layer.provide(
        WorkspaceFileSystem.layer.pipe(
          Layer.provide(WorkspacePaths.layer),
          Layer.provide(WorkspaceEntriesLayer),
        ),
      ),
      Layer.provide(WorkspacePaths.layer),
      Layer.provide(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
    ),
  ),
  Layer.provide(
    RunEvidence.layer.pipe(
      Layer.provide(GitVcsDriver.layer.pipe(Layer.provide(VcsProcess.layer))),
      Layer.provide(WorkspacePaths.layer),
    ),
  ),
);

const TestLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-run-route-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const makeSession = (
  scopes: EnvironmentAuth.AuthenticatedSession["scopes"],
): EnvironmentAuth.AuthenticatedSession => ({
  sessionId: AuthSessionId.make("test-session"),
  subject: "test-subject",
  method: "bearer-access-token",
  scopes,
});

const decodeProjectShell = Schema.decodeSync(OrchestrationProjectShell);

/** Projects and threads known to this environment, or "fail" for a broken projection. */
const projectionLayer = (roots: ReadonlyMap<ProjectId, string> | "fail") =>
  Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
    getProjectShellById: (projectId) =>
      roots === "fail"
        ? Effect.fail(new PersistenceSqlError({ operation: "test: projection lookup failure" }))
        : Effect.succeed(
            Option.map(Option.fromNullishOr(roots.get(projectId)), (workspaceRoot) =>
              decodeProjectShell({
                id: projectId,
                title: projectId,
                workspaceRoot,
                defaultModelSelection: null,
                scripts: [],
                createdAt: "2026-10-03T00:00:00.000Z",
                updatedAt: "2026-10-03T00:00:00.000Z",
              }),
            ),
          ),
    getThreadCheckpointContext: (threadId) => {
      const projectId =
        threadId === THREAD_A ? PROJECT_A : threadId === THREAD_B ? PROJECT_B : null;
      return Effect.succeed(
        projectId === null || roots === "fail"
          ? Option.none()
          : Option.some({
              threadId,
              projectId,
              workspaceRoot: roots.get(projectId) ?? "",
              worktreePath: null,
              checkpoints: [],
            }),
      );
    },
  });

/** The service over that projection; it checks threads against it too. */
const serviceWithProjection = (roots: ReadonlyMap<ProjectId, string> | "fail") =>
  ServiceLayer.pipe(Layer.provideMerge(projectionLayer(roots)));

const PROFILES_JSON = JSON.stringify({
  version: 1,
  profiles: [
    { id: "quick", name: "Quick", executable: "bin/quick", args: [] },
    { id: "broken", name: "Broken", executable: "bin/not-built", args: [] },
  ],
});

/** A project whose `quick` profile exits at once and whose `broken` profile has no program. */
const makeProject = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-run-route-" });
  yield* fileSystem.makeDirectory(`${root}/bin`);
  yield* fileSystem.writeFileString(`${root}/bin/quick`, "#!/bin/sh\nexit 0\n");
  yield* fileSystem.chmod(`${root}/bin/quick`, 0o755);
  yield* fileSystem.writeFileString(`${root}/${RUN_PROFILES_FILE_NAME}`, PROFILES_JSON);
  return root;
});

const OPERATE = [AuthTerminalOperateScope, AuthOrchestrationReadScope] as const;

/** Unwraps a dispatched value, failing the test on a 403 outcome. */
const valueOf = <A>(outcome: { _tag: "ok"; value: A } | { _tag: "insufficientScope" }) => {
  if (outcome._tag !== "ok") throw new Error(`expected ok, got ${outcome._tag}`);
  return outcome.value;
};

it.layer(TestLayer, { excludeTestServices: true })("project runtime routes", (it) => {
  it("live under /api, which single-origin dev already proxies", () => {
    for (const path of [
      PROJECT_RUNTIME_START_PATH,
      PROJECT_RUNTIME_STOP_PATH,
      PROJECT_RUNTIME_STATUS_PATH,
    ]) {
      expect(isDevProxiedPath(path)).toBe(true);
    }
  });

  describe("access", () => {
    it.effect("start and stop need terminal:operate; nothing is launched without it", () =>
      Effect.gen(function* () {
        // A launchable project, so only the scope gate stands between the call and a run.
        const root = yield* makeProject;
        return yield* Effect.gen(function* () {
          for (const scopes of [[AuthOrchestrationReadScope, AuthOrchestrationOperateScope], []]) {
            const session = makeSession(scopes);
            expect(
              yield* dispatchRunStart(session, { projectId: PROJECT_A, profileId: "quick" }),
            ).toEqual({ _tag: "insufficientScope" });
            expect(yield* dispatchRunStop(session, { projectId: PROJECT_A, runId: "any" })).toEqual(
              { _tag: "insufficientScope" },
            );
          }
          const status = valueOf(
            yield* dispatchRunStatus(makeSession(OPERATE), { projectId: PROJECT_A }),
          );
          expect("runs" in status && status.runs).toEqual([]);
        }).pipe(Effect.provide(serviceWithProjection(new Map([[PROJECT_A, root]]))));
      }),
    );

    it.effect("status needs orchestration:read", () =>
      Effect.gen(function* () {
        const outcome = yield* dispatchRunStatus(makeSession([AuthTerminalOperateScope]), {
          projectId: PROJECT_A,
        });
        expect(outcome).toEqual({ _tag: "insufficientScope" });
      }).pipe(Effect.provide(serviceWithProjection(new Map()))),
    );
  });

  describe("project resolution", () => {
    it.effect("answers 'Project not found.' for an id this environment does not know", () =>
      Effect.gen(function* () {
        const session = makeSession(OPERATE);
        const notFound = { _tag: "error", message: "Project not found." };
        expect(
          valueOf(yield* dispatchRunStart(session, { projectId: PROJECT_B, profileId: "quick" })),
        ).toEqual(notFound);
        expect(
          valueOf(yield* dispatchRunStop(session, { projectId: PROJECT_B, runId: "any" })),
        ).toEqual(notFound);
        expect(valueOf(yield* dispatchRunStatus(session, { projectId: PROJECT_B }))).toEqual(
          notFound,
        );
      }).pipe(Effect.provide(serviceWithProjection(new Map([[PROJECT_A, "x"]])))),
    );

    it.effect("answers 'Could not resolve project.' when the projection fails", () =>
      Effect.gen(function* () {
        const outcome = yield* dispatchRunStatus(makeSession(OPERATE), { projectId: PROJECT_A });
        expect(valueOf(outcome)).toEqual({ _tag: "error", message: "Could not resolve project." });
      }).pipe(Effect.provide(serviceWithProjection("fail"))),
    );

    it.effect("launches from the project's canonical root and records its own thread", () =>
      Effect.gen(function* () {
        const root = yield* makeProject;
        const session = makeSession(OPERATE);
        return yield* Effect.gen(function* () {
          const started = valueOf(
            yield* dispatchRunStart(session, {
              projectId: PROJECT_A,
              profileId: "quick",
              threadId: THREAD_A,
            }),
          );
          if ("_tag" in started) throw new Error(`expected a run, got ${started.message}`);
          expect(started.run).toMatchObject({ profileId: "quick", threadId: THREAD_A });

          // The other project's id cannot see or stop it.
          const foreignStop = valueOf(
            yield* dispatchRunStop(session, { projectId: PROJECT_B, runId: started.run.runId }),
          );
          expect(foreignStop).toMatchObject({ _tag: "error" });
          const foreignStatus = valueOf(
            yield* dispatchRunStatus(session, { projectId: PROJECT_B }),
          );
          expect("runs" in foreignStatus && foreignStatus.runs).toEqual([]);
        }).pipe(
          Effect.provide(
            serviceWithProjection(
              new Map([
                [PROJECT_A, root],
                [PROJECT_B, `${root}/elsewhere`],
              ]),
            ),
          ),
        );
      }),
    );

    it.effect("refuses a thread that belongs to another project and launches nothing", () =>
      Effect.gen(function* () {
        const root = yield* makeProject;
        const session = makeSession(OPERATE);
        return yield* Effect.gen(function* () {
          for (const threadId of [THREAD_B, ThreadId.make("unknown-thread")]) {
            const outcome = yield* dispatchRunStart(session, {
              projectId: PROJECT_A,
              profileId: "quick",
              threadId,
            });
            expect(valueOf(outcome)).toEqual({
              _tag: "error",
              message: "Thread not found in this project.",
            });
          }
          const status = valueOf(yield* dispatchRunStatus(session, { projectId: PROJECT_A }));
          expect("runs" in status && status.runs).toEqual([]);
        }).pipe(
          Effect.provide(
            serviceWithProjection(
              new Map([
                [PROJECT_A, root],
                [PROJECT_B, root],
              ]),
            ),
          ),
        );
      }),
    );
  });

  describe("profiles", () => {
    it.effect("status lists an unlaunchable profile as invalid and start reports why", () =>
      Effect.gen(function* () {
        const root = yield* makeProject;
        const session = makeSession(OPERATE);
        return yield* Effect.gen(function* () {
          const status = valueOf(yield* dispatchRunStatus(session, { projectId: PROJECT_A }));
          if ("_tag" in status) throw new Error(status.message);
          expect(status.profilesError).toBeNull();
          expect(status.profiles.map((p) => [p.id, p.valid, p.issues.map((i) => i.kind)])).toEqual([
            ["quick", true, []],
            ["broken", false, ["executable-missing"]],
          ]);

          const started = valueOf(
            yield* dispatchRunStart(session, { projectId: PROJECT_A, profileId: "broken" }),
          );
          expect(started).toEqual({
            _tag: "error",
            message:
              'Run profile "broken": executable "bin/not-built" does not exist. Build it first.',
          });
        }).pipe(Effect.provide(serviceWithProjection(new Map([[PROJECT_A, root]]))));
      }),
    );
  });
});
