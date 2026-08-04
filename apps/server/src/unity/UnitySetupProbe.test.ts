/**
 * End-to-end WIRING coverage for `UnitySetupProbe` — does it correctly
 * combine a real filesystem, a real (in-memory) `EditorPresenceRegistry`,
 * and a stubbed `UnityPipelineClient` into the inputs
 * `UnitySetupClassifier.ts`'s `classifyUnitySetup` needs. The exhaustive
 * per-state coverage of the classification RULES themselves lives in
 * `UnitySetupClassifier.test.ts` (a pure function, mutation-tested there) —
 * this file is deliberately narrower: a handful of representative
 * end-to-end cases proving the wiring itself is correct, not a restatement
 * of every branch.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as ServerConfig from "../config.ts";
import * as EditorPresenceRegistry from "../editorPresence/EditorPresenceRegistry.ts";
import * as EngineTypeResolver from "../project/EngineTypeResolver.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as UnityPackageLock from "./UnityPackageLock.ts";
import * as UnityPipelineClient from "./UnityPipelineClient.ts";
import * as UnitySetupProbe from "./UnitySetupProbe.ts";

const writeTextFile = Effect.fn("writeTextFile")(function* (
  cwd: string,
  relativePath: string,
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(cwd, relativePath);
  yield* fileSystem
    .makeDirectory(path.dirname(absolutePath), { recursive: true })
    .pipe(Effect.orDie);
  yield* fileSystem.writeFileString(absolutePath, contents).pipe(Effect.orDie);
});

function stubPipelineClient(
  overrides: Partial<UnityPipelineClient.UnityPipelineClient["Service"]>,
): Layer.Layer<UnityPipelineClient.UnityPipelineClient> {
  return Layer.succeed(
    UnityPipelineClient.UnityPipelineClient,
    UnityPipelineClient.UnityPipelineClient.of({
      isAvailable: () => Effect.succeed(true),
      status: () => Effect.die("unexpected status call"),
      play: () => Effect.die("unexpected play call"),
      stop: () => Effect.die("unexpected stop call"),
      pause: () => Effect.die("unexpected pause call"),
      list: () =>
        Effect.succeed({
          _tag: "ok",
          value: { instances: [], latestVersion: null, unparseableInstanceCount: 0 },
        }),
      ...overrides,
    }),
  );
}

/**
 * Runs a full test BODY against a fresh temp directory (used as this
 * "project"'s workspace root) and the full `UnitySetupProbe` dependency
 * graph. The temp directory is created FIRST, with only `FileSystem`
 * available, because `ServerConfig.layerTest` and a test's own
 * `UnityPipelineClient` stub (which usually needs to echo `cwd` back as
 * `projectPath`) both need the resolved path as a plain string BEFORE they
 * can be constructed — `pipelineClient` and `body` are therefore both
 * FUNCTIONS of `cwd`, not pre-built values. `NodeServices.layer` is
 * provided ONCE at the very end, discharging `FileSystem`/`Path` for BOTH
 * the temp-dir creation below and everything `body` itself needs — this is
 * the fix for a real bug an earlier version of this file had: providing
 * services only around the INNER probe call left `makeTempDirectoryScoped`/
 * `writeTextFile` calls in the test's OUTER scope with no `FileSystem` at
 * all, and every test in this file failed with "Service not found:
 * FileSystem" as a result.
 */
const runProbeTest = <A>(
  pipelineClient: (cwd: string) => Layer.Layer<UnityPipelineClient.UnityPipelineClient>,
  body: (
    cwd: string,
  ) => Effect.Effect<
    A,
    never,
    | FileSystem.FileSystem
    | Path.Path
    | UnityPipelineClient.UnityPipelineClient
    | UnityPackageLock.UnityPackageLock
    | EditorPresenceRegistry.EditorPresenceRegistry
    | EngineTypeResolver.EngineTypeResolver
    | ServerConfig.ServerConfig
  >,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const cwd = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3code-unity-setup-project-",
    });
    return yield* body(cwd).pipe(
      Effect.provide(pipelineClient(cwd)),
      Effect.provide(UnityPackageLock.layer),
      Effect.provide(EditorPresenceRegistry.layer),
      Effect.provide(EngineTypeResolver.layer.pipe(Layer.provide(WorkspacePaths.layer))),
      Effect.provide(ServerConfig.layerTest(cwd, { prefix: "t3code-unity-setup-probe-" })),
    );
  }).pipe(Effect.provide(NodeServices.layer));

const runProbe = Effect.gen(function* () {
  const probe = yield* UnitySetupProbe.make;
  return yield* probe.probe();
});

