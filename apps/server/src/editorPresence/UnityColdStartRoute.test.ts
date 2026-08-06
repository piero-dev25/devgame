/**
 * In-process coverage for `dispatchUnityColdStartLaunch` — the scope-gate +
 * already-open-check + dispatch logic `POST /unity/cold-start` relies on,
 * mirroring `UnityPipelineInstallRoute.test.ts`'s own identical pattern for
 * the SAME scope (`AuthPresenceCommandScope`). NEVER spawns a real `unity`
 * process — every test provides a fake `UnityPipelineClient` whose `list`/
 * `open` are plain in-memory functions, per this round's explicit
 * constraint against launching a real Editor (the owner has one open on
 * Mafia Game). No automated HTTP round-trip test for this route family in
 * this repo yet, same gap `UnityPipelineInstallRoute.test.ts`'s own closing
 * comment names.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";

import {
  AuthOrchestrationOperateScope,
  AuthPresenceCommandScope,
  AuthPresenceReadScope,
} from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";

import { dispatchUnityColdStartLaunch } from "./UnityColdStartRoute.ts";
import * as UnityPipelineClient from "../unity/UnityPipelineClient.ts";

const PROJECT = "/Users/piero/Projects/Deepmind";

function listOk(
  instances: ReadonlyArray<UnityPipelineClient.UnityPipelineListInstance>,
): UnityPipelineClient.UnityPipelineResult<UnityPipelineClient.UnityPipelineListResult> {
  return {
    _tag: "ok",
    value: { instances, latestVersion: null, unparseableInstanceCount: 0 },
  };
}

function runningInstance(
  overrides: Partial<UnityPipelineClient.UnityPipelineListInstance> = {},
): UnityPipelineClient.UnityPipelineListInstance {
  return {
    projectPath: PROJECT,
    pid: 12345,
    isRunning: true,
    hasPipelinePackage: true,
    isReachable: true,
    pipelineVersion: "0.4.0-exp.1",
    updateAvailable: false,
    safeMode: false,
    ...overrides,
  };
}

/** A `UnityPipelineClient` double that records which methods were called
 * (and with what `workspaceRoot`) and returns fixed, caller-supplied
 * outcomes for `list`/`open` — this suite is about ROUTING, AUTHORIZATION,
 * and the already-open GUARD, not CLI parsing (already covered by
 * `UnityPipelineClient.test.ts`'s own `list`/`open` describe blocks). */
function makeUnityPipelineClientSpy(input: {
  readonly list: UnityPipelineClient.UnityPipelineResult<UnityPipelineClient.UnityPipelineListResult>;
  readonly open?: UnityPipelineClient.UnityPipelineResult<UnityPipelineClient.UnityPipelineOpenResult>;
}): {
  readonly layer: Layer.Layer<UnityPipelineClient.UnityPipelineClient>;
  readonly calls: Array<{ readonly method: string; readonly workspaceRoot: string }>;
} {
  const calls: Array<{ readonly method: string; readonly workspaceRoot: string }> = [];
  const layer = Layer.succeed(
    UnityPipelineClient.UnityPipelineClient,
    UnityPipelineClient.UnityPipelineClient.of({
      isAvailable: () => Effect.succeed(true),
      status: () => Effect.die("unexpected status call"),
      play: () => Effect.die("unexpected play call"),
      stop: () => Effect.die("unexpected stop call"),
      pause: () => Effect.die("unexpected pause call"),
      install: () => Effect.die("unexpected install call"),
      list: (workspaceRoot) => {
        calls.push({ method: "list", workspaceRoot });
        return Effect.succeed(input.list);
      },
      open: (workspaceRoot) => {
        calls.push({ method: "open", workspaceRoot });
        if (input.open === undefined) {
          return Effect.die("unexpected open call — this test never expected it to be reached");
        }
        return Effect.succeed(input.open);
      },
    }),
  );
  return { layer, calls };
}

