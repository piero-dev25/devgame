// @effect-diagnostics nodeBuiltinImport:off
/**
 * LIVE: the whole DevGame runtime loop against a real game project, through
 * the same RunProfiles, RunEvidence and RunService layers the server wires.
 * Profiles are read and validated, launch provenance is captured, the profile
 * is started, the test waits on the run's final receipt (never on time), the
 * run's evidence is registered and read back with its freshness, and one JSON
 * summary line (`"kind":"kaigen-live-run"`) is written to stdout.
 *
 * GATED OFF by default: it launches the real game. Run explicitly, from apps/server:
 *   DEVGAME_KAIGEN_LIVE=1 KAIGEN_PROJECT_ROOT=/abs/game/root \
 *   KAIGEN_PROFILE_ID=<profile> [KAIGEN_CARD_ID=<card>] [KAIGEN_STATE_DIR=/abs/dir] \
 *   pnpm exec vp test run src/projectRuntime/KaigenRunLoop.live.test.ts
 * KAIGEN_CARD_ID, when set, must be the profile's `evidence.workspaceCard`.
 *
 * Never builds or installs anything (RunService only spawns the profile's
 * existing executable). Never writes into the game project: the profile must
 * keep every output in its run directory (`{{runDir}}/...`), which lives under
 * this test's own temporary state directory, not ~/.t3.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as RunEvidence from "./RunEvidence.ts";
import * as RunProfiles from "./RunProfiles.ts";
import * as RunService from "./RunService.ts";

const liveEnabled = process.env.DEVGAME_KAIGEN_LIVE === "1";
const PROJECT = ProjectId.make("kaigen-live");
/** How long the game may run before the test gives up and the layer stops it. */
const RUN_DEADLINE = Duration.minutes(3);
const LOG_TAIL_LINES = 20;

const WorkspaceEntriesLayer = WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer));

const RunProfilesLayer = RunProfiles.layer.pipe(
  Layer.provide(
    WorkspaceFileSystem.layer.pipe(
      Layer.provide(WorkspacePaths.layer),
      Layer.provide(WorkspaceEntriesLayer),
    ),
  ),
  Layer.provide(WorkspacePaths.layer),
  Layer.provide(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
);

const RunEvidenceLayer = RunEvidence.layer.pipe(
  Layer.provide(GitVcsDriver.layer.pipe(Layer.provide(VcsProcess.layer))),
  Layer.provide(WorkspacePaths.layer),
);

/**
 * The real layers, composed as RunService.test.ts composes them, with the
 * host's real environment. The test reads the same RunProfiles and
 * RunEvidence instances RunService uses.
 */
const makeLiveLayer = () =>
  RunService.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(RunProfilesLayer, RunEvidenceLayer)),
    // The run is started without a thread, so the thread lookup is never reached.
    Layer.provide(Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({})),
  );

/**
 * KAIGEN_STATE_DIR (absolute, outside ~/.t3) keeps the run's log, capture and
 * evidence after the test ends, for review. Without it the state is temporary.
 */
const persistentStateDir = process.env.KAIGEN_STATE_DIR?.trim() || null;

const TestLayer = ServerConfig.ServerConfig.layerTest(
  process.cwd(),
  persistentStateDir ?? { prefix: "t3-kaigen-live-" },
).pipe(Layer.provideMerge(NodeServices.layer));

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

/** One JSON line on stdout, outside vitest's console capture, for the caller to grep. */
const printLine = (value: unknown) =>
  encodeJson(value).pipe(
    Effect.orDie,
    Effect.flatMap((line) => Effect.sync(() => process.stdout.write(`${line}\n`))),
  );

const requiredEnv = (name: string) => {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`${name} must be set.`);
  return value;
};

