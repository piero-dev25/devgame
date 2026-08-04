import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import {
  buildUnityColdStartArgs,
  probeUnityLockfilePresent,
  resolveUnityLaunchPlan,
  resolveUnityLaunchPlanForProject,
  UNITY_COLD_START_EXECUTE_METHOD,
} from "./UnityColdStart.ts";

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-unity-cold-start-" });
});

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

describe("resolveUnityLaunchPlan (pure decision — spec's test bar: chooses correctly present vs absent)", () => {
  it("chooses warm when the lockfile is present", () => {
    expect(
      resolveUnityLaunchPlan("/Applications/Unity/Hub/Editor/6000.3.14f1/Unity.app", "/proj", true),
    ).toEqual({ kind: "warm" });
  });

  it("chooses cold, with the exact -projectPath/-executeMethod argv, when the lockfile is absent", () => {
    const plan = resolveUnityLaunchPlan(
      "/Applications/Unity/Hub/Editor/6000.3.14f1/Unity.app",
      "/proj",
      false,
    );
    expect(plan).toEqual({
      kind: "cold",
      args: [
        "/Applications/Unity/Hub/Editor/6000.3.14f1/Unity.app",
        "-projectPath",
        "/proj",
        "-executeMethod",
        UNITY_COLD_START_EXECUTE_METHOD,
      ],
    });
  });
});

describe("buildUnityColdStartArgs", () => {
  it("never includes -batchmode or -quit — the cold path leaves a visible, interactive Editor", () => {
    const args = buildUnityColdStartArgs("/path/to/Unity", "/proj");
    expect(args).not.toContain("-batchmode");
    expect(args).not.toContain("-quit");
  });

  it("targets the Unity-side cold-start entry point by its fully-qualified name", () => {
    const args = buildUnityColdStartArgs("/path/to/Unity", "/proj");
    const methodIndex = args.indexOf("-executeMethod");
    expect(methodIndex).toBeGreaterThanOrEqual(0);
    expect(args[methodIndex + 1]).toBe(
      "Ironmind.EditorPresence.EditorPresenceColdStartEntryPoint.EnterPlaymodeOnLaunch",
    );
  });
});

const TestLayer = Layer.empty.pipe(Layer.provideMerge(NodeServices.layer));

it.layer(TestLayer)("probeUnityLockfilePresent / resolveUnityLaunchPlanForProject", (it) => {
  it.effect("reports absent (cold) for a project with no Temp/UnityLockfile at all", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempDir;
      const present = yield* probeUnityLockfilePresent(cwd);
      expect(present).toBe(false);
    }),
  );

  it.effect("reports present (warm) once Temp/UnityLockfile exists", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempDir;
      yield* writeTextFile(cwd, "Temp/UnityLockfile", "");
      const present = yield* probeUnityLockfilePresent(cwd);
      expect(present).toBe(true);
    }),
  );

  it.effect(
    "does not mistake a Temp/UnityLockfile in a DIFFERENT project for this one (a live critic-style check)",
    () =>
      Effect.gen(function* () {
        const openProject = yield* makeTempDir;
        yield* writeTextFile(openProject, "Temp/UnityLockfile", "");

        const closedProject = yield* makeTempDir;
        const present = yield* probeUnityLockfilePresent(closedProject);
        expect(present).toBe(false);
      }),
  );

  it.effect(
    "end-to-end: resolveUnityLaunchPlanForProject picks warm when an Editor already holds the project",
    () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "Temp/UnityLockfile", "");
        const plan = yield* resolveUnityLaunchPlanForProject("/path/to/Unity", cwd);
        expect(plan).toEqual({ kind: "warm" });
      }),
  );

  it.effect(
    "end-to-end: resolveUnityLaunchPlanForProject picks cold when nothing has the project open",
    () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir;
        const plan = yield* resolveUnityLaunchPlanForProject("/path/to/Unity", cwd);
        expect(plan.kind).toBe("cold");
        if (plan.kind === "cold") {
          expect(plan.args).toContain(cwd);
        }
      }),
  );
});
