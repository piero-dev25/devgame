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
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as EditorPresenceRegistry from "../editorPresence/EditorPresenceRegistry.ts";
import * as UnityPackageLock from "./UnityPackageLock.ts";
import * as UnityPipelineClient from "./UnityPipelineClient.ts";
import * as UnitySetupProbe from "./UnitySetupProbe.ts";

const encodeJson = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);

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
      // Never exercised by this file's own tests (this suite proves
      // UnitySetupProbe's WIRING, which never calls install) — present
      // only because UnityPipelineClient.of({...})'s object literal is
      // checked against the full service interface, same latent-gap
      // pattern this file's own `list` field closed for #92 increment 1.
      install: () => Effect.die("unexpected install call"),
      // Same reason as `install` above — this suite never cold-launches an
      // Editor. `open` became a required member when #92's cold-start route
      // landed (0a1f6415d), and this object literal is checked against the
      // full service interface.
      open: () => Effect.die("unexpected open call"),
      ...overrides,
    }),
  );
}

/**
 * Runs a full test BODY against a fresh temp directory (used as this
 * "project"'s workspace root) and the full `UnitySetupProbe` dependency
 * graph. The temp directory is created FIRST, with only `FileSystem`
 * available, because a test's own `UnityPipelineClient` stub (which usually
 * needs to echo `cwd` back as `projectPath`) needs the resolved path as a
 * plain string BEFORE it can be constructed — `pipelineClient` and `body`
 * are therefore both FUNCTIONS of `cwd`, not pre-built values. By default
 * the helper writes Unity's marker file; the one non-Unity case opts out.
 * `NodeServices.layer` is
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
  >,
  options?: { readonly isUnityProject?: boolean },
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const cwd = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3code-unity-setup-project-",
    });
    if (options?.isUnityProject !== false) {
      yield* writeTextFile(
        cwd,
        "ProjectSettings/ProjectVersion.txt",
        "m_EditorVersion: 6000.3.14f1\n",
      );
    }
    return yield* body(cwd).pipe(
      Effect.provide(
        Layer.mergeAll(pipelineClient(cwd), UnityPackageLock.layer, EditorPresenceRegistry.layer),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer));

const runProbe = (cwd: string) =>
  Effect.gen(function* () {
    const probe = yield* UnitySetupProbe.make;
    return yield* probe.probe(cwd);
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
        runProbe(cwd).pipe(Effect.provideService(HostProcessEnvironment, { HOME: cwd })),
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
              encodeJson({ dependencies: {} }),
            );
            return yield* runProbe(cwd);
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
              encodeJson({
                dependencies: {
                  "com.unity.pipeline": { version: "0.4.0", depth: 0, source: "registry" },
                },
              }),
            );
            return yield* runProbe(cwd);
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
            encodeJson({ dependencies: {} }),
          );
          return yield* runProbe(cwd);
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
    "an embedded selection package copied under Packages is installed on the next probe before Unity updates packages-lock.json",
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
                      pid: 433,
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
              encodeJson({
                dependencies: {
                  "com.unity.pipeline": { version: "0.4.0", depth: 0, source: "registry" },
                },
              }),
            );
            yield* writeTextFile(
              cwd,
              "Packages/com.ironmind.editor-presence/package.json",
              encodeJson({
                name: "com.ironmind.editor-presence",
                version: "0.2.0",
              }),
            );
            return yield* runProbe(cwd);
          }),
      ).pipe(
        Effect.map((result) => {
          expect(result.facts.selectionPackage).toEqual({
            installed: true,
            resolvedVersion: null,
            declaredInManifest: false,
          });
          expect(result.primary.state).toBe("S10'");
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
              encodeJson({
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
            return yield* runProbe(cwd);
          }),
      ).pipe(
        Effect.map((result) => {
          expect(result.primary.state).toBe("S11");
          expect(result.facts.selectionPublisherRegistered).toBe(true);
        }),
      ),
  );

  it.effect(
    "isUnityProject: false for a plain temp dir wins as S0 even though every other fact would reach S11",
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
              encodeJson({
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
            return yield* runProbe(cwd);
          }),
        { isUnityProject: false },
      ).pipe(
        Effect.map((result) => {
          expect(result.facts.isUnityProject).toBe(false);
          expect(result.primary.state).toBe("S0");
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
            return yield* runProbe(cwd).pipe(
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

  it.effect(
    "pairing grace window: S10' right after boot, S10 once TestClock crosses it — same probe instance, same serverStartedAtMs capture (#118)",
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
                      pid: 555,
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
            // Pipeline fully green, selection package installed, publisher
            // deliberately NOT registered — the S9/S10/S10' branch
            // `UnitySetupProbe.ts`'s own `serverStartedAtMs` doc comment
            // names as the reason this value needs to be `Clock`-driven.
            yield* writeTextFile(
              cwd,
              "Packages/packages-lock.json",
              encodeJson({
                dependencies: {
                  "com.unity.pipeline": { version: "0.4.0", depth: 0, source: "registry" },
                  "com.ironmind.editor-presence": { version: "0.2.0", depth: 0, source: "git" },
                },
              }),
            );
            // ONE probe instance -> ONE `serverStartedAtMs` capture, probed
            // TWICE against the SAME virtual clock. This is exactly what a
            // `Date.now()` implementation could never let a test drive
            // deterministically — before #118's fix, `TestClock.adjust`
            // below would have had no effect on either result at all, and
            // this test would have failed on the second assertion (still
            // S10', not S10) rather than hung.
            const probe = yield* UnitySetupProbe.make;
            const immediate = yield* probe.probe(cwd);
            yield* TestClock.adjust(Duration.seconds(16));
            const afterWindow = yield* probe.probe(cwd);
            return { immediate, afterWindow };
          }),
      ).pipe(
        Effect.provide(TestClock.layer()),
        Effect.map(({ immediate, afterWindow }) => {
          expect(immediate.primary.state).toBe("S10'");
          expect(immediate.facts.withinPairingGraceWindow).toBe(true);
          expect(afterWindow.primary.state).toBe("S10");
          expect(afterWindow.facts.withinPairingGraceWindow).toBe(false);
        }),
      ),
  );
});
