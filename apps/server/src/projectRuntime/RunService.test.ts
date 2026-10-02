// @effect-diagnostics nodeBuiltinImport:off
/**
 * RunService against real processes: each test's project holds a small node
 * script standing in for the game. Every wait is on a receipt from the
 * service, never on time. Each test builds its own service, so closing the
 * test's scope also stops anything a failed test left running.
 */
import * as NodeChildProcess from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProjectId, RUN_PROFILES_FILE_NAME, ThreadId } from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as RunProfiles from "./RunProfiles.ts";
import * as RunService from "./RunService.ts";

const PROJECT = ProjectId.make("run-service-project");
const OTHER_PROJECT = ProjectId.make("run-service-other");
const OWN_THREAD = ThreadId.make("run-service-thread");
const OTHER_THREAD = ThreadId.make("run-service-other-thread");

/**
 * The fake game. `idle` waits forever; `exit <code>` exits on its own;
 * `stubborn` ignores SIGTERM and starts a grandchild in its process group;
 * `chatty <bytes>` writes that much output, then exits; `launcher` starts a
 * helper in its process group that shares its stdout and ignores SIGTERM,
 * waits until the helper is listening, then exits 0.
 */
const FAKE_GAME = `#!${process.execPath}
const [mode, arg] = process.argv.slice(2);
const env = Object.keys(process.env).sort().join(",");
process.stdout.write("ready cwd=" + process.cwd() + " env=" + env + " argv=" + JSON.stringify(process.argv.slice(2)) + "\\n");
if (mode === "exit") {
  process.stderr.write("exiting early\\n");
  process.exitCode = Number(arg);
} else if (mode === "chatty") {
  process.stdout.write("x".repeat(Number(arg)) + "done\\n");
} else if (mode === "launcher") {
  const helperSource = "process.on('SIGTERM', () => process.stdout.write('helper ignoring SIGTERM ')); setInterval(() => {}, 60000); process.send('listening');";
  const helper = require("node:child_process").spawn(process.execPath, ["-e", helperSource], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
  helper.once("message", () => {
    process.stdout.write("helper=" + helper.pid + "\\n");
    helper.disconnect();
    helper.unref();
  });
} else {
  if (mode === "stubborn") {
    process.on("SIGTERM", () => process.stdout.write("ignoring SIGTERM\\n"));
    const grandchild = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], { stdio: "ignore" });
    process.stdout.write("grandchild=" + grandchild.pid + "\\n");
  }
  setInterval(() => {}, 60000);
}
`;

const profile = (id: string, args: ReadonlyArray<string>, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  executable: "bin/fake-game",
  args,
  ...extra,
});

const PROFILES = [
  profile("idle", ["idle", "$HOME;x y"], { cwd: "Runtime", envAllowList: ["GAME_MODE"] }),
  profile("idle-2", ["idle"]),
  profile("stubborn", ["stubborn"]),
  profile("early-exit", ["exit", "3"]),
  profile("launcher", ["launcher"]),
  profile("chatty", ["chatty", "40000"], {
    outputs: [{ name: "shot", kind: "image", path: "work/captures/shot.png" }],
  }),
  profile("missing", [], { executable: "bin/not-built" }),
  profile("not-executable", [], { executable: "bin/readme" }),
  profile("bad-interpreter", [], { executable: "bin/bad-interpreter" }),
];

const PROFILES_JSON = JSON.stringify({ version: 1, profiles: PROFILES });
/** How the fake game prints the argv it received. */
const IDLE_ARGV = JSON.stringify(["idle", "$HOME;x y"]);

const WorkspaceEntriesLayer = WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer));

