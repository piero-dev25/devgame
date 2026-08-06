import { describe, expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthPresenceCommandScope,
  AuthSessionId,
  ExternalLauncherBrowserSpawnError,
  OrchestrationProjectShell,
  ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ExternalLauncher from "../process/externalLauncher.ts";
import { dispatchUnityRaise, unityRaiseForbiddenResponse } from "./UnityRaiseRoute.ts";
import * as UnityPipelineClient from "./UnityPipelineClient.ts";

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

function listOk(
  instances: ReadonlyArray<UnityPipelineClient.UnityPipelineListInstance>,
): UnityPipelineClient.UnityPipelineResult<UnityPipelineClient.UnityPipelineListResult> {
  return {
    _tag: "ok",
    value: { instances, latestVersion: null, unparseableInstanceCount: 0 },
  };
}

function runningInstance(): UnityPipelineClient.UnityPipelineListInstance {
  return {
    projectPath: PROJECT_ROOT,
    pid: 12345,
    isRunning: true,
    hasPipelinePackage: true,
    isReachable: true,
    pipelineVersion: "0.4.0-exp.1",
    updateAvailable: false,
    safeMode: false,
  };
}

function makeSpies(input: {
  readonly project?: typeof PROJECT | null;
  readonly list: UnityPipelineClient.UnityPipelineResult<UnityPipelineClient.UnityPipelineListResult>;
  readonly open?: UnityPipelineClient.UnityPipelineResult<UnityPipelineClient.UnityPipelineOpenResult>;
  readonly launcherFails?: boolean;
}) {
  const projectionCalls: Array<string> = [];
  const pipelineCalls: Array<{ readonly method: string; readonly workspaceRoot: string }> = [];
  const launcherCalls: Array<string> = [];
  const projectionLayer = Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
    getProjectShellById: (projectId) =>
      Effect.sync(() => {
        projectionCalls.push(projectId);
        return input.project === null ? Option.none() : Option.some(input.project ?? PROJECT);
      }),
  });
  const pipelineLayer = Layer.mock(UnityPipelineClient.UnityPipelineClient)({
    list: (workspaceRoot) => {
      pipelineCalls.push({ method: "list", workspaceRoot });
      return Effect.succeed(input.list);
    },
    open: (workspaceRoot) => {
      pipelineCalls.push({ method: "open", workspaceRoot });
      return input.open === undefined
        ? Effect.die("unexpected open call")
        : Effect.succeed(input.open);
    },
  });
  const launcherLayer = Layer.mock(ExternalLauncher.ExternalLauncher)({
    launchApplication: (applicationName) => {
      launcherCalls.push(applicationName);
      return input.launcherFails
        ? Effect.fail(
            new ExternalLauncherBrowserSpawnError({
              target: applicationName,
              command: "open",
              args: ["-a", applicationName],
              cause: "spawn failed",
            }),
          )
        : Effect.void;
    },
  });
  return {
    layer: Layer.mergeAll(projectionLayer, pipelineLayer, launcherLayer),
    launcherCalls,
    pipelineCalls,
    projectionCalls,
  };
}

describe("dispatchUnityRaise", () => {
  it("uses the sibling Unity routes' standard 403 response shape for insufficient scope", () => {
    const response = unityRaiseForbiddenResponse();

    expect(response.status).toBe(403);
    expect(response.body._tag).toBe("Uint8Array");
    if (response.body._tag !== "Uint8Array") return;
    expect(new TextDecoder().decode(response.body.body)).toBe("Forbidden: insufficient scope");
  });

  it.effect("rejects insufficient scope before resolving a project or launching anything", () =>
    Effect.gen(function* () {
      const spies = makeSpies({ list: listOk([runningInstance()]) });
      const outcome = yield* dispatchUnityRaise(
        makeSession([AuthOrchestrationOperateScope]),
        PROJECT_ID,
      ).pipe(Effect.provide(spies.layer));

      expect(outcome).toEqual({ _tag: "insufficientScope" });
      expect(spies.projectionCalls).toEqual([]);
      expect(spies.pipelineCalls).toEqual([]);
      expect(spies.launcherCalls).toEqual([]);
    }),
  );

  it.effect("raises the running Unity application for a known project with a live match", () =>
    Effect.gen(function* () {
      const spies = makeSpies({ list: listOk([runningInstance()]) });
      const outcome = yield* dispatchUnityRaise(
        makeSession([AuthPresenceCommandScope]),
        PROJECT_ID,
      ).pipe(Effect.provide(spies.layer));

      expect(outcome).toEqual({ _tag: "ok", value: { _tag: "raised" } });
      expect(spies.projectionCalls).toEqual([PROJECT_ID]);
      expect(spies.pipelineCalls).toEqual([{ method: "list", workspaceRoot: PROJECT_ROOT }]);
      expect(spies.launcherCalls).toEqual(["Unity"]);
    }),
  );

  it.effect("delegates a known project with no live match to the existing cold-start launch", () =>
    Effect.gen(function* () {
      const spies = makeSpies({
        list: listOk([]),
        open: { _tag: "ok", value: { launched: true, confirmedStatus: null } },
      });
      const outcome = yield* dispatchUnityRaise(
        makeSession([AuthPresenceCommandScope]),
        PROJECT_ID,
      ).pipe(Effect.provide(spies.layer));

      expect(outcome).toEqual({ _tag: "ok", value: { _tag: "coldStartStarted" } });
      expect(spies.pipelineCalls).toEqual([
        { method: "list", workspaceRoot: PROJECT_ROOT },
        { method: "open", workspaceRoot: PROJECT_ROOT },
      ]);
      expect(spies.launcherCalls).toEqual([]);
    }),
  );

  it.effect("returns the standard typed error for an unknown opaque projectId", () =>
    Effect.gen(function* () {
      const spies = makeSpies({ project: null, list: listOk([]) });
      const outcome = yield* dispatchUnityRaise(
        makeSession([AuthPresenceCommandScope]),
        PROJECT_ID,
      ).pipe(Effect.provide(spies.layer));

      expect(outcome).toEqual({
        _tag: "ok",
        value: { _tag: "error", message: "Project not found." },
      });
      expect(spies.pipelineCalls).toEqual([]);
      expect(spies.launcherCalls).toEqual([]);
    }),
  );

  it.effect("turns a launcher failure into a typed result instead of failing the route", () =>
    Effect.gen(function* () {
      const spies = makeSpies({ list: listOk([runningInstance()]), launcherFails: true });
      const outcome = yield* dispatchUnityRaise(
        makeSession([AuthPresenceCommandScope]),
        PROJECT_ID,
      ).pipe(Effect.provide(spies.layer));

      expect(outcome._tag).toBe("ok");
      if (outcome._tag !== "ok") return;
      expect(outcome.value._tag).toBe("error");
      if (outcome.value._tag !== "error") return;
      expect(outcome.value.message).toBe("Could not bring Unity to the front.");
    }),
  );
});
