// @effect-diagnostics nodeBuiltinImport:off
/**
 * RunService - launches a project's run profiles and owns the processes.
 *
 * One instance per server, built in the runtime layer next to the terminal
 * manager, so every route shares one registry and the layer's scope is the
 * owner of every child. Each run gets a scope forked from the service's, never
 * the caller's: a client that disconnects mid-start leaves the game running,
 * and closing the service (server shutdown) stops every run it started.
 *
 * A run spawns the launch plan's absolute executable with its literal argv and
 * no shell, in its own process group. Stop and shutdown signal only that group
 * through the handle captured at spawn (SIGTERM, then SIGKILL after a bounded
 * grace). Nothing is ever found or killed by name, and after a restart the
 * registry is empty: earlier processes are never adopted.
 *
 * The child's stdout and stderr are drained continuously into
 * `<stateDir>/runs/<projectId>/<runId>/run.log`, with a bounded tail kept in
 * memory. Every lifecycle step publishes a {@link RunReceipt}.
 *
 * @module RunService
 */
import * as NodeCrypto from "node:crypto";

import type { ProjectId, RunState, RunStatusSuccess, ThreadId } from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import * as RunProfiles from "./RunProfiles.ts";

export class RunLaunchFailed extends Schema.TaggedError<RunLaunchFailed>()("RunLaunchFailed", {
  profileId: Schema.String,
  detail: Schema.String,
}) {
  override get message(): string {
    return `Could not launch run profile "${this.profileId}": ${this.detail}`;
  }
}

/** The run id is unknown, or belongs to another project. */
export class RunNotOwned extends Schema.TaggedError<RunNotOwned>()("RunNotOwned", {
  runId: Schema.String,
}) {
  override get message(): string {
    return `No run "${this.runId}" was started for this project by this server.`;
  }
}

/** Lifecycle receipts. Tests and future live views wait on these, never on time. */
export type RunReceipt =
  | {
      readonly _tag: "started";
      readonly projectId: ProjectId;
      readonly runId: string;
      readonly pid: number;
    }
  | {
      readonly _tag: "launchFailed";
      readonly projectId: ProjectId;
      readonly runId: string;
      readonly message: string;
    }
  | {
      readonly _tag: "logAppended";
      readonly projectId: ProjectId;
      readonly runId: string;
      readonly bytes: number;
    }
  | {
      readonly _tag: "exited" | "stopped";
      readonly projectId: ProjectId;
      readonly runId: string;
      readonly exitCode: number | null;
      readonly signal: string | null;
    };

export class RunService extends Context.Service<
  RunService,
  {
    /**
     * Launch a profile of the project rooted at `workspaceRoot` (the caller
     * resolves it server-side). If the same profile of the same project is
     * starting or running, nothing is spawned and that run is returned with
     * `alreadyRunning: true`. Never builds or installs anything.
     */
    readonly start: (input: {
      readonly projectId: ProjectId;
      readonly workspaceRoot: string;
      readonly profileId: string;
      readonly threadId: ThreadId | null;
    }) => Effect.Effect<
      { readonly run: RunState; readonly alreadyRunning: boolean },
      RunProfiles.RunProfileResolveError | RunLaunchFailed
    >;
    /**
     * Stop one of the project's runs and wait until it has exited. Only that
     * run's process group is signalled. A run that already ended is returned as is.
     */
    readonly stop: (input: {
      readonly projectId: ProjectId;
      readonly runId: string;
    }) => Effect.Effect<RunState, RunNotOwned>;
    /** The project's profiles and this server's runs of them, newest first. */
    readonly status: (input: {
      readonly projectId: ProjectId;
      readonly workspaceRoot: string;
    }) => Effect.Effect<RunStatusSuccess>;
    /** Subscribe before acting, so no receipt is missed. */
    readonly subscribeReceipts: Effect.Effect<Stream.Stream<RunReceipt>, never, Scope.Scope>;
  }
>()("t3/projectRuntime/RunService") {}

/** Variables every run gets; anything else must be in the profile's `envAllowList`. */
const BASE_ENV = ["PATH", "HOME"] as const;
const LOG_TAIL_CHARS = 16 * 1024;
/** Finished runs remembered per project for status; the logs stay on disk. */
const FINISHED_RUNS_KEPT = 20;
/** After exit, how long to wait for output still in the pipes before closing them. */
const DRAIN_AFTER_EXIT = Duration.seconds(2);

interface RunEntry {
  readonly projectId: ProjectId;
  state: RunState;
  /** Set once the process has spawned; never set for a run that failed to launch. */
  handle: ChildProcessSpawner.ChildProcessHandle | null;
  stopRequested: boolean;
  /** Done when the launch attempt has finished, either way. */
  readonly launched: Deferred.Deferred<void>;
  /** Done when the run has reached a final state. */
  readonly finished: Deferred.Deferred<void>;
}

const isLive = (status: RunState["status"]) => status === "starting" || status === "running";