describe("UnitySetupProbe", () => {
  it.effect("CLI unavailable: S1, and pipeline list is never called", () => {
    let listCalled = false;
    return runProbeTest(
      () =>
        stubPipelineClient({
          isAvailable: () => Effect.succeed(false),
          list: () => {
            listCalled = true;
            return Effect.succeed({
              _tag: "ok",
              value: { instances: [], latestVersion: null, unparseableInstanceCount: 0 },
            });
          },
        }),
      (cwd) =>
        // Isolates `findCliCandidatePath`'s `~/.unity/bin/unity` check from
        // whatever is ACTUALLY at the real HOME on the machine running this
        // suite — a real false positive, not a hypothetical one: the dev
        // machine this file was written on has the Unity CLI installed
        // there for real, which silently turned this into an S2 test
        // instead of S1 until this override was added. `cwd` (this test's
        // own scoped temp dir) is guaranteed to have no `.unity/bin/unity`
        // under it.
        runProbe.pipe(Effect.provideService(HostProcessEnvironment, { HOME: cwd })),
    ).pipe(
      Effect.map((result) => {
        expect(result.primary.state).toBe("S1");
        expect(result.facts.cliAvailable).toBe(false);
        expect(listCalled).toBe(false);
      }),
    );
  });

  it.effect(
    "real end-to-end S4: package missing in a real packages-lock.json, lockfile present, list confirms a live matched instance",
    () =>
      runProbeTest(
        (cwd) =>
          stubPipelineClient({
            list: () =>
              Effect.succeed({
                _tag: "ok",
                value: {
                  instances: [
                    {
                      projectPath: cwd,
                      pid: 111,
                      isRunning: true,
                      hasPipelinePackage: false,
                      isReachable: true,
                      pipelineVersion: null,
                      updateAvailable: null,
                      safeMode: null,
                    },
                  ],
                  latestVersion: null,
                  unparseableInstanceCount: 0,
                },
              }),
          }),
        (cwd) =>
          Effect.gen(function* () {
            yield* writeTextFile(cwd, "Temp/UnityLockfile", "");
            yield* writeTextFile(
              cwd,
              "Packages/packages-lock.json",
              JSON.stringify({ dependencies: {} }),
            );
            return yield* runProbe;
          }),
      ).pipe(
        Effect.map((result) => {
          expect(result.primary.state).toBe("S4");
          expect(result.facts.pipelinePackage.installed).toBe(false);
          expect(result.facts.lockfilePresent).toBe(true);
        }),
      ),
  );

  it.effect(
    "path-matching: an instance for a DIFFERENT project is not treated as a match for this one",
    () =>
      runProbeTest(
        () =>
          stubPipelineClient({
            list: () =>
              Effect.succeed({
                _tag: "ok",
                value: {
                  instances: [
                    {
                      projectPath: "/some/other/project",
                      pid: 222,
                      isRunning: true,
                      hasPipelinePackage: true,
                      isReachable: true,
                      pipelineVersion: "0.4.0",
                      updateAvailable: false,
                      safeMode: false,
                    },
                  ],
                  latestVersion: null,
                  unparseableInstanceCount: 0,
                },
              }),
          }),
        (cwd) =>
          Effect.gen(function* () {
            // THIS project's own Pipeline package IS installed (so a
            // no-match verdict lands on S6, "Unity isn't open," not S5,
            // "Pipeline package missing") — without this the test could
            // pass for the wrong reason (pipelinePackageInstalled: false
            // also reaches a state that ISN'T S4, just not S6).
            yield* writeTextFile(
              cwd,
              "Packages/packages-lock.json",
              JSON.stringify({
                dependencies: {
                  "com.unity.pipeline": { version: "0.4.0", depth: 0, source: "registry" },
                },
              }),
            );
            return yield* runProbe;
          }),
      ).pipe(
        Effect.map((result) => {
          // The OTHER project's live instance is never treated as though
          // it were this one.
          expect(result.primary.state).toBe("S6");
        }),
      ),
  );

  it.effect("path-matching tolerates a trailing slash (the shared normalizer, plan §1's F14)", () =>
    runProbeTest(
      (cwd) =>
        stubPipelineClient({
          list: () =>
            Effect.succeed({
              _tag: "ok",
              value: {
                instances: [
                  {
                    projectPath: `${cwd}/`,
                    pid: 333,
                    isRunning: true,
                    hasPipelinePackage: false,
                    isReachable: true,
                    pipelineVersion: null,
                    updateAvailable: null,
                    safeMode: null,
                  },
                ],
                latestVersion: null,
                unparseableInstanceCount: 0,
              },
            }),
        }),
      (cwd) =>
        Effect.gen(function* () {
          yield* writeTextFile(
            cwd,
            "Packages/packages-lock.json",
            JSON.stringify({ dependencies: {} }),
          );
          return yield* runProbe;
        }),
    ).pipe(
      Effect.map((result) => {
        // Matched despite the trailing slash -> S4 (missing package, but
        // a live match WAS found), not S5 (missing package, no live
        // match).
        expect(result.primary.state).toBe("S4");
      }),
    ),
  );

  it.effect(
    "everything green: registering a publisher THEN probing (both against the same registry instance) reaches S11",
    () =>
      runProbeTest(
        (cwd) =>
          stubPipelineClient({
            list: () =>
              Effect.succeed({
                _tag: "ok",
                value: {
                  instances: [
                    {
                      projectPath: cwd,
                      pid: 444,
                      isRunning: true,
                      hasPipelinePackage: true,
                      isReachable: true,
                      pipelineVersion: "0.4.0",
                      updateAvailable: false,
                      safeMode: false,
                    },
                  ],
                  latestVersion: null,
                  unparseableInstanceCount: 0,
                },
              }),
          }),
        (cwd) =>
          Effect.gen(function* () {
            yield* writeTextFile(
              cwd,
              "Packages/packages-lock.json",
              JSON.stringify({
                dependencies: {
                  "com.unity.pipeline": { version: "0.4.0", depth: 0, source: "registry" },
                  "com.ironmind.editor-presence": { version: "0.2.0", depth: 0, source: "git" },
                },
              }),
            );
            // Registration and the probe run against the SAME resolved
            // EditorPresenceRegistry service (both inside this one Effect,
            // discharged by the SAME `EditorPresenceRegistry.layer`
            // `runProbeTest` provides) — this is what proves the wiring,
            // not two independently-constructed registries that happen to
            // share a type.
            const registry = yield* EditorPresenceRegistry.EditorPresenceRegistry;
            const token = registry.newConnectionToken();
            yield* registry.registerPublisher(
              "test-session",
              token,
              {
                editor: { id: "unity", name: "Unity", version: "6000.3.14f1" },
                workspace: { root: cwd },
              },
              { claimantSessionId: undefined },
            );
            return yield* runProbe;
          }),
      ).pipe(
        Effect.map((result) => {
          expect(result.primary.state).toBe("S11");
          expect(result.facts.selectionPublisherRegistered).toBe(true);
        }),
      ),
  );

  it.effect(
    "isUnityProject: false for a plain temp dir with no marker file — even though every other fact in this test reaches S11, the fully-green state",
    () =>
      runProbeTest(
        (cwd) =>
          stubPipelineClient({
            list: () =>
              Effect.succeed({
                _tag: "ok",
                value: {
                  instances: [
                    {
                      projectPath: cwd,
                      pid: 444,
                      isRunning: true,
                      hasPipelinePackage: true,
                      isReachable: true,
                      pipelineVersion: "0.4.0",
                      updateAvailable: false,
                      safeMode: false,
                    },
                  ],
                  latestVersion: null,
                  unparseableInstanceCount: 0,
                },
              }),
          }),
        (cwd) =>
          Effect.gen(function* () {
            yield* writeTextFile(
              cwd,
              "Packages/packages-lock.json",
              JSON.stringify({
                dependencies: {
                  "com.unity.pipeline": { version: "0.4.0", depth: 0, source: "registry" },
                  "com.ironmind.editor-presence": { version: "0.2.0", depth: 0, source: "git" },
                },
              }),
            );
            const registry = yield* EditorPresenceRegistry.EditorPresenceRegistry;
            const token = registry.newConnectionToken();
            yield* registry.registerPublisher(
              "test-session",
              token,
              {
                editor: { id: "unity", name: "Unity", version: "6000.3.14f1" },
                workspace: { root: cwd },
              },
              { claimantSessionId: undefined },
            );
            return yield* runProbe;
          }),
      ).pipe(
        Effect.map((result) => {
          expect(result.facts.isUnityProject).toBe(false);
          // Not consulted by the classifier at all — S11 is still reached
          // on otherwise fully-green facts, per this field's own doc
          // comment in packages/contracts/src/unitySetup.ts. This is the
          // strongest proof of that non-coupling: every OTHER fact is as
          // green as `classifyUnitySetup` can require, and classification
          // still doesn't budge on the missing Unity marker file.
          expect(result.primary.state).toBe("S11");
        }),
      ),
  );

  it.effect(
    "isUnityProject: true once ProjectSettings/ProjectVersion.txt exists — the SAME marker EngineTypeResolver reads elsewhere, computed even when the CLI itself is unavailable",
    () =>
      runProbeTest(
        () => stubPipelineClient({ isAvailable: () => Effect.succeed(false) }),
        (cwd) =>
          Effect.gen(function* () {
            yield* writeTextFile(
              cwd,
              "ProjectSettings/ProjectVersion.txt",
              "m_EditorVersion: 6000.3.14f1\n",
            );
            // Same real false-positive this file's first test guards
            // against: `~/.unity/bin/unity` genuinely exists on the
            // machine this suite runs on.
            return yield* runProbe.pipe(
              Effect.provideService(HostProcessEnvironment, { HOME: cwd }),
            );
          }),
      ).pipe(
        Effect.map((result) => {
          expect(result.primary.state).toBe("S1");
          expect(result.facts.isUnityProject).toBe(true);
        }),
      ),
  );
});
