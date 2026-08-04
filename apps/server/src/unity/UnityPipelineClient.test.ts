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