/**
 * A process killed by a signal has no exit code; the spawner fails `exitCode`
 * instead, and names the signal only in the message of the underlying error.
 */
const signalFromExitError = (error: PlatformError.PlatformError) =>
  error.cause instanceof Error
    ? (/signal: '([A-Z0-9]+)'/.exec(error.cause.message)?.[1] ?? null)
    : null;

export interface RunServiceOptions {
  /** How long a stopped run gets to exit after SIGTERM before SIGKILL. */
  readonly stopGrace?: Duration.Input;
}

const make = (options: RunServiceOptions) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runProfiles = yield* RunProfiles.RunProfiles;
    const { stateDir } = yield* ServerConfig.ServerConfig;
    const hostEnv = yield* HostProcessEnvironment;
    const hostPlatform = yield* HostProcessPlatform;
    const stopGrace = options.stopGrace ?? Duration.seconds(5);

    // Run scopes close in parallel at shutdown, so stopping N runs takes one grace period.
    const serviceScope = yield* Scope.fork(yield* Effect.scope, "parallel");
    const receipts = yield* PubSub.unbounded<RunReceipt>();
    const publish = (receipt: RunReceipt) => PubSub.publish(receipts, receipt);
    /** Insertion-ordered; mutated only inside synchronous blocks, so check-and-reserve is atomic. */
    const runs = new Map<string, RunEntry>();
    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

    const forgetOldRuns = (projectId: ProjectId) => {
      const finished = [...runs.entries()].filter(
        ([, entry]) => entry.projectId === projectId && !isLive(entry.state.status),
      );
      for (const [runId] of finished.slice(0, Math.max(0, finished.length - FINISHED_RUNS_KEPT))) {
        runs.delete(runId);
      }
    };

    const childEnv = (allowList: ReadonlyArray<string>) => {
      const env: Record<string, string> = {};
      for (const name of [...BASE_ENV, ...allowList]) {
        const value = hostEnv[name];
        if (value !== undefined) env[name] = value;
      }
      return env;
    };

    const appendTail = (entry: RunEntry, text: string) =>
      Effect.sync(() => {
        const logTail = `${entry.state.logTail}${text}`.slice(-LOG_TAIL_CHARS);
        entry.state = { ...entry.state, logTail };
      });

    /** Waits for the process, records how it ended, then releases its pipes and log file. */
    const watch = (
      entry: RunEntry,
      handle: ChildProcessSpawner.ChildProcessHandle,
      logFile: FileSystem.File,
      runScope: Scope.Closeable,
    ) =>
      Effect.gen(function* () {
        const { projectId } = entry;
        const { runId } = entry.state;
        const decoder = new TextDecoder();
        const drain = yield* handle.all.pipe(
          Stream.runForEach((chunk) =>
            // A failed write must not stop the drain: a full pipe would block the game.
            logFile
              .writeAll(chunk)
              .pipe(
                Effect.ignore,
                Effect.andThen(appendTail(entry, decoder.decode(chunk, { stream: true }))),
                Effect.andThen(
                  publish({ _tag: "logAppended", projectId, runId, bytes: chunk.byteLength }),
                ),
              ),
          ),
          Effect.ignore,
          Effect.forkIn(runScope),
        );
        const exit = yield* handle.exitCode.pipe(Effect.result);
        // Output written just before exit may still be in the pipes.
        yield* Fiber.await(drain).pipe(Effect.timeoutOption(DRAIN_AFTER_EXIT));
        yield* Scope.close(runScope, Exit.void);

        const exitCode = exit._tag === "Success" ? Number(exit.success) : null;
        const signal = exit._tag === "Failure" ? signalFromExitError(exit.failure) : null;
        const status = entry.stopRequested ? "stopped" : "exited";
        const endedAt = yield* nowIso;
        yield* Effect.sync(() => {
          entry.state = { ...entry.state, status, exitCode, signal, endedAt };
          entry.handle = null;
          forgetOldRuns(projectId);
        });
        yield* publish({ _tag: status, projectId, runId, exitCode, signal });
        yield* Deferred.done(entry.finished, Exit.void);
      });

    const launch = Effect.fn("RunService.launch")(function* (
      entry: RunEntry,
      plan: RunProfiles.LaunchPlan,
    ) {
      const { projectId } = entry;
      const { runId } = entry.state;
      const runScope = yield* Scope.fork(serviceScope);
      const spawned = yield* Effect.gen(function* () {
        const runDir = path.join(stateDir, "runs", encodeURIComponent(projectId), runId);
        yield* fileSystem.makeDirectory(runDir, { recursive: true });
        for (const output of plan.outputs) {
          yield* fileSystem.makeDirectory(path.dirname(output.absPath), { recursive: true });
        }
        const logFile = yield* fileSystem.open(path.join(runDir, "run.log"), { flag: "a" });
        const handle = yield* spawner.spawn(
          ChildProcess.make(plan.absExecutable, [...plan.args], {
            cwd: plan.absCwd,
            env: childEnv(plan.envAllowList),
            extendEnv: false,
            shell: false,
            // Its own process group, so stop reaches whatever the game spawns.
            detached: hostPlatform !== "win32",
            stdin: "ignore",
            // Used by the spawner when the run scope closes at shutdown.
            killSignal: "SIGTERM",
            forceKillAfter: stopGrace,
          }),
        );
        return { handle, logFile };
      }).pipe(Effect.provideService(Scope.Scope, runScope), Effect.result);

      if (spawned._tag === "Failure") {
        yield* Scope.close(runScope, Exit.void);
        const error = new RunLaunchFailed({
          profileId: plan.profileId,
          detail: spawned.failure.message,
        });
        const endedAt = yield* nowIso;
        yield* Effect.sync(() => {
          entry.state = { ...entry.state, status: "launchFailed", error: error.message, endedAt };
          forgetOldRuns(projectId);
        });
        yield* publish({ _tag: "launchFailed", projectId, runId, message: error.message });
        yield* Deferred.done(entry.finished, Exit.void);
        yield* Deferred.done(entry.launched, Exit.void);
        return yield* error;
      }

      const { handle, logFile } = spawned.success;
      const pid = Number(handle.pid);
      yield* Effect.sync(() => {
        entry.handle = handle;
        entry.state = { ...entry.state, status: "running", pid };
      });
      yield* publish({ _tag: "started", projectId, runId, pid });
      yield* watch(entry, handle, logFile, runScope).pipe(Effect.forkIn(serviceScope));
      yield* Deferred.done(entry.launched, Exit.void);
      return entry.state;
    });

    const start: RunService["Service"]["start"] = Effect.fn("RunService.start")(function* (input) {
      const plan = yield* runProfiles.resolve(input.workspaceRoot, input.profileId);
      const runId = NodeCrypto.randomUUID();
      const startedAt = yield* nowIso;
      const launched = yield* Deferred.make<void>();
      const finished = yield* Deferred.make<void>();
      const reservation = yield* Effect.sync(() => {
        for (const entry of runs.values()) {
          if (
            entry.projectId === input.projectId &&
            entry.state.profileId === plan.profileId &&
            isLive(entry.state.status)
          ) {
            return { _tag: "existing", entry } as const;
          }
        }
        const entry: RunEntry = {
          projectId: input.projectId,
          state: {
            runId,
            profileId: plan.profileId,
            threadId: input.threadId,
            status: "starting",
            pid: null,
            exitCode: null,
            signal: null,
            error: null,
            startedAt,
            endedAt: null,
            logTail: "",
          },
          handle: null,
          stopRequested: false,
          launched,
          finished,
        };
        runs.set(runId, entry);
        return { _tag: "reserved", entry } as const;
      });
      if (reservation._tag === "existing") {
        return { run: reservation.entry.state, alreadyRunning: true };
      }
      // Uninterruptible: a caller that goes away mid-launch must not strand a reserved slot.
      const run = yield* Effect.uninterruptible(launch(reservation.entry, plan));
      return { run, alreadyRunning: false };
    });

    const stop: RunService["Service"]["stop"] = Effect.fn("RunService.stop")(function* (input) {
      const entry = runs.get(input.runId);
      if (entry === undefined || entry.projectId !== input.projectId) {
        return yield* new RunNotOwned({ runId: input.runId });
      }
      yield* Deferred.await(entry.launched);
      const handle = entry.handle;
      if (handle !== null) {
        entry.stopRequested = true;
        // Signals the process group captured at spawn: SIGTERM, then SIGKILL after the grace.
        yield* handle.kill({ killSignal: "SIGTERM", forceKillAfter: stopGrace }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("project runtime: stop signal failed", {
              runId: input.runId,
              error,
            }),
          ),
        );
      }
      yield* Deferred.await(entry.finished);
      return entry.state;
    });

    const status: RunService["Service"]["status"] = Effect.fn("RunService.status")(
      function* (input) {
        const loaded = yield* runProfiles.load(input.workspaceRoot).pipe(Effect.result);
        const projectRuns = [...runs.values()]
          .filter((entry) => entry.projectId === input.projectId)
          .map((entry) => entry.state)
          .toReversed();
        return {
          profiles:
            loaded._tag === "Success"
              ? loaded.success.map(({ profile, valid, issues }) => ({
                  id: profile.id,
                  name: profile.name,
                  valid,
                  issues,
                }))
              : [],
          profilesError: loaded._tag === "Failure" ? loaded.failure.message : null,
          runs: projectRuns,
        };
      },
    );

    const subscribeReceipts = PubSub.subscribe(receipts).pipe(Effect.map(Stream.fromSubscription));

    return RunService.of({ start, stop, status, subscribeReceipts });
  });

export const layerWithOptions = (options: RunServiceOptions) =>
  Layer.effect(RunService, make(options));

export const layer = layerWithOptions({});
