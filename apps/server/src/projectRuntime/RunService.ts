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
 * grace). A run lasts as long as its program: when the program exits, with any
 * code, whatever it left in its group is stopped the same way, so nothing
 * outlives the run. Nothing is ever found or killed by name, and after a
 * restart the registry is empty: earlier processes are never adopted.
 *
 * The child's stdout and stderr are drained continuously into
 * `<stateDir>/runs/<projectId>/<runId>/run.log`, with a bounded tail kept in
 * memory. Every lifecycle step publishes a {@link RunReceipt}.
 *
 * A profile with `evidence` or outputs has its provenance captured before the
 * spawn and its run recorded by RunEvidence once it has ended, before the
 * `exited` or `stopped` receipt is published.
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
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as RunEvidence from "./RunEvidence.ts";
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

/** The thread is unknown, or belongs to another project. */
export class RunThreadNotInProject extends Schema.TaggedError<RunThreadNotInProject>()(
  "RunThreadNotInProject",
  { threadId: Schema.String },
) {
  override get message(): string {
    return "Thread not found in this project.";
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
     * `alreadyRunning: true`. A `threadId` must belong to the project. Never
     * builds or installs anything.
     */
    readonly start: (input: {
      readonly projectId: ProjectId;
      readonly workspaceRoot: string;
      readonly profileId: string;
      readonly threadId: ThreadId | null;
    }) => Effect.Effect<
      { readonly run: RunState; readonly alreadyRunning: boolean },
      RunProfiles.RunProfileResolveError | RunLaunchFailed | RunThreadNotInProject
    >;
    /**
     * Stop one of the project's runs and wait until it has exited. Only that
     * run's process group is signalled. A run whose program already exited is
     * returned as is, once whatever it left in its group has been stopped.
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
  /** Bytes received from the program, counted before they are written to the log file. */
  logBytes: number;
}

/** What a run of an evidence profile registers once it has ended. */
interface EvidenceContext {
  readonly launch: RunEvidence.LaunchProvenance;
  readonly plan: RunProfiles.LaunchPlan;
  readonly outputs: ReadonlyArray<RunProfiles.BoundOutput>;
  readonly workspaceRoot: string;
  readonly runDir: string;
  readonly logPath: string;
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
    const runEvidence = yield* RunEvidence.RunEvidence;
    const { stateDir } = yield* ServerConfig.ServerConfig;
    const hostEnv = yield* HostProcessEnvironment;
    const hostPlatform = yield* HostProcessPlatform;
    const snapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    const stopGrace = options.stopGrace ?? Duration.seconds(5);

    // Run scopes close in parallel at shutdown, so stopping N runs takes one grace period.
    const serviceScope = yield* Scope.fork(yield* Effect.scope, "parallel");
    const receipts = yield* PubSub.unbounded<RunReceipt>();
    const publish = (receipt: RunReceipt) => PubSub.publish(receipts, receipt);
    /** Insertion-ordered; mutated only inside synchronous blocks, so check-and-reserve is atomic. */
    const runs = new Map<string, RunEntry>();
    /** The newest failed evidence registration per project, until one succeeds. */
    const registerFailures = new Map<ProjectId, string>();
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

    /**
     * Signals the run's process group and waits until it is empty (SIGTERM, then
     * SIGKILL after the grace). Also ends what a program left behind after it
     * exited; once the group is empty there is nothing to signal.
     */
    const endGroup = (handle: ChildProcessSpawner.ChildProcessHandle) =>
      handle.kill({ killSignal: "SIGTERM", forceKillAfter: stopGrace }).pipe(Effect.ignore);

    /**
     * Waits for the program, records how it ended, ends what it left in its
     * group, then releases the pipes and log file.
     */
    const watch = (
      entry: RunEntry,
      handle: ChildProcessSpawner.ChildProcessHandle,
      logFile: FileSystem.File,
      runScope: Scope.Closeable,
      evidence: EvidenceContext | null,
    ) =>
      Effect.gen(function* () {
        const { projectId } = entry;
        const { runId } = entry.state;
        const decoder = new TextDecoder();
        const drain = yield* handle.all.pipe(
          Stream.runForEach((chunk) =>
            // A failed write must not stop the drain: a full pipe would block the game.
            Effect.sync(() => {
              entry.logBytes += chunk.byteLength;
            }).pipe(
              Effect.andThen(logFile.writeAll(chunk).pipe(Effect.ignore)),
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
        const exitCode = exit._tag === "Success" ? Number(exit.success) : null;
        const signal = exit._tag === "Failure" ? signalFromExitError(exit.failure) : null;
        const status = entry.stopRequested ? "stopped" : "exited";
        const endedAt = yield* nowIso;
        // Recorded as soon as the program is gone: status never shows a dead
        // program as running, and the profile can be launched again.
        yield* Effect.sync(() => {
          entry.state = { ...entry.state, status, exitCode, signal, endedAt };
        });
        // A launcher or a forked helper may still hold the pipes. Stopping it
        // first also lets the drain finish instead of waiting out its timeout.
        yield* endGroup(handle);
        // Output written just before exit may still be in the pipes.
        yield* Fiber.await(drain).pipe(Effect.timeoutOption(DRAIN_AFTER_EXIT));
        yield* Scope.close(runScope, Exit.void);
        yield* Effect.sync(() => {
          entry.handle = null;
          forgetOldRuns(projectId);
        });
        // Before the receipt, so a run's exit receipt means its evidence is recorded.
        if (evidence !== null) {
          yield* runEvidence
            .register({
              projectId,
              workspaceRoot: evidence.workspaceRoot,
              runDir: evidence.runDir,
              runId,
              profileId: entry.state.profileId,
              threadId: entry.state.threadId,
              workspaceCard: evidence.plan.workspaceCard,
              launch: evidence.launch,
              startedAt: entry.state.startedAt,
              endedAt,
              runStatus: status,
              exitCode,
              signal,
              logPath: evidence.logPath,
              logBytesReceived: entry.logBytes,
              outputs: evidence.outputs,
              logPatterns: evidence.plan.logPatterns,
            })
            .pipe(
              Effect.andThen(Effect.sync(() => registerFailures.delete(projectId))),
              Effect.catch((error) =>
                Effect.logWarning("project runtime: run evidence not recorded", {
                  runId,
                  error,
                }).pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      registerFailures.set(
                        projectId,
                        `Evidence of the run that ended at ${endedAt} was not recorded: ${error.message}`,
                      );
                    }),
                  ),
                ),
              ),
            );
        }
        yield* publish({ _tag: status, projectId, runId, exitCode, signal });
        yield* Deferred.done(entry.finished, Exit.void);
      });

    const launch = Effect.fn("RunService.launch")(function* (
      entry: RunEntry,
      plan: RunProfiles.LaunchPlan,
      workspaceRoot: string,
    ) {
      const { projectId } = entry;
      const { runId } = entry.state;
      const runDir = path.join(stateDir, "runs", encodeURIComponent(projectId), runId);
      const logPath = path.join(runDir, "run.log");
      const bound = RunProfiles.bindRunDirectory(plan, runDir);
      // Captured before the program runs, so it describes what the run used.
      const evidence: EvidenceContext | null = plan.recordsEvidence
        ? {
            launch: yield* runEvidence.captureLaunch({ workspaceRoot, build: plan.build }),
            plan,
            outputs: bound.outputs,
            workspaceRoot,
            runDir,
            logPath,
          }
        : null;
      const runScope = yield* Scope.fork(serviceScope);
      const spawned = yield* Effect.gen(function* () {
        yield* fileSystem.makeDirectory(runDir, { recursive: true });
        for (const output of bound.outputs) {
          yield* fileSystem.makeDirectory(path.dirname(output.absPath), { recursive: true });
        }
        const logFile = yield* fileSystem.open(logPath, { flag: "a" });
        const handle = yield* spawner.spawn(
          ChildProcess.make(plan.absExecutable, [...bound.args], {
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
        // Runs before the spawner's own release, which skips the group when the
        // program exited 0. Shutdown during cleanup still ends what it left behind.
        yield* Effect.addFinalizer(() => endGroup(handle));
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
      yield* watch(entry, handle, logFile, runScope, evidence).pipe(Effect.forkIn(serviceScope));
      yield* Deferred.done(entry.launched, Exit.void);
      return entry.state;
    });

    const start: RunService["Service"]["start"] = Effect.fn("RunService.start")(function* (input) {
      if (input.threadId !== null) {
        const threadId = input.threadId;
        const thread = yield* snapshotQuery
          .getThreadCheckpointContext(threadId)
          .pipe(
            Effect.catch((cause) =>
              Effect.logError("project runtime: thread lookup failed", { threadId, cause }).pipe(
                Effect.as(Option.none()),
              ),
            ),
          );
        if (Option.isNone(thread) || thread.value.projectId !== input.projectId) {
          return yield* new RunThreadNotInProject({ threadId });
        }
      }
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
          logBytes: 0,
        };
        runs.set(runId, entry);
        return { _tag: "reserved", entry } as const;
      });
      if (reservation._tag === "existing") {
        return { run: reservation.entry.state, alreadyRunning: true };
      }
      // Uninterruptible: a caller that goes away mid-launch must not strand a reserved slot.
      const run = yield* Effect.uninterruptible(
        launch(reservation.entry, plan, input.workspaceRoot),
      );
      return { run, alreadyRunning: false };
    });

    const stop: RunService["Service"]["stop"] = Effect.fn("RunService.stop")(function* (input) {
      const entry = runs.get(input.runId);
      if (entry === undefined || entry.projectId !== input.projectId) {
        return yield* new RunNotOwned({ runId: input.runId });
      }
      yield* Deferred.await(entry.launched);
      const handle = entry.handle;
      // Once the program has exited, its run is already cleaning up; just wait for it.
      if (handle !== null && isLive(entry.state.status)) {
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
        // An unreadable registry hides evidence, and says so; it never hides the runs.
        const read = yield* runEvidence.latest(input).pipe(Effect.result);
        if (read._tag === "Failure") {
          yield* Effect.logWarning("project runtime: run evidence unreadable", {
            error: read.failure,
          });
        }
        return {
          evidence: read._tag === "Success" ? read.success : [],
          evidenceError:
            read._tag === "Failure"
              ? read.failure.message
              : (registerFailures.get(input.projectId) ?? null),
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
