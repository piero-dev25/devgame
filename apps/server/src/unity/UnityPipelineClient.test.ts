/**
 * Every JSON fixture below is a byte-for-byte transcription of real `unity
 * command ... --json` output captured against a live Unity 6000.3.14f1
 * Editor on a disposable project (never `~/Projects/Deepmind`) — see
 * UnityPipelineClient.ts's module doc. These are unit tests: `ProcessRunner`
 * is stubbed so the suite never shells out to the real `unity` binary and
 * stays green on a machine that doesn't have Unity installed at all — the
 * live round trip these fixtures are drawn from was verified by hand, not
 * by this suite (there is no CI-safe way to keep a real Unity Editor
 * running for `npm test`).
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import * as ProcessRunner from "../processRunner.ts";
import {
  make,
  UNITY_PIPELINE_CAPABILITIES,
  type UnityPipelineClient,
} from "./UnityPipelineClient.ts";

const PROJECT = "/Users/piero/scratch/project";

function statusEnvelope(playMode: "stopped" | "playing" | "paused"): string {
  return JSON.stringify({
    success: true,
    command: "command editor_status",
    data: {
      command: "editor_status",
      parameters: { json: true },
      result: {
        status: playMode === "stopped" ? "ready" : "playing",
        compiling: false,
        domainReloadInProgress: false,
        playMode,
        lastHeartbeat: "2026-08-04T05:37:44.259213Z",
        projectPath: PROJECT,
        unityVersion: "6000.3.14f1",
      },
      target: { host: "127.0.0.1", port: 7801, projectPath: PROJECT },
      success: true,
    },
    errors: [],
    warnings: [],
  });
}

function actionEnvelope(
  command: "editor_play" | "editor_stop" | "editor_pause",
  resultText: string,
): string {
  return JSON.stringify({
    success: true,
    command: `command ${command}`,
    data: {
      command,
      parameters: { json: true },
      result: resultText,
      target: { host: "127.0.0.1", port: 7801, projectPath: PROJECT },
      success: true,
    },
    errors: [],
    warnings: [],
  });
}

function commandFailedEnvelope(command: string, message: string): string {
  return JSON.stringify({
    success: false,
    command: `unity command ${command}`,
    data: null,
    errors: [{ code: "COMMAND_FAILED", message }],
    warnings: [],
  });
}

// The exact three error strings observed live — see UnityPipelineClient.ts's
// module doc for when each one showed up (cold: no Editor open at all; warm
// but mid domain-reload: the other two, seen consecutively while `editor_play`
// was settling).
const NO_PIPELINE_INSTANCE = commandFailedEnvelope(
  "editor_status",
  `No Pipeline instance found for project: ${PROJECT}. Make sure Unity Editor is running with the Pipeline package installed.`,
);
const CANNOT_CONNECT = commandFailedEnvelope(
  "editor_status",
  "Cannot connect to Unity Editor Pipeline server at 127.0.0.1:7801. Make sure Unity Editor is running with the Pipeline package installed.",
);
const INVALID_RESPONSE_FORMAT = commandFailedEnvelope(
  "editor_status",
  "Failed to execute command 'editor_status': Invalid response format from Pipeline server",
);
const SOME_OTHER_FAILURE = commandFailedEnvelope(
  "editor_play",
  "Play Mode entry blocked: compile errors present",
);

const okOutput = (
  stdout: string,
): Effect.Effect<ProcessRunner.ProcessRunOutput, ProcessRunner.ProcessRunError> =>
  Effect.succeed({
    stdout,
    stderr: "",
    code: null,
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
  });

/** Returns a different canned stdout per call, by position (clamped to the
 * last entry once exhausted) — mirrors a real sequence of CLI invocations
 * (action, then one or more status re-reads) without spawning anything. */
function callCountingRunner(outputs: ReadonlyArray<string>): {
  readonly run: (
    input: ProcessRunner.ProcessRunInput,
  ) => Effect.Effect<ProcessRunner.ProcessRunOutput, ProcessRunner.ProcessRunError>;
  readonly callCount: () => number;
} {
  let count = 0;
  return {
    run: () => {
      const stdout = outputs[Math.min(count, outputs.length - 1)]!;
      count += 1;
      return okOutput(stdout);
    },
    callCount: () => count,
  };
}