const makeServiceLayer = () =>
  RunService.layerWithOptions({ stopGrace: "300 millis" }).pipe(
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
    // Which project each known thread belongs to.
    Layer.provide(
      Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
        getThreadCheckpointContext: (threadId) => {
          const projectId =
            threadId === OWN_THREAD ? PROJECT : threadId === OTHER_THREAD ? OTHER_PROJECT : null;
          return Effect.succeed(
            projectId === null
              ? Option.none()
              : Option.some({
                  threadId,
                  projectId,
                  workspaceRoot: "/unused",
                  worktreePath: null,
                  checkpoints: [],
                }),
          );
        },
      }),
    ),
    // The child may see only PATH, HOME and what its profile allows.
    Layer.provide(
      Layer.succeed(HostProcessEnvironment, {
        PATH: "/usr/bin:/bin",
        HOME: "/tmp/fake-home",
        GAME_MODE: "arena",
        OTHER_VAR: "must-not-leak",
      }),
    ),
  );

const TestLayer = Layer.mergeAll(
  ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-run-service-test-" }),
).pipe(Layer.provideMerge(NodeServices.layer));

const writeFile = Effect.fn("writeFile")(function* (
  root: string,
  relativePath: string,
  contents: string,
  mode: number,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(root, relativePath);
  yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
  yield* fileSystem.writeFileString(absolutePath, contents);
  yield* fileSystem.chmod(absolutePath, mode);
});

const makeProject = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-run-service-" });
  yield* writeFile(root, "bin/fake-game", FAKE_GAME, 0o755);
  yield* writeFile(root, "bin/readme", "not a program\n", 0o644);
  yield* writeFile(root, "bin/bad-interpreter", "#!/nonexistent/interpreter\n", 0o755);
  yield* fileSystem.makeDirectory(`${root}/Runtime`);
  yield* writeFile(root, RUN_PROFILES_FILE_NAME, PROFILES_JSON, 0o644);
  return root;
});

/** A test harness around one service instance and one project. */
const setup = Effect.gen(function* () {
  const root = yield* makeProject;
  const service = yield* RunService.RunService;
  // Subscribed before anything starts, so no receipt can be missed.
  const receipts = yield* service.subscribeReceipts;
  const awaitReceipt = (predicate: (receipt: RunService.RunReceipt) => boolean) =>
    receipts.pipe(Stream.filter(predicate), Stream.runHead, Effect.map(Option.getOrThrow));
  const start = (profileId: string, projectId = PROJECT, threadId: ThreadId | null = null) =>
    service.start({ projectId, workspaceRoot: root, profileId, threadId });
  const runs = (projectId = PROJECT) =>
    service.status({ projectId, workspaceRoot: root }).pipe(Effect.map((status) => status.runs));
  /** Waits on log receipts until the run's tail contains `text`. */
  const awaitLog = (runId: string, text: string) =>
    receipts.pipe(
      Stream.filter((receipt) => receipt._tag === "logAppended" && receipt.runId === runId),
      Stream.mapEffect(() => runs()),
      Stream.map((list) => list.find((run) => run.runId === runId)?.logTail ?? ""),
      Stream.filter((tail) => tail.includes(text)),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    );
  return { root, service, awaitReceipt, awaitLog, start, runs };
});

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A process nobody asked RunService to start: an editor, an agent, a game opened by hand. */
const spawnUnrelated = Effect.acquireRelease(
  Effect.sync(() => {
    const child = NodeChildProcess.spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], {
      stdio: "ignore",
      detached: true,
    });
    return child.pid ?? 0;
  }),
  (pid) =>
    Effect.sync(() => {
      // Killed by the pid captured at spawn above, never by pattern.
      if (isAlive(pid)) process.kill(pid, "SIGKILL");
    }),
);