it.layer(TestLayer, { excludeTestServices: true })("Kaigen run loop (LIVE)", (it) => {
  describe("real game project", () => {
    it.effect.skipIf(!liveEnabled)(
      "launches a profile, waits for its exit, and records passing evidence",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { stateDir } = yield* ServerConfig.ServerConfig;
          const runProfiles = yield* RunProfiles.RunProfiles;
          const runEvidence = yield* RunEvidence.RunEvidence;
          const service = yield* RunService.RunService;

          const workspaceRoot = requiredEnv("KAIGEN_PROJECT_ROOT");
          const profileId = requiredEnv("KAIGEN_PROFILE_ID");
          const cardId = process.env.KAIGEN_CARD_ID?.trim() || null;
          expect(path.isAbsolute(workspaceRoot)).toBe(true);
          // The state directory is this test's own temp directory, never the live install.
          expect(stateDir.startsWith(path.join(process.env.HOME ?? "/nonexistent", ".t3"))).toBe(
            false,
          );

          // 1. Read and validate the project's profiles.
          const profiles = yield* runProfiles.load(workspaceRoot);
          const status = profiles.find((entry) => entry.profile.id === profileId);
          expect(status, `profile "${profileId}" is in devgame.runtime.json`).toBeDefined();
          expect(status?.issues ?? []).toEqual([]);
          const plan = yield* runProfiles.resolve(workspaceRoot, profileId);
          // Guards checked before anything is launched.
          expect(plan.recordsEvidence, "the profile records evidence").toBe(true);
          expect(
            plan.outputs.filter((output) => output.location !== "run").map((output) => output.path),
            "every output goes to {{runDir}}, never into the game project",
          ).toEqual([]);
          if (cardId !== null) {
            expect(plan.workspaceCard?.entityId, "the profile's workspace card").toBe(cardId);
          }

          // 2. Provenance before the program runs.
          const preLaunch = yield* runEvidence.captureLaunch({ workspaceRoot, build: plan.build });

          // 3. Start through RunService, subscribed first so no receipt is missed.
          const receipts = yield* service.subscribeReceipts;
          const t0 = yield* Clock.currentTimeMillis;
          const started = yield* service
            .start({ projectId: PROJECT, workspaceRoot, profileId, threadId: null })
            .pipe(Effect.result);
          const tLaunched = yield* Clock.currentTimeMillis;
          if (started._tag === "Failure") {
            const failure = started.failure;
            const receipt =
              failure._tag === "RunLaunchFailed"
                ? yield* receipts.pipe(
                    Stream.filter((r) => r._tag === "launchFailed"),
                    Stream.runHead,
                    Effect.timeoutOption(Duration.seconds(5)),
                    Effect.map(Option.flatten),
                    Effect.map(Option.getOrNull),
                  )
                : null;
            yield* printLine({
              kind: "kaigen-live-run",
              profileId,
              launchFailed: failure.message,
              receipt,
            });
            return expect.fail(`Launch failed: ${failure.message}`);
          }
          const { run, alreadyRunning } = started.success;
          expect(alreadyRunning).toBe(false);

          // 4. Wait for the run's final receipt, counting the bytes it logged.
          const isFinal = (r: RunService.RunReceipt) =>
            r._tag === "exited" || r._tag === "stopped" || r._tag === "launchFailed";
          const waited = yield* receipts.pipe(
            Stream.filter((r) => r.runId === run.runId),
            Stream.takeUntil(isFinal),
            Stream.runFold(
              () => ({
                logBytes: 0,
                pid: run.pid,
                final: null as RunService.RunReceipt | null,
              }),
              (acc, r) =>
                r._tag === "logAppended"
                  ? { ...acc, logBytes: acc.logBytes + r.bytes }
                  : r._tag === "started"
                    ? { ...acc, pid: r.pid }
                    : isFinal(r)
                      ? { ...acc, final: r }
                      : acc,
            ),
            Effect.timeout(RUN_DEADLINE),
          );
          const tFinal = yield* Clock.currentTimeMillis;
          const final = waited.final;
          expect(final).not.toBeNull();
          const runState = (yield* service.status({ projectId: PROJECT, workspaceRoot })).runs.find(
            (entry) => entry.runId === run.runId,
          );

          // 5. Register the run's evidence. RunService records an evidence
          // profile's run before its exit receipt, so this returns that record.
          const runDir = path.join(stateDir, "runs", encodeURIComponent(PROJECT), run.runId);
          const bound = RunProfiles.bindRunDirectory(plan, runDir);
          const recordedByService = (yield* runEvidence.latest({
            projectId: PROJECT,
            workspaceRoot,
          })).some((view) => view.record.runId === run.runId);
          const record = yield* runEvidence.register({
            projectId: PROJECT,
            workspaceRoot,
            runDir,
            runId: run.runId,
            profileId: plan.profileId,
            threadId: null,
            workspaceCard: plan.workspaceCard,
            launch: preLaunch,
            startedAt: run.startedAt,
            endedAt: runState?.endedAt ?? DateTime.formatIso(yield* DateTime.now),
            runStatus: final?._tag === "stopped" ? "stopped" : "exited",
            exitCode: final !== null && "exitCode" in final ? final.exitCode : null,
            signal: final !== null && "signal" in final ? final.signal : null,
            logPath: path.join(runDir, "run.log"),
            logBytesReceived: waited.logBytes,
            outputs: bound.outputs,
            logPatterns: plan.logPatterns,
          });

          // 6. Read it back with its freshness as of now.
          const views = yield* runEvidence.latest({ projectId: PROJECT, workspaceRoot });
          const view = views.find((entry) => entry.record.runId === run.runId) ?? null;
          const tDone = yield* Clock.currentTimeMillis;

          const logText = yield* fileSystem
            .readFileString(record.log.absolutePath)
            .pipe(Effect.orElseSucceed(() => runState?.logTail ?? ""));
          const logTail = logText.replace(/\n$/, "").split(/\r?\n/).slice(-LOG_TAIL_LINES);

          const summary = {
            kind: "kaigen-live-run",
            projectRoot: workspaceRoot,
            profileId,
            cardId,
            workspaceCard: record.workspaceCard,
            runId: run.runId,
            pid: waited.pid,
            receipt: final?._tag ?? null,
            runStatus: record.runStatus,
            exitCode: record.exitCode,
            signal: record.signal,
            startedAt: record.startedAt,
            endedAt: record.endedAt,
            durationsMs: {
              launch: tLaunched - t0,
              untilFinalReceipt: tFinal - t0,
              run: Date.parse(record.endedAt) - Date.parse(record.startedAt),
              total: tDone - t0,
            },
            runDir,
            log: { ...record.log, tail: logTail },
            artifacts: record.artifacts.map((artifact) => ({
              name: artifact.name,
              kind: artifact.kind,
              path: artifact.absolutePath,
              exists: artifact.exists,
              bytes: artifact.bytes,
              sha256: artifact.sha256,
              problem: artifact.problem,
            })),
            checks: record.checks,
            source: record.source,
            build: record.build,
            preLaunch,
            recordedBy: recordedByService ? "RunService" : "test",
            outcome: record.outcome,
            failures: record.failures,
            freshness: view?.freshness ?? null,
            freshnessReasons: view?.freshnessReasons ?? null,
          };
          yield* printLine(summary);

          expect(final?._tag).toBe("exited");
          expect(record.exitCode).toBe(0);
          expect(record.checks.map((check) => [check.pattern, check.status])).toEqual(
            plan.logPatterns.map((pattern) => [pattern, "matched"]),
          );
          expect(record.artifacts.map((artifact) => artifact.name)).toEqual(
            plan.outputs.map((output) => output.name),
          );
          for (const artifact of record.artifacts) {
            expect(artifact, `output "${artifact.name}"`).toMatchObject({
              exists: true,
              problem: null,
            });
          }
          expect(view).not.toBeNull();
        }).pipe(Effect.provide(makeLiveLayer())),
      Duration.toMillis(RUN_DEADLINE) + 60_000,
    );
  });
});
