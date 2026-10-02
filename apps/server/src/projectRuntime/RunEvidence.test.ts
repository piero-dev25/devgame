// @effect-diagnostics nodeBuiltinImport:off
/**
 * RunEvidence against real temp projects and git repos, with fake run records:
 * a run directory holding the log and capture a run would leave behind. No
 * game is launched; each case writes the files a Kaigen capture would.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as RunEvidence from "./RunEvidence.ts";

const PROJECT = ProjectId.make("run-evidence-project");
const THREAD = ThreadId.make("run-evidence-thread");
const BUILD = "Runtime/out/macos/debug/kaigen-horde-spike";
const PROBE_PATTERN = "VFX capture probe:.*effect age 0\\.65(,|$)";
const SAVED_PATTERN = "screenshot saved:";
const GOOD_LOG = [
  "VFX capture probe: effect 1 view front, effect age 0.65, particles 412",
  "screenshot saved: /tmp/run/fire-front-t00_65.png",
  "",
].join("\n");
const PNG = "\x89PNG\r\n\x1a\nfake capture bytes";
const WORKSPACE_JSON = `{\n  "entities": [{"id": "fire-front", "title": "Fire", "folder": "fire", "steps": []}],\n  "handAdded": {"keep": true}\n}\n`;

/** A fresh service and state directory per test, so registries never mix. */
const makeTestLayer = () =>
  RunEvidence.layer.pipe(
    Layer.provide(GitVcsDriver.layer.pipe(Layer.provide(VcsProcess.layer))),
    Layer.provide(WorkspacePaths.layer),
    Layer.provideMerge(
      ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-run-evidence-test-" }),
    ),
  );

const sha256 = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
    ].concat(args),
    { cwd, encoding: "utf8" },
  ).trim();

const writeFile = Effect.fn("writeFile")(function* (absolutePath: string, contents: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
  yield* fileSystem.writeFileString(absolutePath, contents);
});

/** A project with a build and a workspace registry, committed when `withGit`. */
const makeProject = Effect.fn("makeProject")(function* (withGit: boolean) {
  const fileSystem = yield* FileSystem.FileSystem;
  const root = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-run-evidence-" }),
  );
  yield* writeFile(`${root}/${BUILD}`, "build v1");
  yield* writeFile(`${root}/workspace/workspace.json`, WORKSPACE_JSON);
  yield* writeFile(`${root}/src/game.c`, "int main() {}\n");
  if (withGit) {
    git(root, "init", "-q");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "initial");
  }
  return root;
});

/** What a finished capture run leaves: run.log and the PNG in its own directory. */
const makeRun = Effect.fn("makeRun")(function* (
  runId: string,
  files: { readonly log?: string | null; readonly png?: string | null },
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const runDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: `t3-run-${runId}-` });
  const log = files.log === undefined ? GOOD_LOG : files.log;
  const png = files.png === undefined ? PNG : files.png;
  if (log !== null) yield* writeFile(`${runDir}/run.log`, log);
  if (png !== null) yield* writeFile(`${runDir}/fire-front-t00_65.png`, png);
  return { runDir, logBytes: log === null ? 0 : Buffer.byteLength(log) };
});

const service = RunEvidence.RunEvidence;

const captureLaunch = (root: string) =>
  Effect.flatMap(service, (evidence) =>
    evidence.captureLaunch({
      workspaceRoot: root,
      build: { path: BUILD, absPath: `${root}/${BUILD}` },
    }),
  );

/** Launch provenance captured now, then a register of a run that ran from `startedAt`. */
const register = Effect.fn("register")(function* (
  root: string,
  runId: string,
  run: { readonly runDir: string; readonly logBytes: number },
  overrides: Partial<RunEvidence.RegisterInput> = {},
) {
  const evidence = yield* service;
  const launch = overrides.launch ?? (yield* captureLaunch(root));
  const now = yield* DateTime.now;
  return yield* evidence.register({
    projectId: PROJECT,
    runId,
    profileId: "capture-fire-front-0.65",
    threadId: THREAD,
    workspaceCard: { entityId: "fire-front", stepPath: null },
    launch,
    startedAt: DateTime.formatIso(DateTime.subtract(now, { seconds: 5 })),
    endedAt: DateTime.formatIso(now),
    runStatus: "exited",
    exitCode: 0,
    signal: null,
    logPath: `${run.runDir}/run.log`,
    logBytesReceived: run.logBytes,
    outputs: [
      {
        name: "capture",
        kind: "image",
        path: "{{runDir}}/fire-front-t00_65.png",
        location: "run",
        relativePath: "fire-front-t00_65.png",
        absPath: `${run.runDir}/fire-front-t00_65.png`,
      },
    ],
    logPatterns: [PROBE_PATTERN, SAVED_PATTERN],
    ...overrides,
  });
});