it.layer(TestLayer, { excludeTestServices: true })("RunService", (it) => {
  describe("start", () => {
    it.effect(
      "spawns the profile with its literal argv, cwd and allowed env, and records the pid",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const h = yield* setup;

          const { run, alreadyRunning } = yield* h.start("idle");
          const started = yield* h.awaitReceipt((r) => r._tag === "started");
          const tail = yield* h.awaitLog(run.runId, "ready");

          expect(alreadyRunning).toBe(false);
          expect(started).toMatchObject({ runId: run.runId, pid: run.pid });
          expect(run.pid !== null && isAlive(run.pid)).toBe(true);
          expect((yield* h.runs()).map((r) => [r.runId, r.status, r.pid])).toEqual([
            [run.runId, "running", run.pid],
          ]);
          expect(tail).toContain(`cwd=${yield* fileSystem.realPath(`${h.root}/Runtime`)} `);
          // macOS CoreFoundation adds __CF_USER_TEXT_ENCODING inside the child itself.
          const env = /env=(\S*)/.exec(tail)?.[1]?.split(",") ?? [];
          expect(env.filter((name) => !name.startsWith("__CF_"))).toEqual([
            "GAME_MODE",
            "HOME",
            "PATH",
          ]);
          expect(tail).toContain(`argv=${IDLE_ARGV}`);
        }).pipe(Effect.provide(makeServiceLayer())),
    );

    it.effect("refuses a second start of a running profile and returns the run already going", () =>
      Effect.gen(function* () {
        const h = yield* setup;

        const first = yield* h.start("idle-2");
        const second = yield* h.start("idle-2");

        expect(second).toEqual({ run: first.run, alreadyRunning: true });
        expect((yield* h.runs()).map((r) => r.runId)).toEqual([first.run.runId]);
        // Another project's run of the same profile id is its own run.
        const other = yield* h.start("idle-2", OTHER_PROJECT);
        expect(other.alreadyRunning).toBe(false);
        expect(other.run.runId).not.toBe(first.run.runId);
      }).pipe(Effect.provide(makeServiceLayer())),
    );

    it.effect("reports a missing or non-executable program before spawning anything", () =>
      Effect.gen(function* () {
        const h = yield* setup;

        const missing = yield* h.start("missing").pipe(Effect.flip);
        const notExecutable = yield* h.start("not-executable").pipe(Effect.flip);

        expect(missing._tag).toBe("RunProfileExecutableMissing");
        expect(missing.message).toContain("bin/not-built");
        expect(notExecutable._tag).toBe("RunProfileExecutableNotExecutable");
        expect(yield* h.runs()).toEqual([]);
      }).pipe(Effect.provide(makeServiceLayer())),
    );

    it.effect("records a spawn failure as launchFailed with no process left behind", () =>
      Effect.gen(function* () {
        const h = yield* setup;

        const error = yield* h.start("bad-interpreter").pipe(Effect.flip);
        const receipt = yield* h.awaitReceipt((r) => r._tag === "launchFailed");

        expect(error._tag).toBe("RunLaunchFailed");
        expect(receipt).toMatchObject({ _tag: "launchFailed", message: error.message });
        const [run] = yield* h.runs();
        expect(run).toMatchObject({ status: "launchFailed", pid: null, error: error.message });
        expect(run?.endedAt).not.toBeNull();
        // The failed attempt does not block the next one.
        expect((yield* h.start("bad-interpreter").pipe(Effect.flip))._tag).toBe("RunLaunchFailed");
      }).pipe(Effect.provide(makeServiceLayer())),
    );

    it.effect("records an early exit with its code and keeps the log", () =>
      Effect.gen(function* () {
        const h = yield* setup;

        const { run } = yield* h.start("early-exit");
        const exited = yield* h.awaitReceipt((r) => r._tag === "exited");

        expect(exited).toMatchObject({ runId: run.runId, exitCode: 3, signal: null });
        const [state] = yield* h.runs();
        expect(state).toMatchObject({ runId: run.runId, status: "exited", exitCode: 3 });
        expect(state?.endedAt).not.toBeNull();
        expect(state?.logTail).toContain("exiting early");
        // An exited run no longer counts as running.
        expect((yield* h.start("early-exit")).alreadyRunning).toBe(false);
      }).pipe(Effect.provide(makeServiceLayer())),
    );

    it.effect(
      "records the project's own thread and refuses another project's or an unknown one",
      () =>
        Effect.gen(function* () {
          const h = yield* setup;

          for (const threadId of [OTHER_THREAD, ThreadId.make("unknown-thread")]) {
            const error = yield* h.start("idle-2", PROJECT, threadId).pipe(Effect.flip);
            expect(error).toBeInstanceOf(RunService.RunThreadNotInProject);
            expect(error.message).toBe("Thread not found in this project.");
          }
          expect(yield* h.runs()).toEqual([]);

          const { run } = yield* h.start("idle-2", PROJECT, OWN_THREAD);
          expect(run.threadId).toBe(OWN_THREAD);
        }).pipe(Effect.provide(makeServiceLayer())),
    );

    it.effect("keeps the game running when the caller is interrupted", () =>
      Effect.gen(function* () {
        const h = yield* setup;

        // Like an HTTP request: its own scope, ended by a client disconnect.
        const caller = yield* Effect.forkChild(Effect.scoped(h.start("idle")));
        const started = yield* h.awaitReceipt((r) => r._tag === "started");
        yield* Fiber.interrupt(caller);

        const pid = started._tag === "started" ? started.pid : 0;
        yield* h.awaitLog(started.runId, "ready");
        expect(isAlive(pid)).toBe(true);
        expect((yield* h.runs()).map((r) => r.status)).toEqual(["running"]);
      }).pipe(Effect.provide(makeServiceLayer())),
    );

    it.effect("writes the full output to the run log and keeps only a bounded tail", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const { stateDir } = yield* ServerConfig.ServerConfig;
        const h = yield* setup;

        const { run } = yield* h.start("chatty");
        yield* h.awaitReceipt((r) => r._tag === "exited");

        const log = yield* fileSystem.readFileString(
          `${stateDir}/runs/${PROJECT}/${run.runId}/run.log`,
        );
        expect(log.startsWith("ready ")).toBe(true);
        expect(log.endsWith(`${"x".repeat(100)}done\n`)).toBe(true);
        expect(log.length).toBeGreaterThan(40_000);
        const [state] = yield* h.runs();
        expect(state?.logTail.length).toBe(16 * 1024);
        expect(log.endsWith(state?.logTail ?? "missing")).toBe(true);
        // The runner creates each output's directory for the program to write into.
        expect(yield* fileSystem.exists(`${h.root}/work/captures`)).toBe(true);
      }).pipe(Effect.provide(makeServiceLayer())),
    );
  });

  describe("stop", () => {
    it.effect("signals only the run's process group and escalates when SIGTERM is ignored", () =>
      Effect.gen(function* () {
        const h = yield* setup;
        const unrelated = yield* spawnUnrelated;
        const bystander = yield* h.start("idle-2");

        const { run } = yield* h.start("stubborn");
        const tail = yield* h.awaitLog(run.runId, "grandchild=");
        const grandchild = Number(/grandchild=(\d+)/.exec(tail)?.[1]);
        const stopped = yield* h.service.stop({ projectId: PROJECT, runId: run.runId });
        const receipt = yield* h.awaitReceipt((r) => r._tag === "stopped");

        expect(stopped).toMatchObject({ status: "stopped", signal: "SIGKILL", exitCode: null });
        expect(stopped.logTail).toContain("ignoring SIGTERM");
        expect(receipt).toMatchObject({ runId: run.runId, signal: "SIGKILL" });
        expect(isAlive(run.pid ?? 0)).toBe(false);
        expect(isAlive(grandchild)).toBe(false);
        expect(isAlive(unrelated)).toBe(true);
        expect(isAlive(bystander.run.pid ?? 0)).toBe(true);
        // Stopping again is a no-op that reports the same final state.
        expect(yield* h.service.stop({ projectId: PROJECT, runId: run.runId })).toEqual(stopped);
      }).pipe(Effect.provide(makeServiceLayer())),
    );

    it.effect("reports a program that exited 0 at once and stops what it left in its group", () =>
      Effect.gen(function* () {
        const h = yield* setup;

        const { run } = yield* h.start("launcher");
        // The helper only sees SIGTERM after the launcher exited and the run began cleaning up.
        const tail = yield* h.awaitLog(run.runId, "helper ignoring SIGTERM");
        const helper = Number(/helper=(\d+)/.exec(tail)?.[1]);

        // The program is gone: the run reads as exited and does not block a new launch.
        const [state] = yield* h.runs();
        expect(state).toMatchObject({ runId: run.runId, status: "exited", exitCode: 0 });
        const again = yield* h.start("launcher");
        expect(again.alreadyRunning).toBe(false);

        // Stop reaches the helper too, waiting until the group is empty.
        const stopped = yield* h.service.stop({ projectId: PROJECT, runId: run.runId });
        expect(stopped).toMatchObject({ status: "exited", exitCode: 0, signal: null });
        expect(isAlive(helper)).toBe(false);
      }).pipe(Effect.provide(makeServiceLayer())),
    );

    it.effect("refuses an unknown run id or another project's run and signals nothing", () =>
      Effect.gen(function* () {
        const h = yield* setup;
        const { run } = yield* h.start("idle");

        const unknown = yield* h.service
          .stop({ projectId: PROJECT, runId: "no-such-run" })
          .pipe(Effect.flip);
        const foreign = yield* h.service
          .stop({ projectId: OTHER_PROJECT, runId: run.runId })
          .pipe(Effect.flip);

        expect(unknown._tag).toBe("RunNotOwned");
        expect(foreign._tag).toBe("RunNotOwned");
        expect(isAlive(run.pid ?? 0)).toBe(true);
        expect((yield* h.runs()).map((r) => r.status)).toEqual(["running"]);
      }).pipe(Effect.provide(makeServiceLayer())),
    );
  });

  it.effect("stops every owned run when the service shuts down, and nothing else", () =>
    Effect.gen(function* () {
      const unrelated = yield* spawnUnrelated;
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(makeServiceLayer(), scope);

      const { idle, stubborn, grandchild } = yield* Effect.gen(function* () {
        const h = yield* setup;
        const idle = yield* h.start("idle");
        const stubborn = yield* h.start("stubborn");
        const tail = yield* h.awaitLog(stubborn.run.runId, "grandchild=");
        return { idle, stubborn, grandchild: Number(/grandchild=(\d+)/.exec(tail)?.[1]) };
      }).pipe(Effect.provide(context));
      expect([idle.run.pid, stubborn.run.pid, grandchild].map((pid) => isAlive(pid ?? 0))).toEqual([
        true,
        true,
        true,
      ]);

      yield* Scope.close(scope, Exit.void);

      expect([idle.run.pid, stubborn.run.pid, grandchild].map((pid) => isAlive(pid ?? 0))).toEqual([
        false,
        false,
        false,
      ]);
      expect(isAlive(unrelated)).toBe(true);
    }),
  );

  it.effect(
    "stops what an exited program left behind when the service shuts down mid-cleanup",
    () =>
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const context = yield* Layer.buildWithScope(makeServiceLayer(), scope);

        const helper = yield* Effect.gen(function* () {
          const h = yield* setup;
          const { run } = yield* h.start("launcher");
          // The run is now waiting out the helper's SIGTERM grace.
          const tail = yield* h.awaitLog(run.runId, "helper ignoring SIGTERM");
          return Number(/helper=(\d+)/.exec(tail)?.[1]);
        }).pipe(Effect.provide(context));
        // If the service misses it, the test still kills it by the pid it printed.
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (isAlive(helper)) process.kill(helper, "SIGKILL");
          }),
        );
        expect(isAlive(helper)).toBe(true);

        yield* Scope.close(scope, Exit.void);

        expect(isAlive(helper)).toBe(false);
      }),
  );
});
