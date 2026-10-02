// @effect-diagnostics nodeBuiltinImport:off
/**
 * RunEvidence - records what each finished run of an evidence profile showed,
 * and reads it back with its freshness.
 *
 * The registry is a DevGame-owned, versioned JSON file in the server's state
 * directory (`<stateDir>/runs/<projectId>/evidence.json`), next to the run
 * logs. Nothing is written to the project: `workspace/workspace.json` is never
 * touched, and a record links to a workspace card only by the id its profile
 * names. Every update is a read, append and atomic rename under one lock, and
 * registering a run id that is already recorded returns the existing record.
 *
 * Provenance is captured at launch, before the program can change anything:
 * the project's `git rev-parse HEAD` and whether its tree had changes, and the
 * build's size, mtime and sha256. Whatever cannot be established is recorded
 * as `"unknown"`, never guessed. Freshness is never stored: each read compares
 * the recorded HEAD and build hash with the current ones.
 *
 * @module RunEvidence
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import {
  RUN_EVIDENCE_SCHEMA,
  RunEvidenceRecord,
  type ProjectId,
  type RunBuildProvenance,
  type RunEvidenceArtifact,
  type RunEvidenceLog,
  type RunEvidenceLogCheck,
  type RunEvidenceView,
  type RunSourceProvenance,
  type ThreadId,
} from "@t3tools/contracts";
import { fromJsonStringPretty, fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import type * as RunProfiles from "./RunProfiles.ts";

const RegistryFile = Schema.Struct({
  version: Schema.Literal(1),
  runs: Schema.Array(RunEvidenceRecord),
});
type RegistryFile = typeof RegistryFile.Type;
const decodeRegistryJson = Schema.decodeUnknownEffect(fromLenientJson(RegistryFile));
const encodeRegistryJson = Schema.encodeEffect(fromJsonStringPretty(RegistryFile));

/** The registry exists but is not a version-1 evidence file. It is left as is, never overwritten. */
export class RunEvidenceRegistryUnreadable extends Schema.TaggedError<RunEvidenceRegistryUnreadable>()(
  "RunEvidenceRegistryUnreadable",
  { registryPath: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `The run evidence registry at ${this.registryPath} could not be read.`;
  }
}

