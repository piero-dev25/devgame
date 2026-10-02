/**
 * `dispatchProjectWorkspaceRead`: scope gate, project resolution and how
 * each registry outcome reaches the wire. Uses the real `ProjectWorkspace`
 * reader over temp project roots, wrapped in a spy that records which roots
 * it was asked to read.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthPresenceReadScope,
  AuthSessionId,
  OrchestrationProjectShell,
  ProjectId,
  PROJECT_WORKSPACE_READ_PATH,
} from "@t3tools/contracts";
import { isDevProxiedPath } from "@t3tools/shared/devProxy";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as ProjectWorkspace from "./ProjectWorkspace.ts";
import { dispatchProjectWorkspaceRead } from "./ProjectWorkspaceRoute.ts";

const PROJECT_A = ProjectId.make("project-workspace-a");
const PROJECT_B = ProjectId.make("project-workspace-b");

const WorkspaceEntriesLayer = WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer));

/** What the real reader needs; the spy and projection fakes are added per test. */
const ReaderDependencies = Layer.mergeAll(
  WorkspacePaths.layer,
  WorkspaceFileSystem.layer.pipe(
    Layer.provide(WorkspacePaths.layer),
    Layer.provide(WorkspaceEntriesLayer),
  ),
).pipe(
  Layer.provide(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
  Layer.provide(
    ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-workspace-route-test-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

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

const decodeProjectShell = Schema.decodeSync(OrchestrationProjectShell);

const projectShell = (id: ProjectId, workspaceRoot: string) =>
  decodeProjectShell({
    id,
    title: id,
    workspaceRoot,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-10-03T00:00:00.000Z",
    updatedAt: "2026-10-03T00:00:00.000Z",
  });

/** Projects known to this environment, or "fail" for a broken projection. */
const projectionLayer = (roots: ReadonlyMap<ProjectId, string> | "fail") =>
  Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
    getProjectShellById: (projectId) =>
      roots === "fail"
        ? Effect.fail(new PersistenceSqlError({ operation: "test: projection lookup failure" }))
        : Effect.succeed(
            Option.map(Option.fromNullishOr(roots.get(projectId)), (root) =>
              projectShell(projectId, root),
            ),
          ),
  });

/** The real reader, recording every root it is asked to read. */
const makeReaderSpy = () => {
  const roots: Array<string> = [];
  const layer = Layer.effect(
    ProjectWorkspace.ProjectWorkspace,
    Effect.map(ProjectWorkspace.make, (reader) =>
      ProjectWorkspace.ProjectWorkspace.of({
        readManifest: (root) => {
          roots.push(root);
          return reader.readManifest(root);
        },
      }),
    ),
  );
  return { roots, layer };
};

const makeRoot = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-workspace-route-" });
});

const writeRegistry = Effect.fn("writeRegistry")(function* (root: string, contents: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(path.join(root, "workspace", "card"), { recursive: true });
  yield* fileSystem.writeFileString(path.join(root, "workspace", "card", "report.md"), "# Report");
  yield* fileSystem.writeFileString(path.join(root, "workspace", "workspace.json"), contents);
});

const toJson = (value: unknown): string => JSON.stringify(value);

const registryWith = (entityId: string) =>
  toJson({
    entities: [
      { id: entityId, title: entityId, folder: "card", steps: [{ name: "R", path: "report.md" }] },
    ],
  });

const dispatch = (input: {
  readonly scopes: EnvironmentAuth.AuthenticatedSession["scopes"];
  readonly projectId: ProjectId;
  readonly roots: ReadonlyMap<ProjectId, string> | "fail";
}) => {
  const spy = makeReaderSpy();
  return dispatchProjectWorkspaceRead(makeSession(input.scopes), input.projectId).pipe(
    Effect.provide(Layer.mergeAll(spy.layer, projectionLayer(input.roots))),
    Effect.map((outcome) => ({ outcome, readRoots: spy.roots })),
  );
};

/** Unwraps a dispatched value, failing the test on a 403 outcome. */
const valueOf = (outcome: Effect.Success<ReturnType<typeof dispatch>>["outcome"]) => {
  if (outcome._tag !== "ok") throw new Error(`expected ok, got ${outcome._tag}`);
  return outcome.value;
};