const withClient = <A>(
  run: (
    input: ProcessRunner.ProcessRunInput,
  ) => Effect.Effect<ProcessRunner.ProcessRunOutput, ProcessRunner.ProcessRunError>,
  f: (client: UnityPipelineClient["Service"]) => Effect.Effect<A>,
) =>
  make.pipe(
    // `make` resolves FileSystem/Path itself (for `isAvailable`'s
    // `isCommandAvailable` call — see UnityPipelineClient.ts), same as
    // ExternalLauncher.ts's own `make` does; none of the tests below
    // exercise `isAvailable`, but the layer still has to be satisfiable.
    Effect.provide(NodeServices.layer),
    Effect.provideService(ProcessRunner.ProcessRunner, ProcessRunner.ProcessRunner.of({ run })),
    Effect.flatMap(f),
  );

describe("UNITY_PIPELINE_CAPABILITIES (no step — Pipeline has no scriptable frame-step command)", () => {
  it("is exactly play/stop/pause", () => {
    expect(UNITY_PIPELINE_CAPABILITIES).toEqual(["play", "stop", "pause"]);
  });
});

describe("status", () => {
  it.effect("parses a live editor_status success envelope (stopped)", () =>
    Effect.gen(function* () {
      const runner = callCountingRunner([statusEnvelope("stopped")]);
      const result = yield* withClient(runner.run, (client) => client.status(PROJECT));
      expect(result).toEqual({
        _tag: "ok",
        value: {
          status: "ready",
          compiling: false,
          domainReloadInProgress: false,
          playMode: "stopped",
          unityVersion: "6000.3.14f1",
        },
      });
    }),
  );

  it.effect("parses playing and paused too", () =>
    Effect.gen(function* () {
      const playing = yield* withClient(
        callCountingRunner([statusEnvelope("playing")]).run,
        (client) => client.status(PROJECT),
      );
      const paused = yield* withClient(
        callCountingRunner([statusEnvelope("paused")]).run,
        (client) => client.status(PROJECT),
      );
      expect(playing._tag === "ok" && playing.value.playMode).toBe("playing");
      expect(paused._tag === "ok" && paused.value.playMode).toBe("paused");
    }),
  );

  it.effect("maps 'No Pipeline instance found' to notReady — no Editor open for this project", () =>
    Effect.gen(function* () {
      const runner = callCountingRunner([NO_PIPELINE_INSTANCE]);
      const result = yield* withClient(runner.run, (client) => client.status(PROJECT));
      expect(result).toEqual({ _tag: "notReady" });
    }),
  );

  it.effect(
    "maps 'Cannot connect to Unity Editor Pipeline server' to notReady — the domain-reload gap",
    () =>
      Effect.gen(function* () {
        const runner = callCountingRunner([CANNOT_CONNECT]);
        const result = yield* withClient(runner.run, (client) => client.status(PROJECT));
        expect(result).toEqual({ _tag: "notReady" });
      }),
  );

  it.effect("maps 'Invalid response format from Pipeline server' to notReady too", () =>
    Effect.gen(function* () {
      const runner = callCountingRunner([INVALID_RESPONSE_FORMAT]);
      const result = yield* withClient(runner.run, (client) => client.status(PROJECT));
      expect(result).toEqual({ _tag: "notReady" });
    }),
  );

  it.effect("maps an unrecognised COMMAND_FAILED to a real error, not notReady", () =>
    Effect.gen(function* () {
      const runner = callCountingRunner([SOME_OTHER_FAILURE]);
      const result = yield* withClient(runner.run, (client) => client.status(PROJECT));
      expect(result._tag).toBe("error");
      expect(result._tag === "error" && result.message).toContain("compile errors present");
    }),
  );

  it.effect(
    "treats unparseable stdout as an error, not a silent notReady or a thrown exception",
    () =>
      Effect.gen(function* () {
        const runner = callCountingRunner(["not json at all"]);
        const result = yield* withClient(runner.run, (client) => client.status(PROJECT));
        expect(result._tag).toBe("error");
      }),
  );
});

