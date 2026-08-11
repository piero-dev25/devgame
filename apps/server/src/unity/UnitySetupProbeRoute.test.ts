/**
 * In-process coverage for `dispatchUnitySetupProbe` — the scope-gate +
 * dispatch logic `POST /unity/setup-probe` relies on, mirroring
 * `UnityCommandRoute.test.ts`'s own identical pattern (that file's own
 * closing comment explains why there is no automated HTTP round-trip test
 * for this route family in this repo yet — the same gap applies here).
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  AuthSessionId,
  AuthOrchestrationOperateScope,
  AuthPresenceCommandScope,
  AuthPresenceReadScope,
  OrchestrationProjectShell,
  ProjectId,
  UnitySetupProbeResult,
} from "@t3tools/contracts";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";

import { dispatchUnitySetupProbe } from "./UnitySetupProbeRoute.ts";
import * as UnitySetupProbe from "./UnitySetupProbe.ts";

const PROJECT_ID = ProjectId.make("project-unity");
const PROJECT_ROOT = "/Users/piero/Projects/UnityGame";

const PROJECT = Schema.decodeUnknownSync(OrchestrationProjectShell)({
  id: PROJECT_ID,
  title: "Unity Game",
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

function makeUnitySetupProbeSpy(): {
  readonly layer: Layer.Layer<UnitySetupProbe.UnitySetupProbe>;
  readonly workspaceRoots: ReadonlyArray<string | null>;
} {
  const workspaceRoots: Array<string | null> = [];
  const result: UnitySetupProbe.UnitySetupProbe["Service"] = {
    probe: (workspaceRoot) => {
      workspaceRoots.push(workspaceRoot);
      return Effect.succeed({
        facts: {
          isUnityProject: true,
          cliAvailable: true,
          cliDiscoveredPath: null,
          lockfilePresent: false,
          pipelinePackage: { installed: true, resolvedVersion: "0.4.0", declaredInManifest: true },
          selectionPackage: {
            installed: true,
            resolvedVersion: "0.2.0",
            declaredInManifest: true,
          },
          selectionPublisherRegistered: true,
          withinPairingGraceWindow: false,
        },
        primary: { state: "S11" },
      });
    },
  };
  const layer = Layer.succeed(
    UnitySetupProbe.UnitySetupProbe,
    UnitySetupProbe.UnitySetupProbe.of(result),
  );
  return { layer, workspaceRoots };
}

describe("dispatchUnitySetupProbe", () => {
  it.effect(
    "refuses a session without the dedicated presence:read scope, without ever calling the probe",
    () =>
      Effect.gen(function* () {
        const spy = makeUnitySetupProbeSpy();
        const projection = makeProjectionSnapshotQuerySpy(PROJECT);
        const session = makeSession([AuthOrchestrationOperateScope]);
        const outcome = yield* dispatchUnitySetupProbe(session, PROJECT_ID).pipe(
          Effect.provide(Layer.mergeAll(spy.layer, projection.layer)),
        );
        expect(outcome).toEqual({ _tag: "insufficientScope" });
        expect(spy.workspaceRoots).toEqual([]);
        expect(projection.requestedProjectIds).toEqual([]);
      }),
  );

  it.effect(
    "known projectId resolves through the projection store and probes its canonical root",
    () =>
      Effect.gen(function* () {
        const spy = makeUnitySetupProbeSpy();
        const projection = makeProjectionSnapshotQuerySpy(PROJECT);
        const session = makeSession([AuthPresenceReadScope]);
        const outcome = yield* dispatchUnitySetupProbe(session, PROJECT_ID).pipe(
          Effect.provide(Layer.mergeAll(spy.layer, projection.layer)),
        );
        expect(outcome._tag).toBe("ok");
        if (outcome._tag !== "ok") return;
        expect("_tag" in outcome.value).toBe(false);
        if ("_tag" in outcome.value) return;
        expect(outcome.value.primary).toEqual({ state: "S11" });
        expect(projection.requestedProjectIds).toEqual([PROJECT_ID]);
        expect(spy.workspaceRoots).toEqual([PROJECT_ROOT]);
      }),
  );

  it.effect("unknown projectId returns a typed error without probing any filesystem root", () =>
    Effect.gen(function* () {
      const spy = makeUnitySetupProbeSpy();
      const projection = makeProjectionSnapshotQuerySpy(null);
      const session = makeSession([AuthPresenceReadScope]);
      const outcome = yield* dispatchUnitySetupProbe(session, PROJECT_ID).pipe(
        Effect.provide(Layer.mergeAll(spy.layer, projection.layer)),
      );

      expect(outcome).toEqual({
        _tag: "ok",
        value: { _tag: "error", message: "Project not found." },
      });
      expect(projection.requestedProjectIds).toEqual([PROJECT_ID]);
      expect(spy.workspaceRoots).toEqual([]);
    }),
  );

  it.effect(
    "a FAILED projection lookup collapses to its own typed error, distinct from Project not found",
    () =>
      Effect.gen(function* () {
        const spy = makeUnitySetupProbeSpy();
        const projection = makeProjectionSnapshotQuerySpy("fail");
        const session = makeSession([AuthPresenceReadScope]);
        // Capture logs the way auth/http.test.ts's captureLoggedCause does:
        // the tapErrorCause log is the only place the REAL failure survives
        // (the client renders only the collapsed message), so an assertion
        // on the result alone would pass even with the log deleted.
        const messages: Array<unknown> = [];
        const logger = Logger.make<unknown, void>((options) => {
          if (Array.isArray(options.message)) {
            messages.push(...options.message);
          } else {
            messages.push(options.message);
          }
        });
        const outcome = yield* dispatchUnitySetupProbe(session, PROJECT_ID).pipe(
          Effect.provide(
            Layer.mergeAll(
              spy.layer,
              projection.layer,
              Logger.layer([logger], { mergeWithExisting: false }),
            ),
          ),
        );

        // Merge-gate F2: this branch existed with zero coverage — a locked
        // DB or an undecodable row was indistinguishable from an unknown id
        // AND silently unlogged. The distinct message is the triage seam.
        expect(outcome).toEqual({
          _tag: "ok",
          value: { _tag: "error", message: "Could not resolve project." },
        });
        expect(projection.requestedProjectIds).toEqual([PROJECT_ID]);
        expect(spy.workspaceRoots).toEqual([]);
        expect(
          messages.some(
            (message) => typeof message === "string" && message.includes("project lookup failed"),
          ),
        ).toBe(true);
      }),
  );

  it("the typed project-not-found error decodes through UnitySetupProbeResult", () => {
    expect(
      Schema.decodeUnknownSync(UnitySetupProbeResult)({
        _tag: "error",
        message: "Project not found.",
      }),
    ).toEqual({ _tag: "error", message: "Project not found." });
  });

  it.effect(
    "presence:command alone does NOT satisfy presence:read — the scopes are deliberately distinct",
    () =>
      Effect.gen(function* () {
        const spy = makeUnitySetupProbeSpy();
        const projection = makeProjectionSnapshotQuerySpy(PROJECT);
        const session = makeSession([AuthPresenceCommandScope]);
        const outcome = yield* dispatchUnitySetupProbe(session, PROJECT_ID).pipe(
          Effect.provide(Layer.mergeAll(spy.layer, projection.layer)),
        );
        expect(outcome).toEqual({ _tag: "insufficientScope" });
        expect(spy.workspaceRoots).toEqual([]);
        expect(projection.requestedProjectIds).toEqual([]);
      }),
  );
});