it.layer(ReaderDependencies, { excludeTestServices: true })(
  "dispatchProjectWorkspaceRead",
  (it) => {
    describe("access", () => {
      it.effect("refuses a session without orchestration:read and reads nothing", () =>
        Effect.gen(function* () {
          const root = yield* makeRoot;
          yield* writeRegistry(root, registryWith("card-a"));
          for (const scopes of [[AuthOrchestrationOperateScope], [AuthPresenceReadScope], []]) {
            const { outcome, readRoots } = yield* dispatch({
              scopes,
              projectId: PROJECT_A,
              roots: new Map([[PROJECT_A, root]]),
            });
            expect(outcome).toEqual({ _tag: "insufficientScope" });
            expect(readRoots).toEqual([]);
          }
        }),
      );

      it.effect("reads only the requested project's canonical root", () =>
        Effect.gen(function* () {
          const rootA = yield* makeRoot;
          const rootB = yield* makeRoot;
          yield* writeRegistry(rootA, registryWith("card-a"));
          yield* writeRegistry(rootB, registryWith("card-b"));
          const { outcome, readRoots } = yield* dispatch({
            scopes: [AuthOrchestrationReadScope],
            projectId: PROJECT_A,
            roots: new Map([
              [PROJECT_A, rootA],
              [PROJECT_B, rootB],
            ]),
          });
          const value = valueOf(outcome);
          if ("_tag" in value) throw new Error(`expected success, got ${value.message}`);
          expect(value.manifest?.entities.map((entity) => entity.id)).toEqual(["card-a"]);
          expect(value.manifest?.entities[0]?.steps[0]).toMatchObject({
            relativePath: "workspace/card/report.md",
            exists: true,
          });
          expect(readRoots).toEqual([rootA]);
        }),
      );

      it.effect("answers 'Project not found.' for an id this environment does not know", () =>
        Effect.gen(function* () {
          const rootA = yield* makeRoot;
          yield* writeRegistry(rootA, registryWith("card-a"));
          const { outcome, readRoots } = yield* dispatch({
            scopes: [AuthOrchestrationReadScope],
            projectId: PROJECT_B,
            roots: new Map([[PROJECT_A, rootA]]),
          });
          expect(valueOf(outcome)).toEqual({ _tag: "error", message: "Project not found." });
          expect(readRoots).toEqual([]);
        }),
      );

      it.effect("logs a projection failure and answers 'Could not resolve project.'", () => {
        const messages: Array<string> = [];
        const logger = Logger.make(({ message }) => {
          messages.push(String(message));
        });
        return Effect.gen(function* () {
          const { outcome, readRoots } = yield* dispatch({
            scopes: [AuthOrchestrationReadScope],
            projectId: PROJECT_A,
            roots: "fail",
          });
          expect(valueOf(outcome)).toEqual({
            _tag: "error",
            message: "Could not resolve project.",
          });
          expect(readRoots).toEqual([]);
          expect(messages.some((message) => message.includes("project lookup failed"))).toBe(true);
        }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
      });
    });

    describe("registry outcomes", () => {
      const readFor = (root: string) =>
        dispatch({
          scopes: [AuthOrchestrationReadScope],
          projectId: PROJECT_A,
          roots: new Map([[PROJECT_A, root]]),
        }).pipe(Effect.map(({ outcome }) => valueOf(outcome)));

      it.effect("a project with no registry gets manifest: null, not an error", () =>
        Effect.gen(function* () {
          const root = yield* makeRoot;
          expect(yield* readFor(root)).toEqual({ manifest: null });
        }),
      );

      it.effect("an empty registry is a success with no entities, distinct from no registry", () =>
        Effect.gen(function* () {
          const root = yield* makeRoot;
          yield* writeRegistry(root, toJson({ entities: [] }));
          expect(yield* readFor(root)).toEqual({ manifest: { entities: [], issues: [] } });
        }),
      );

      it.effect("invalid JSON and a wrong shape are visible typed errors", () =>
        Effect.gen(function* () {
          for (const contents of ["{ not json", toJson({ cards: [] })]) {
            const root = yield* makeRoot;
            yield* writeRegistry(root, contents);
            const value = yield* readFor(root);
            expect(value).toMatchObject({ _tag: "error" });
            expect("_tag" in value && value.message).toContain(
              "workspace/workspace.json is not a valid workspace registry",
            );
          }
        }),
      );

      it.effect("a registry over 1 MiB is a visible typed error", () =>
        Effect.gen(function* () {
          const root = yield* makeRoot;
          yield* writeRegistry(root, toJson({ entities: [], padding: "x".repeat(1024 * 1024) }));
          expect(yield* readFor(root)).toEqual({
            _tag: "error",
            message: "workspace/workspace.json is larger than 1 MiB and was not read.",
          });
        }),
      );
    });

    it.effect("the route path is proxied by single-origin dev", () =>
      Effect.sync(() => {
        expect(isDevProxiedPath(PROJECT_WORKSPACE_READ_PATH)).toBe(true);
      }),
    );
  },
);