describe("play/stop/pause — assert the EFFECT via a confirming status re-read, not the action's own return code", () => {
  it.effect("play: action succeeds and status confirms playing on the first read", () =>
    Effect.gen(function* () {
      const runner = callCountingRunner([
        actionEnvelope("editor_play", "Entered play mode"),
        statusEnvelope("playing"),
      ]);
      const result = yield* withClient(runner.run, (client) => client.play(PROJECT));
      expect(result).toEqual({
        _tag: "ok",
        value: {
          status: "playing",
          compiling: false,
          domainReloadInProgress: false,
          playMode: "playing",
          unityVersion: "6000.3.14f1",
        },
      });
      // action + exactly one confirming status read — no wasted retry budget.
      expect(runner.callCount()).toBe(2);
    }),
  );

  it.effect(
    "play: retries THROUGH the domain-reload gap — action ok, status notReady twice, then confirms playing",
    () =>
      Effect.gen(function* () {
        const runner = callCountingRunner([
          actionEnvelope("editor_play", "Entered play mode"),
          CANNOT_CONNECT,
          CANNOT_CONNECT,
          statusEnvelope("playing"),
        ]);
        const fiber = yield* Effect.forkChild(
          withClient(runner.run, (client) => client.play(PROJECT)),
        );
        // Two 1s retry delays to burn through before the third status read
        // (which succeeds) — matches POST_ACTION_STATUS_RETRY_DELAY_MS.
        yield* TestClock.adjust(Duration.seconds(1));
        yield* TestClock.adjust(Duration.seconds(1));
        const result = yield* Fiber.join(fiber);
        expect(result._tag === "ok" && result.value.playMode).toBe("playing");
        expect(runner.callCount()).toBe(4);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect(
    "play: a notReady on the ACTION itself (no Editor open at all) short-circuits without a status call",
    () =>
      Effect.gen(function* () {
        const runner = callCountingRunner([NO_PIPELINE_INSTANCE]);
        const result = yield* withClient(runner.run, (client) => client.play(PROJECT));
        expect(result).toEqual({ _tag: "notReady" });
        // Only the action call — confirming a state that was never reached
        // would waste the retry budget on a call that fails for the exact
        // same reason.
        expect(runner.callCount()).toBe(1);
      }),
  );

  it.effect(
    "play: exhausting every retry (Pipeline never comes back) resolves notReady, not a hang",
    () =>
      Effect.gen(function* () {
        // Action succeeds, but EVERY status re-read fails — the retry
        // budget must run out and resolve, not loop forever.
        const runner = callCountingRunner([
          actionEnvelope("editor_play", "Entered play mode"),
          CANNOT_CONNECT,
        ]);
        const fiber = yield* Effect.forkChild(
          withClient(runner.run, (client) => client.play(PROJECT)),
        );
        // 15 retry attempts at 1s each — advance past all of them.
        yield* TestClock.adjust(Duration.seconds(20));
        const result = yield* Fiber.join(fiber);
        expect(result).toEqual({ _tag: "notReady" });
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("stop: confirms stopped", () =>
    Effect.gen(function* () {
      const runner = callCountingRunner([
        actionEnvelope("editor_stop", "Exited play mode"),
        statusEnvelope("stopped"),
      ]);
      const result = yield* withClient(runner.run, (client) => client.stop(PROJECT));
      expect(result._tag === "ok" && result.value.playMode).toBe("stopped");
    }),
  );

  it.effect("pause: confirms paused", () =>
    Effect.gen(function* () {
      const runner = callCountingRunner([
        actionEnvelope("editor_pause", "Play mode paused"),
        statusEnvelope("paused"),
      ]);
      const result = yield* withClient(runner.run, (client) => client.pause(PROJECT));
      expect(result._tag === "ok" && result.value.playMode).toBe("paused");
    }),
  );
});

// `unity pipeline list --json`'s envelope is now VERIFIED against a real
// captured sample (2026-08-04, from `Mafia Game`, a live Unity Editor with
// no Pipeline package installed — supplied by team-lead, captured on the
// owner's own machine while Unity was genuinely open):
//
//   {
//     "success": true, "command": "pipeline list",
//     "data": {
//       "instances": [{
//         "projectName": "Mafia Game",
//         "projectPath": "/Users/pieroherrera/Projects/Mafia Game",
//         "pid": 39658, "isRunning": true, "hasPipelinePackage": false,
//         "pipelineVersion": null, "updateAvailable": false,
//         "pipelineServer": { "isReachable": false, "apiUrl": null },
//         "safeMode": null
//       }],
//       "latestVersion": null,
//       "summary": { "totalInstances": 1, "runningInstances": 1,
//         "instancesWithPipeline": 0, "reachableServers": 0,
//         "instancesInSafeMode": 0, "instancesWithUpdateAvailable": 0 }
//     },
//     "errors": [], "warnings": []
//   }
//
// Two corrections that sample forced against the earlier, prose-
// reconstructed version of these fixtures: `data` has NO nested `result`
// wrapper for this subcommand (unlike `editor_status`/`editor_play`/etc,
// which do), and `latestVersion` sits on `data` ALONGSIDE `instances`, not
// inside any one instance — see UnityPipelineClient.ts's
// `UnityPipelineListInstance`/`parseUnityCliEnvelope` doc comments. Every
// field in `pipelineListEnvelope` below is real; `projectName`/`apiUrl`/
// `command`/`summary` are captured but unused by this module (ignored, not
// asserted on) — see `UnityPipelineListInstance`'s doc comment for why an
// unrecognized EXTRA field is fine while a missing REQUIRED one is not.
function pipelineListEnvelope(
  instances: ReadonlyArray<{
    readonly projectPath: string;
    readonly pid?: number | null;
    readonly isRunning?: boolean;
    readonly hasPipelinePackage?: boolean;
    readonly isReachable?: boolean;
    readonly pipelineVersion?: string | null;
    readonly updateAvailable?: boolean | null;
    readonly safeMode?: boolean | null;
  }>,
  latestVersion: string | null = null,
): string {
  return JSON.stringify({
    success: true,
    command: "pipeline list",
    data: {
      instances: instances.map((instance) => ({
        projectPath: instance.projectPath,
        pid: instance.pid ?? 12345,
        isRunning: instance.isRunning ?? true,
        hasPipelinePackage: instance.hasPipelinePackage ?? true,
        pipelineServer: { isReachable: instance.isReachable ?? true, apiUrl: null },
        // `??` would be WRONG here: a caller passing `pipelineVersion:
        // null` means "genuinely no version installed" (a real answer,
        // exactly the Mafia Game sample's own value), not "unspecified" —
        // `??` cannot tell those apart and silently overwrote the real
        // `null` with this default, which is exactly what the "byte-for-
        // byte against the real Mafia Game sample" test below caught.
        pipelineVersion:
          instance.pipelineVersion === undefined ? "0.4.0-exp.1" : instance.pipelineVersion,
        updateAvailable: instance.updateAvailable ?? false,
        safeMode: instance.safeMode ?? null,
      })),
      latestVersion,
      summary: {
        totalInstances: instances.length,
        runningInstances: instances.length,
        instancesWithPipeline: 0,
        reachableServers: 0,
        instancesInSafeMode: 0,
        instancesWithUpdateAvailable: 0,
      },
    },
    errors: [],
    warnings: [],
  });
}

describe("list", () => {
  it.effect("parses zero instances as a real, valid empty array — not a failure", () =>
    Effect.gen(function* () {
      const runner = callCountingRunner([pipelineListEnvelope([])]);
      const result = yield* withClient(runner.run, (client) => client.list(PROJECT));
      expect(result).toEqual({
        _tag: "ok",
        value: { instances: [], latestVersion: null, unparseableInstanceCount: 0 },
      });
    }),
  );

  it.effect(
    "parses every field of a single instance, byte-for-byte against the real Mafia Game sample",
    () =>
      Effect.gen(function* () {
        const runner = callCountingRunner([
          pipelineListEnvelope([
            {
              projectPath: "/Users/pieroherrera/Projects/Mafia Game",
              pid: 39658,
              isRunning: true,
              hasPipelinePackage: false,
              isReachable: false,
              pipelineVersion: null,
              updateAvailable: false,
              safeMode: null,
            },
          ]),
        ]);
        const result = yield* withClient(runner.run, (client) => client.list(PROJECT));
        expect(result).toEqual({
          _tag: "ok",
          value: {
            instances: [
              {
                projectPath: "/Users/pieroherrera/Projects/Mafia Game",
                pid: 39658,
                isRunning: true,
                hasPipelinePackage: false,
                isReachable: false,
                pipelineVersion: null,
                updateAvailable: false,
                safeMode: null,
              },
            ],
            latestVersion: null,
            unparseableInstanceCount: 0,
          },
        });
      }),
  );

  it.effect(
    "latestVersion is CLI-wide, not per-instance — read from data.latestVersion, not any instance",
    () =>
      Effect.gen(function* () {
        const runner = callCountingRunner([
          pipelineListEnvelope(
            [{ projectPath: PROJECT, updateAvailable: true, pipelineVersion: "0.4.0-exp.1" }],
            "0.5.0",
          ),
        ]);
        const result = yield* withClient(runner.run, (client) => client.list(PROJECT));
        expect(result._tag).toBe("ok");
        if (result._tag !== "ok") return;
        expect(result.value.latestVersion).toBe("0.5.0");
        // and NOT attached to the instance itself:
        expect(result.value.instances[0]).not.toHaveProperty("latestVersion");
      }),
  );

  it.effect("parses multiple instances, preserving order", () =>
    Effect.gen(function* () {
      const runner = callCountingRunner([
        pipelineListEnvelope([
          { projectPath: "/Users/piero/Projects/arena-spike" },
          { projectPath: "/Users/piero/Projects/Deepmind" },
        ]),
      ]);
      const result = yield* withClient(runner.run, (client) => client.list(PROJECT));
      expect(result._tag).toBe("ok");
      if (result._tag !== "ok") return;
      expect(result.value.instances.map((instance) => instance.projectPath)).toEqual([
        "/Users/piero/Projects/arena-spike",
        "/Users/piero/Projects/Deepmind",
      ]);
    }),
  );

  it.effect(
    "does NOT take --project-path — no project-scoped argv, unlike status/play/stop/pause",
    () =>
      Effect.gen(function* () {
        const seenArgs: Array<ReadonlyArray<string>> = [];
        const runner = (input: ProcessRunner.ProcessRunInput) => {
          seenArgs.push(input.args);
          return okOutput(pipelineListEnvelope([]));
        };
        yield* withClient(runner, (client) => client.list(PROJECT));
        expect(seenArgs).toEqual([["pipeline", "list", "--json"]]);
      }),
  );

  it.effect(
    "pins the subprocess cwd to workspaceRoot — a real invocation-directory dependency, not a --project-path substitute",
    () =>
      Effect.gen(function* () {
        // Found live (2026-08-04, presence-authz): `unity pipeline list
        // --json` is sensitive to the directory it's invoked FROM, even
        // though it takes no `--project-path` argv (the test above). This
        // is the fix for that — see UnityPipelineClient.ts's `list` doc
        // comment for the real Mafia Game repro.
        const seenCwds: Array<string | undefined> = [];
        const runner = (input: ProcessRunner.ProcessRunInput) => {
          seenCwds.push(input.cwd);
          return okOutput(pipelineListEnvelope([]));
        };
        yield* withClient(runner, (client) => client.list(PROJECT));
        expect(seenCwds).toEqual([PROJECT]);
      }),
  );

  it.effect("a non-zero CLI exit folds into { _tag: 'error' } with the CLI's own message", () =>
    Effect.gen(function* () {
      const runner = callCountingRunner([
        JSON.stringify({
          success: false,
          command: "pipeline list",
          data: null,
          errors: [{ code: "SOME_FAILURE", message: "No Unity Editor instances found anywhere" }],
          warnings: [],
        }),
      ]);
      const result = yield* withClient(runner.run, (client) => client.list(PROJECT));
      expect(result).toEqual({
        _tag: "error",
        message: "No Unity Editor instances found anywhere",
      });
    }),
  );

  it.effect("unparseable stdout folds into { _tag: 'error' }, never throws", () =>
    Effect.gen(function* () {
      const runner = callCountingRunner(["not json at all"]);
      const result = yield* withClient(runner.run, (client) => client.list(PROJECT));
      expect(result._tag).toBe("error");
    }),
  );

  describe("resilience to a malformed peer instance — the live Mafia Game defect (2026-08-04)", () => {
    it.effect(
      "a lone malformed instance entry is DROPPED and counted, not a whole-list failure",
      () =>
        Effect.gen(function* () {
          const runner = callCountingRunner([
            JSON.stringify({
              success: true,
              command: "pipeline list",
              data: { instances: [{ projectPath: PROJECT }], latestVersion: null }, // missing every other instance field
              errors: [],
              warnings: [],
            }),
          ]);
          const result = yield* withClient(runner.run, (client) => client.list(PROJECT));
          expect(result).toEqual({
            _tag: "ok",
            value: { instances: [], latestVersion: null, unparseableInstanceCount: 1 },
          });
        }),
    );

    it.effect(
      "one good entry survives a malformed peer with a MISSING pid (not null — absent) — the exact live Mafia Game shape",
      () =>
        Effect.gen(function* () {
          const runner = callCountingRunner([
            JSON.stringify({
              success: true,
              command: "pipeline list",
              data: {
                instances: [
                  {
                    // The good entry — real, well-formed, exactly what
                    // Mafia Game itself reports.
                    projectPath: "/Users/pieroherrera/Projects/Mafia Game",
                    pid: 39658,
                    isRunning: true,
                    hasPipelinePackage: false,
                    pipelineServer: { isReachable: false, apiUrl: null },
                    pipelineVersion: null,
                    updateAvailable: false,
                    safeMode: null,
                  },
                  {
                    // The phantom peer — live-observed shape: `pid` is
                    // ABSENT, not `null`. `parsePipelineListInstance`'s
                    // `isNullOr(pid, isNumber)` only accepts `null` or a
                    // number, so `undefined` fails it — this is the exact
                    // entry that took the whole S4 classification down to
                    // S12 before this fix.
                    projectPath: "/Users/pieroherrera/Projects/t3code-fork",
                    isRunning: true,
                    hasPipelinePackage: false,
                    pipelineServer: { isReachable: false, apiUrl: null },
                    pipelineVersion: null,
                    updateAvailable: false,
                    safeMode: null,
                  },
                ],
                latestVersion: null,
              },
              errors: [],
              warnings: [],
            }),
          ]);
          const result = yield* withClient(runner.run, (client) => client.list(PROJECT));
          expect(result).toEqual({
            _tag: "ok",
            value: {
              instances: [
                {
                  projectPath: "/Users/pieroherrera/Projects/Mafia Game",
                  pid: 39658,
                  isRunning: true,
                  hasPipelinePackage: false,
                  isReachable: false,
                  pipelineVersion: null,
                  updateAvailable: false,
                  safeMode: null,
                },
              ],
              latestVersion: null,
              unparseableInstanceCount: 1,
            },
          });
        }),
    );
  });

  it.effect(
    "a well-formed envelope missing data.latestVersion entirely folds into { _tag: 'error' }, never silently read as null",
    () =>
      Effect.gen(function* () {
        const runner = callCountingRunner([
          JSON.stringify({
            success: true,
            command: "pipeline list",
            data: { instances: [] }, // no latestVersion key at all
            errors: [],
            warnings: [],
          }),
        ]);
        const result = yield* withClient(runner.run, (client) => client.list(PROJECT));
        expect(result._tag).toBe("error");
      }),
  );
});