const latest = (root: string) =>
  Effect.flatMap(service, (evidence) =>
    evidence.latest({ projectId: PROJECT, workspaceRoot: root }),
  );

const decodeRegistrySummary = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      version: Schema.Literal(1),
      runs: Schema.Array(Schema.Struct({ runId: Schema.String })),
    }),
  ),
);

const registryDir = Effect.map(
  ServerConfig.ServerConfig,
  ({ stateDir }) => `${stateDir}/runs/${encodeURIComponent(PROJECT)}`,
);

const readRegistry = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const text = yield* fileSystem.readFileString(`${yield* registryDir}/evidence.json`);
  return decodeRegistrySummary(text);
});

/** Every project file and its contents, to prove registering writes nothing there. */
const snapshotProject = Effect.fn("snapshotProject")(function* (root: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const files = (yield* fileSystem.readDirectory(root, { recursive: true }))
    .filter((entry) => !entry.startsWith(".git"))
    .toSorted();
  const contents: Record<string, string> = {};
  for (const file of files) {
    const info = yield* fileSystem.stat(`${root}/${file}`);
    if (info.type === "File") contents[file] = yield* fileSystem.readFileString(`${root}/${file}`);
  }
  return contents;
});

it.layer(NodeServices.layer, { excludeTestServices: true })("RunEvidence", (it) => {
  describe("register", () => {
    it.effect("records provenance, checks and hashed artifacts without touching the project", () =>
      Effect.gen(function* () {
        const root = yield* makeProject(true);
        const before = yield* snapshotProject(root);
        const run = yield* makeRun("happy", {});

        const record = yield* register(root, "run-happy", run);

        expect(record).toMatchObject({
          schema: "devgame.run-evidence/1",
          runId: "run-happy",
          projectId: PROJECT,
          profileId: "capture-fire-front-0.65",
          threadId: THREAD,
          workspaceCard: { entityId: "fire-front", stepPath: null },
          source: { revision: git(root, "rev-parse", "HEAD"), dirty: false },
          build: { path: BUILD, bytes: 8, sha256: sha256("build v1") },
          runStatus: "exited",
          exitCode: 0,
          outcome: "passed",
          failures: [],
        });
        expect(Date.parse(String(record.build.mtime))).not.toBeNaN();
        expect(record.checks).toEqual([
          { pattern: PROBE_PATTERN, status: "matched", line: GOOD_LOG.split("\n")[0] },
          { pattern: SAVED_PATTERN, status: "matched", line: GOOD_LOG.split("\n")[1] },
        ]);
        expect(record.log).toMatchObject({
          exists: true,
          bytes: run.logBytes,
          sha256: sha256(GOOD_LOG),
          problem: null,
        });
        expect(record.artifacts).toEqual([
          {
            name: "capture",
            kind: "image",
            location: "run",
            path: "fire-front-t00_65.png",
            absolutePath: `${run.runDir}/fire-front-t00_65.png`,
            exists: true,
            bytes: Buffer.byteLength(PNG),
            sha256: sha256(PNG),
            problem: null,
          },
        ]);
        expect((yield* readRegistry).runs.map((entry) => entry.runId)).toEqual(["run-happy"]);
        // workspace/workspace.json, hand-added keys and all, and every other file are untouched.
        expect(yield* snapshotProject(root)).toEqual(before);

        const [view] = yield* latest(root);
        expect(view).toMatchObject({ freshness: "fresh", freshnessReasons: [] });
        expect(view?.record.runId).toBe("run-happy");
      }).pipe(Effect.provide(makeTestLayer())),
    );

    it.effect("records a missing or empty capture as a failure, never a pass", () =>
      Effect.gen(function* () {
        const root = yield* makeProject(true);

        const missing = yield* register(
          root,
          "run-missing",
          yield* makeRun("missing", { png: null }),
        );
        const empty = yield* register(root, "run-empty", yield* makeRun("empty", { png: "" }));

        expect(missing.outcome).toBe("failed");
        expect(missing.artifacts[0]).toMatchObject({ exists: false, problem: "Not found." });
        expect(missing.failures).toContain('Output "capture" (fire-front-t00_65.png): Not found.');
        expect(empty.outcome).toBe("failed");
        expect(empty.artifacts[0]).toMatchObject({ exists: true, bytes: 0 });
        expect(empty.failures).toContain(
          'Output "capture" (fire-front-t00_65.png): Empty (0 bytes).',
        );
      }).pipe(Effect.provide(makeTestLayer())),
    );

    it.effect("does not count a capture left over from before the run", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* makeProject(true);
        const run = yield* makeRun("leftover", {});
        const anHourAgo = DateTime.toDate(DateTime.subtract(yield* DateTime.now, { hours: 1 }));
        yield* fileSystem.utimes(`${run.runDir}/fire-front-t00_65.png`, anHourAgo, anHourAgo);

        const record = yield* register(root, "run-leftover", run);

        expect(record.outcome).toBe("failed");
        expect(record.artifacts[0]?.problem).toContain("Not written by this run");
      }).pipe(Effect.provide(makeTestLayer())),
    );

    it.effect("fails a wrong capture age with the line the program printed", () =>
      Effect.gen(function* () {
        const root = yield* makeProject(true);
        const wrongAge = GOOD_LOG.replace("effect age 0.65", "effect age 0.50");

        const record = yield* register(root, "run-age", yield* makeRun("age", { log: wrongAge }));
        const noProbe = yield* register(
          root,
          "run-no-probe",
          yield* makeRun("no-probe", { log: "screenshot saved: x.png\n" }),
        );

        expect(record.outcome).toBe("failed");
        expect(record.checks[0]).toEqual({
          pattern: PROBE_PATTERN,
          status: "mismatch",
          line: "VFX capture probe: effect 1 view front, effect age 0.50, particles 412",
        });
        expect(record.failures.join("\n")).toContain("effect age 0.50");
        expect(noProbe.checks[0]).toEqual({
          pattern: PROBE_PATTERN,
          status: "missing",
          line: null,
        });
        expect(noProbe.failures).toContain(`No log line matches /${PROBE_PATTERN}/.`);
      }).pipe(Effect.provide(makeTestLayer())),
    );

    it.effect("records a missing or truncated run log explicitly", () =>
      Effect.gen(function* () {
        const root = yield* makeProject(true);
        const missingRun = yield* makeRun("no-log", { log: null });
        const truncatedRun = yield* makeRun("short-log", {});

        const missing = yield* register(root, "run-no-log", {
          ...missingRun,
          logBytes: 120,
        });
        // The program wrote more than reached the file.
        const truncated = yield* register(root, "run-short-log", {
          ...truncatedRun,
          logBytes: truncatedRun.logBytes + 4_096,
        });

        expect(missing.outcome).toBe("failed");
        expect(missing.log).toMatchObject({ exists: false, problem: "The run log is missing." });
        expect(missing.checks.map((check) => check.status)).toEqual([
          "log-unavailable",
          "log-unavailable",
        ]);
        expect(truncated.outcome).toBe("failed");
        expect(truncated.log.problem).toContain("truncated");
        expect(truncated.failures).toContain(truncated.log.problem);
      }).pipe(Effect.provide(makeTestLayer())),
    );

    it.effect("fails a run that exited non-zero or was stopped", () =>
      Effect.gen(function* () {
        const root = yield* makeProject(true);

        const crashed = yield* register(root, "run-crash", yield* makeRun("crash", {}), {
          exitCode: 1,
        });
        const stopped = yield* register(root, "run-stop", yield* makeRun("stop", {}), {
          runStatus: "stopped",
          exitCode: null,
          signal: "SIGTERM",
        });

        expect(crashed.failures).toEqual(["The program exited with code 1."]);
        expect(stopped.failures).toEqual(["The run was stopped before it finished."]);
      }).pipe(Effect.provide(makeTestLayer())),
    );

    it.effect("registers the same run once, however often it is registered", () =>
      Effect.gen(function* () {
        const root = yield* makeProject(true);
        const run = yield* makeRun("twice", {});

        const [first, second] = yield* Effect.all(
          [register(root, "run-twice", run), register(root, "run-twice", run)],
          { concurrency: "unbounded" },
        );
        const third = yield* register(root, "run-twice", run, { exitCode: 9 });

        expect(second).toEqual(first);
        expect(third).toEqual(first);
        expect((yield* readRegistry).runs.map((entry) => entry.runId)).toEqual(["run-twice"]);
      }).pipe(Effect.provide(makeTestLayer())),
    );

    it.effect("lands concurrent registers of different runs and leaves no temp files", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* makeProject(true);
        const runIds = ["run-a", "run-b", "run-c", "run-d"];
        const runs = yield* Effect.forEach(runIds, (runId) => makeRun(runId, {}));

        yield* Effect.forEach(runIds, (runId, index) => register(root, runId, runs[index]!), {
          concurrency: "unbounded",
        });

        expect((yield* readRegistry).runs.map((entry) => entry.runId).toSorted()).toEqual(runIds);
        expect(yield* fileSystem.readDirectory(yield* registryDir)).toEqual(["evidence.json"]);
      }).pipe(Effect.provide(makeTestLayer())),
    );

    it.effect("never overwrites a registry it cannot read", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* makeProject(true);
        const file = `${yield* registryDir}/evidence.json`;
        yield* writeFile(file, '{"version": 7, "notOurs": true}');

        const error = yield* register(root, "run-x", yield* makeRun("x", {})).pipe(Effect.flip);

        expect(error._tag).toBe("RunEvidenceRegistryUnreadable");
        expect(yield* fileSystem.readFileString(file)).toBe('{"version": 7, "notOurs": true}');
      }).pipe(Effect.provide(makeTestLayer())),
    );
  });

  describe("provenance and freshness", () => {
    it.effect("records a dirty tree at launch as dirty, not as HEAD", () =>
      Effect.gen(function* () {
        const root = yield* makeProject(true);
        yield* writeFile(`${root}/src/game.c`, "int main() { return 1; }\n");

        const launch = yield* captureLaunch(root);

        expect(launch.source).toEqual({ revision: git(root, "rev-parse", "HEAD"), dirty: true });
      }).pipe(Effect.provide(makeTestLayer())),
    );

    it.effect("marks evidence stale after a new commit or a changed build", () =>
      Effect.gen(function* () {
        const root = yield* makeProject(true);
        yield* register(root, "run-old", yield* makeRun("old", {}));
        const recordedHead = git(root, "rev-parse", "HEAD");

        yield* writeFile(`${root}/src/game.c`, "int main() { return 2; }\n");
        git(root, "commit", "-q", "-am", "change");
        const afterCommit = (yield* latest(root))[0];
        git(root, "reset", "-q", "--hard", recordedHead);
        expect((yield* latest(root))[0]?.freshness).toBe("fresh");
        yield* writeFile(`${root}/${BUILD}`, "build v2, relinked");
        const afterRebuild = (yield* latest(root))[0];

        expect(afterCommit?.freshness).toBe("stale");
        expect(afterCommit?.freshnessReasons.join(" ")).toContain("Source changed");
        expect(afterRebuild?.freshness).toBe("stale");
        expect(afterRebuild?.freshnessReasons).toEqual([
          `Build changed: ${BUILD} has a different sha256 than the run used.`,
        ]);
      }).pipe(Effect.provide(makeTestLayer())),
    );

    it.effect("keeps provenance it cannot establish as 'unknown', never a guess", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* makeProject(false);
        yield* fileSystem.remove(`${root}/${BUILD}`);

        const record = yield* register(root, "run-unknown", yield* makeRun("unknown", {}));
        const [view] = yield* latest(root);

        expect(record.source).toEqual({ revision: "unknown", dirty: "unknown" });
        expect(record.build).toEqual({
          path: BUILD,
          bytes: "unknown",
          mtime: "unknown",
          sha256: "unknown",
        });
        expect(view?.freshness).toBe("unknown");
        expect(view?.freshnessReasons).toHaveLength(2);
      }).pipe(Effect.provide(makeTestLayer())),
    );

    it.effect("shows the newest record of each profile, newest first", () =>
      Effect.gen(function* () {
        const root = yield* makeProject(true);
        yield* register(root, "run-1", yield* makeRun("1", {}));
        yield* register(root, "run-2", yield* makeRun("2", {}), { profileId: "arena" });
        yield* register(root, "run-3", yield* makeRun("3", {}));

        const views = yield* latest(root);

        expect(views.map((view) => view.record.runId)).toEqual(["run-3", "run-2"]);
      }).pipe(Effect.provide(makeTestLayer())),
    );
  });
});