const runDispatchTest = (
  spy: ReturnType<typeof makeUnityPipelineClientSpy>,
  session: EnvironmentAuth.AuthenticatedSession,
) =>
  dispatchUnityColdStartLaunch(session).pipe(
    Effect.provide(
      Layer.mergeAll(
        spy.layer,
        ServerConfig.layerTest(PROJECT, { prefix: "t3code-unity-cold-start-route-" }),
      ).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
  );

const COMMAND_SESSION: EnvironmentAuth.AuthenticatedSession = {
  sessionId: "test-session" as EnvironmentAuth.AuthenticatedSession["sessionId"],
  subject: "test-subject",
  method: "bearer-access-token",
  scopes: [AuthPresenceCommandScope],
};

describe("dispatchUnityColdStartLaunch", () => {
  it.effect(
    "refuses a session without the dedicated presence:command scope, without ever calling UnityPipelineClient",
    () =>
      Effect.gen(function* () {
        const spy = makeUnityPipelineClientSpy({ list: listOk([]) });
        const session: EnvironmentAuth.AuthenticatedSession = {
          sessionId: "test-session" as EnvironmentAuth.AuthenticatedSession["sessionId"],
          subject: "test-subject",
          method: "bearer-access-token",
          scopes: [AuthOrchestrationOperateScope],
        };
        const outcome = yield* runDispatchTest(spy, session);
        expect(outcome).toEqual({ _tag: "insufficientScope" });
        expect(spy.calls).toEqual([]);
      }),
  );

  it.effect(
    "presence:read alone does NOT satisfy presence:command — this route can spawn a new Editor process, that scope doesn't authorize it",
    () =>
      Effect.gen(function* () {
        const spy = makeUnityPipelineClientSpy({ list: listOk([]) });
        const session: EnvironmentAuth.AuthenticatedSession = {
          sessionId: "test-session" as EnvironmentAuth.AuthenticatedSession["sessionId"],
          subject: "test-subject",
          method: "bearer-access-token",
          scopes: [AuthPresenceReadScope],
        };
        const outcome = yield* runDispatchTest(spy, session);
        expect(outcome).toEqual({ _tag: "insufficientScope" });
        expect(spy.calls).toEqual([]);
      }),
  );

  it.effect(
    "no matching instance in `pipeline list` — calls UnityPipelineClient.open with ServerConfig.cwd, and reports launchIssued (confirmedStatus forwarded verbatim from UnityPipelineClient.open)",
    () =>
      Effect.gen(function* () {
        const confirmedStatus: UnityPipelineClient.UnityEditorStatus = {
          status: "ready",
          compiling: false,
          domainReloadInProgress: false,
          playMode: "stopped",
          unityVersion: "6000.3.14f1",
        };
        const spy = makeUnityPipelineClientSpy({
          list: listOk([]),
          open: { _tag: "ok", value: { launched: true, confirmedStatus } },
        });
        const outcome = yield* runDispatchTest(spy, COMMAND_SESSION);
        expect(outcome).toEqual({
          _tag: "ok",
          value: { _tag: "launchIssued", value: { launched: true, confirmedStatus } },
        });
        expect(spy.calls).toEqual([
          { method: "list", workspaceRoot: PROJECT },
          { method: "open", workspaceRoot: PROJECT },
        ]);
      }),
  );

  it.effect(
    "a matched instance with isRunning: true is already-open — never calls UnityPipelineClient.open",
    () =>
      Effect.gen(function* () {
        const spy = makeUnityPipelineClientSpy({ list: listOk([runningInstance()]) });
        const outcome = yield* runDispatchTest(spy, COMMAND_SESSION);
        expect(outcome).toEqual({ _tag: "ok", value: { _tag: "alreadyOpen" } });
        expect(spy.calls).toEqual([{ method: "list", workspaceRoot: PROJECT }]);
      }),
  );

  it.effect(
    "a matched instance with isRunning: false is a STALE lock, not already-open — this is the launch attempt that recovers a crashed Editor",
    () =>
      Effect.gen(function* () {
        const spy = makeUnityPipelineClientSpy({
          list: listOk([runningInstance({ isRunning: false })]),
          open: { _tag: "ok", value: { launched: true, confirmedStatus: null } },
        });
        const outcome = yield* runDispatchTest(spy, COMMAND_SESSION);
        expect(outcome).toEqual({
          _tag: "ok",
          value: { _tag: "launchIssued", value: { launched: true, confirmedStatus: null } },
        });
        expect(spy.calls).toEqual([
          { method: "list", workspaceRoot: PROJECT },
          { method: "open", workspaceRoot: PROJECT },
        ]);
      }),
  );

  it.effect("a RUNNING instance for a DIFFERENT project does not count as already-open here", () =>
    Effect.gen(function* () {
      const spy = makeUnityPipelineClientSpy({
        list: listOk([runningInstance({ projectPath: "/Users/piero/Projects/OtherGame" })]),
        open: { _tag: "ok", value: { launched: true, confirmedStatus: null } },
      });
      const outcome = yield* runDispatchTest(spy, COMMAND_SESSION);
      expect(outcome).toEqual({
        _tag: "ok",
        value: { _tag: "launchIssued", value: { launched: true, confirmedStatus: null } },
      });
      expect(spy.calls).toEqual([
        { method: "list", workspaceRoot: PROJECT },
        { method: "open", workspaceRoot: PROJECT },
      ]);
    }),
  );

  it.effect(
    "`list` itself failing refuses to launch — a false 'nothing's running' risks a second Editor instance",
    () =>
      Effect.gen(function* () {
        const spy = makeUnityPipelineClientSpy({
          list: { _tag: "error", message: "unparseable response from 'unity pipeline list'" },
        });
        const outcome = yield* runDispatchTest(spy, COMMAND_SESSION);
        expect(outcome).toEqual({
          _tag: "ok",
          value: {
            _tag: "error",
            message: "unparseable response from 'unity pipeline list'",
          },
        });
        expect(spy.calls).toEqual([{ method: "list", workspaceRoot: PROJECT }]);
      }),
  );

  it.effect("`list` reporting cliUnavailable surfaces as cliUnavailable, never attempts open", () =>
    Effect.gen(function* () {
      const spy = makeUnityPipelineClientSpy({ list: { _tag: "cliUnavailable" } });
      const outcome = yield* runDispatchTest(spy, COMMAND_SESSION);
      expect(outcome).toEqual({ _tag: "ok", value: { _tag: "cliUnavailable" } });
      expect(spy.calls).toEqual([{ method: "list", workspaceRoot: PROJECT }]);
    }),
  );

  it.effect(
    "open reporting cliUnavailable (CLI vanished between calls) surfaces as cliUnavailable",
    () =>
      Effect.gen(function* () {
        const spy = makeUnityPipelineClientSpy({
          list: listOk([]),
          open: { _tag: "cliUnavailable" },
        });
        const outcome = yield* runDispatchTest(spy, COMMAND_SESSION);
        expect(outcome).toEqual({ _tag: "ok", value: { _tag: "cliUnavailable" } });
      }),
  );

  it.effect("open reporting a real error surfaces that error's own message verbatim", () =>
    Effect.gen(function* () {
      const spy = makeUnityPipelineClientSpy({
        list: listOk([]),
        open: { _tag: "error", message: "Not a Unity project: /tmp/not-a-project" },
      });
      const outcome = yield* runDispatchTest(spy, COMMAND_SESSION);
      expect(outcome).toEqual({
        _tag: "ok",
        value: { _tag: "error", message: "Not a Unity project: /tmp/not-a-project" },
      });
    }),
  );
});