export class RunEvidenceWriteError extends Schema.TaggedError<RunEvidenceWriteError>()(
  "RunEvidenceWriteError",
  { registryPath: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not write the run evidence registry at ${this.registryPath}.`;
  }
}

/** What a run used, captured just before it was spawned. */
export interface LaunchProvenance {
  readonly source: RunSourceProvenance;
  readonly build: RunBuildProvenance;
}

export interface RegisterInput {
  readonly projectId: ProjectId;
  readonly runId: string;
  readonly profileId: string;
  readonly threadId: ThreadId | null;
  readonly workspaceCard: RunProfiles.LaunchPlan["workspaceCard"];
  readonly launch: LaunchProvenance;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly runStatus: "exited" | "stopped";
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly logPath: string;
  /** Bytes the runner received from the program, to tell a truncated log file. */
  readonly logBytesReceived: number;
  readonly outputs: ReadonlyArray<RunProfiles.BoundOutput>;
  readonly logPatterns: ReadonlyArray<string>;
}

export class RunEvidence extends Context.Service<
  RunEvidence,
  {
    /** Source and build provenance of a project right now. Never fails: unknown stays `"unknown"`. */
    readonly captureLaunch: (input: {
      readonly workspaceRoot: string;
      readonly build: RunProfiles.LaunchPlan["build"];
    }) => Effect.Effect<LaunchProvenance>;
    /**
     * Check a finished run's log and outputs and record the result. A run id
     * already in the registry is returned as recorded, and nothing is written.
     */
    readonly register: (
      input: RegisterInput,
    ) => Effect.Effect<RunEvidenceRecord, RunEvidenceRegistryUnreadable | RunEvidenceWriteError>;
    /** The newest record per profile, newest first, each with its freshness as of now. */
    readonly latest: (input: {
      readonly projectId: ProjectId;
      readonly workspaceRoot: string;
    }) => Effect.Effect<ReadonlyArray<RunEvidenceView>, RunEvidenceRegistryUnreadable>;
  }
>()("t3/projectRuntime/RunEvidence") {}

/** Records kept per project; the oldest are dropped first. */
const RECORDS_KEPT = 200;
/** Profiles shown with their latest record. */
const LATEST_SHOWN = 20;
/** Only the end of a longer log is searched for `logPatterns`. */
const LOG_SCAN_BYTES = 8 * 1024 * 1024;
/** An output older than the run's start by more than this was not written by it. */
const MTIME_SLACK_MS = 1_000;
const HEX_REVISION = /^[0-9a-f]{40,64}$/;

/**
 * The literal text a pattern starts with, e.g. `VFX capture probe:` for
 * `VFX capture probe:.*effect age 0\.65(,|$)`. Used to find the line a pattern
 * is about, so a wrong value is reported as a mismatch with that line.
 */
const literalPrefix = (pattern: string) => {
  let prefix = "";
  for (let index = pattern.startsWith("^") ? 1 : 0; index < pattern.length; index++) {
    const char = pattern[index]!;
    if (char === "\\") {
      const next = pattern[index + 1];
      if (next === undefined || /[A-Za-z0-9]/.test(next)) break;
      prefix += next;
      index++;
    } else if ("$.*+?()[]{}|".includes(char)) {
      break;
    } else {
      prefix += char;
    }
  }
  return prefix;
};

/** One pattern against the log's lines, following the last line that starts like it. */
const checkPattern = (
  pattern: string,
  lines: ReadonlyArray<string> | null,
): RunEvidenceLogCheck => {
  if (lines === null) return { pattern, status: "log-unavailable", line: null };
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch {
    return { pattern, status: "missing", line: null };
  }
  const prefix = literalPrefix(pattern);
  if (prefix.trim().length >= 3) {
    const line = lines.findLast((candidate) => candidate.includes(prefix)) ?? null;
    if (line === null) return { pattern, status: "missing", line: null };
    return { pattern, status: regex.test(line) ? "matched" : "mismatch", line };
  }
  const line = lines.findLast((candidate) => regex.test(candidate)) ?? null;
  return { pattern, status: line === null ? "missing" : "matched", line };
};

const sha256File = (absPath: string) =>
  Effect.tryPromise(
    () =>
      new Promise<string>((resolve, reject) => {
        const hash = NodeCrypto.createHash("sha256");
        NodeFS.createReadStream(absPath)
          .on("error", reject)
          .on("data", (chunk) => hash.update(chunk))
          .on("end", () => resolve(hash.digest("hex")));
      }),
  );

/** The last `LOG_SCAN_BYTES` of a file as text. */
const readTail = (absPath: string, bytes: number) =>
  Effect.tryPromise(async () => {
    const handle = await NodeFSP.open(absPath, "r");
    try {
      const length = Math.min(bytes, LOG_SCAN_BYTES);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, bytes - length);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  });

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  // One writer at a time: every update is read, append, rename.
  const registryLock = yield* Semaphore.make(1);
  /** sha256 by path, size and mtime, so a status read does not rehash an unchanged build. */
  const hashCache = new Map<string, { readonly key: string; readonly sha256: string }>();

  const registryPath = (projectId: ProjectId) =>
    path.join(stateDir, "runs", encodeURIComponent(projectId), "evidence.json");

  const statFile = (absPath: string) =>
    fileSystem.stat(absPath).pipe(
      Effect.map((info) => ({
        isFile: info.type === "File",
        bytes: Number(info.size),
        mtime: Option.getOrNull(info.mtime),
      })),
      Effect.option,
      Effect.map(Option.getOrNull),
    );

  const fingerprint = Effect.fn("RunEvidence.fingerprint")(function* (absPath: string) {
    const stat = yield* statFile(absPath);
    if (stat === null || !stat.isFile) return null;
    const key = `${stat.bytes}:${stat.mtime?.getTime() ?? "none"}`;
    const cached = hashCache.get(absPath);
    if (cached?.key === key) return { bytes: stat.bytes, mtime: stat.mtime, sha256: cached.sha256 };
    const hashed = yield* sha256File(absPath).pipe(Effect.option);
    if (Option.isNone(hashed)) return null;
    hashCache.set(absPath, { key, sha256: hashed.value });
    return { bytes: stat.bytes, mtime: stat.mtime, sha256: hashed.value };
  });

  const gitOutput = (cwd: string, operation: string, args: ReadonlyArray<string>) =>
    git
      .execute({
        operation,
        cwd,
        args,
        allowNonZeroExit: true,
        timeoutMs: 10_000,
        maxOutputBytes: 64 * 1024,
      })
      .pipe(
        Effect.map((result) => (result.exitCode === 0 ? result.stdout : null)),
        Effect.orElseSucceed(() => null),
      );

  const currentRevision = (workspaceRoot: string) =>
    gitOutput(workspaceRoot, "RunEvidence.revision", ["rev-parse", "HEAD"]).pipe(
      Effect.map((stdout) => {
        const revision = stdout?.trim() ?? "";
        return HEX_REVISION.test(revision) ? revision : ("unknown" as const);
      }),
    );

  const captureLaunch: RunEvidence["Service"]["captureLaunch"] = Effect.fn(
    "RunEvidence.captureLaunch",
  )(function* (input) {
    const [revision, status, build] = yield* Effect.all(
      [
        currentRevision(input.workspaceRoot),
        gitOutput(input.workspaceRoot, "RunEvidence.dirty", [
          "--no-optional-locks",
          "status",
          "--porcelain",
        ]),
        fingerprint(input.build.absPath),
      ],
      { concurrency: "unbounded" },
    );
    return {
      source: {
        revision,
        // Without a revision there is no tree to compare against.
        dirty: revision === "unknown" || status === null ? "unknown" : status.trim().length > 0,
      },
      build: {
        path: input.build.path,
        bytes: build?.bytes ?? "unknown",
        mtime: build?.mtime?.toISOString() ?? "unknown",
        sha256: build?.sha256 ?? "unknown",
      },
    };
  });

  const readRegistry = (projectId: ProjectId) =>
    Effect.gen(function* () {
      const file = registryPath(projectId);
      const text = yield* fileSystem.readFileString(file).pipe(Effect.option);
      if (Option.isNone(text)) return { version: 1, runs: [] } satisfies RegistryFile;
      return yield* decodeRegistryJson(text.value).pipe(
        Effect.mapError(
          (cause) => new RunEvidenceRegistryUnreadable({ registryPath: file, cause }),
        ),
      );
    });

  const inspectLog = Effect.fn("RunEvidence.inspectLog")(function* (input: RegisterInput) {
    const stat = yield* statFile(input.logPath);
    if (stat === null || !stat.isFile) {
      const log: RunEvidenceLog = {
        absolutePath: input.logPath,
        exists: false,
        bytes: null,
        bytesReceived: input.logBytesReceived,
        sha256: null,
        problem: "The run log is missing.",
      };
      return { log, lines: null };
    }
    const sha256 = yield* sha256File(input.logPath).pipe(Effect.option);
    const text = yield* readTail(input.logPath, stat.bytes).pipe(Effect.option);
    const log: RunEvidenceLog = {
      absolutePath: input.logPath,
      exists: true,
      bytes: stat.bytes,
      bytesReceived: input.logBytesReceived,
      sha256: Option.getOrNull(sha256),
      problem: Option.isNone(text)
        ? "The run log could not be read."
        : stat.bytes < input.logBytesReceived
          ? `The run log is truncated: it holds ${stat.bytes} of the ${input.logBytesReceived} bytes the program wrote.`
          : null,
    };
    return { log, lines: Option.isNone(text) ? null : text.value.split(/\r?\n/) };
  });

  const inspectOutput = Effect.fn("RunEvidence.inspectOutput")(function* (
    output: RunProfiles.BoundOutput,
    startedAtMs: number,
  ) {
    const stat = yield* statFile(output.absPath);
    const base = {
      name: output.name,
      kind: output.kind,
      location: output.location,
      path: output.relativePath,
      absolutePath: output.absPath,
    };
    if (stat === null) {
      return { ...base, exists: false, bytes: null, sha256: null, problem: "Not found." };
    }
    if (!stat.isFile) {
      return { ...base, exists: true, bytes: null, sha256: null, problem: "Not a file." };
    }
    const sha256 = Option.getOrNull(yield* sha256File(output.absPath).pipe(Effect.option));
    const problem =
      stat.bytes === 0
        ? "Empty (0 bytes)."
        : stat.mtime !== null && stat.mtime.getTime() < startedAtMs - MTIME_SLACK_MS
          ? "Not written by this run: it was last modified before the run started."
          : sha256 === null
            ? "Could not be read."
            : null;
    return { ...base, exists: true, bytes: stat.bytes, sha256, problem };
  });

  const buildRecord = Effect.fn("RunEvidence.buildRecord")(function* (input: RegisterInput) {
    const { log, lines } = yield* inspectLog(input);
    const checks = input.logPatterns.map((pattern) => checkPattern(pattern, lines));
    const startedAtMs = Date.parse(input.startedAt);
    const artifacts: Array<RunEvidenceArtifact> = [];
    for (const output of input.outputs) artifacts.push(yield* inspectOutput(output, startedAtMs));

    const failures: Array<string> = [];
    if (input.runStatus === "stopped") {
      failures.push("The run was stopped before it finished.");
    } else if (input.exitCode !== 0) {
      failures.push(
        input.exitCode !== null
          ? `The program exited with code ${input.exitCode}.`
          : input.signal !== null
            ? `The program was ended by ${input.signal}.`
            : "The program's exit code is unknown.",
      );
    }
    if (log.problem !== null) failures.push(log.problem);
    for (const check of checks) {
      if (check.status === "mismatch") {
        failures.push(`Log line "${check.line}" does not match /${check.pattern}/.`);
      } else if (check.status === "missing" && lines !== null) {
        failures.push(`No log line matches /${check.pattern}/.`);
      }
    }
    for (const artifact of artifacts) {
      if (artifact.problem !== null) {
        failures.push(`Output "${artifact.name}" (${artifact.path}): ${artifact.problem}`);
      }
    }
    const registeredAt = DateTime.formatIso(yield* DateTime.now);
    return {
      schema: RUN_EVIDENCE_SCHEMA,
      runId: input.runId,
      projectId: input.projectId,
      profileId: input.profileId,
      threadId: input.threadId,
      workspaceCard: input.workspaceCard,
      source: input.launch.source,
      build: input.launch.build,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      registeredAt,
      runStatus: input.runStatus,
      exitCode: input.exitCode,
      signal: input.signal,
      log,
      checks,
      artifacts,
      outcome: failures.length === 0 ? "passed" : "failed",
      failures,
    } satisfies RunEvidenceRecord;
  });

  const register: RunEvidence["Service"]["register"] = Effect.fn("RunEvidence.register")(
    function* (input) {
      const file = registryPath(input.projectId);
      const existing = yield* readRegistry(input.projectId).pipe(
        Effect.map((registry) => registry.runs.find((run) => run.runId === input.runId)),
      );
      if (existing !== undefined) return existing;
      // Hashing outputs happens outside the lock; the append re-checks under it.
      const record = yield* buildRecord(input);
      return yield* registryLock.withPermits(1)(
        Effect.gen(function* () {
          const registry = yield* readRegistry(input.projectId);
          const recorded = registry.runs.find((run) => run.runId === input.runId);
          if (recorded !== undefined) return recorded;
          const runs = [...registry.runs, record].slice(-RECORDS_KEPT);
          yield* encodeRegistryJson({ version: 1, runs }).pipe(
            Effect.flatMap((contents) =>
              writeFileStringAtomically({ filePath: file, contents: `${contents}\n` }),
            ),
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
            Effect.mapError((cause) => new RunEvidenceWriteError({ registryPath: file, cause })),
          );
          return record;
        }),
      );
    },
  );

  const freshnessOf = Effect.fn("RunEvidence.freshnessOf")(function* (
    record: RunEvidenceRecord,
    workspaceRoot: string,
    revisionNow: RunSourceProvenance["revision"],
  ) {
    const stale: Array<string> = [];
    const unknown: Array<string> = [];
    const then = record.source.revision;
    if (then === "unknown") {
      unknown.push("The project's source revision at launch is unknown.");
    } else if (revisionNow === "unknown") {
      unknown.push("The project's current source revision is unknown.");
    } else if (revisionNow !== then) {
      stale.push(
        `Source changed: HEAD is ${revisionNow.slice(0, 12)}, the run used ${then.slice(0, 12)}.`,
      );
    }

    const buildPath = record.build.path;
    const buildNow = yield* workspacePaths
      .resolveRelativePathWithinRoot({ workspaceRoot, relativePath: buildPath })
      .pipe(
        Effect.flatMap((resolved) => fingerprint(resolved.absolutePath)),
        Effect.option,
        Effect.map(Option.getOrNull),
      );
    if (record.build.sha256 === "unknown") {
      unknown.push(`The build ${buildPath} was not fingerprinted at launch.`);
    } else if (buildNow === null) {
      stale.push(`Build changed: ${buildPath} is gone or unreadable now.`);
    } else if (buildNow.sha256 !== record.build.sha256) {
      stale.push(`Build changed: ${buildPath} has a different sha256 than the run used.`);
    }

    return {
      record,
      freshness: stale.length > 0 ? "stale" : unknown.length > 0 ? "unknown" : "fresh",
      freshnessReasons: [...stale, ...unknown],
    } satisfies RunEvidenceView;
  });

  const latest: RunEvidence["Service"]["latest"] = Effect.fn("RunEvidence.latest")(
    function* (input) {
      const registry = yield* readRegistry(input.projectId);
      const newest: Array<RunEvidenceRecord> = [];
      const seen = new Set<string>();
      for (const record of registry.runs.toReversed()) {
        if (seen.has(record.profileId)) continue;
        seen.add(record.profileId);
        newest.push(record);
        if (newest.length === LATEST_SHOWN) break;
      }
      if (newest.length === 0) return [];
      const revisionNow = yield* currentRevision(input.workspaceRoot);
      return yield* Effect.forEach(newest, (record) =>
        freshnessOf(record, input.workspaceRoot, revisionNow),
      );
    },
  );

  return RunEvidence.of({ captureLaunch, register, latest });
});

export const layer = Layer.effect(RunEvidence, make);
