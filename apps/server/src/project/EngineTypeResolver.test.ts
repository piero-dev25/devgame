import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as EngineTypeResolver from "./EngineTypeResolver.ts";

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(EngineTypeResolver.layer.pipe(Layer.provide(WorkspacePaths.layer))),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3code-engine-type-",
  });
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

it.layer(TestLayer)("EngineTypeResolverLive", (it) => {
  describe("detect", () => {
    it.effect("detects a Godot project via project.godot", () =>
      Effect.gen(function* () {
        const resolver = yield* EngineTypeResolver.EngineTypeResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "project.godot", "[gd_scene load_steps=1 format=3]\n");

        const detected = yield* resolver.detect(cwd);

        expect(detected).toBe("godot");
      }),
    );

    it.effect("detects a Unity project via ProjectSettings/ProjectVersion.txt", () =>
      Effect.gen(function* () {
        const resolver = yield* EngineTypeResolver.EngineTypeResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(
          cwd,
          "ProjectSettings/ProjectVersion.txt",
          "m_EditorVersion: 6000.0.23f1\n",
        );

        const detected = yield* resolver.detect(cwd);

        expect(detected).toBe("unity");
      }),
    );

    it.effect("detects an Unreal project via a *.uproject file at the root", () =>
      Effect.gen(function* () {
        const resolver = yield* EngineTypeResolver.EngineTypeResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "MyGame.uproject", '{ "FileVersion": 3 }');

        const detected = yield* resolver.detect(cwd);

        expect(detected).toBe("unreal");
      }),
    );

    it.effect("does not detect an Unreal project from a nested *.uproject file", () =>
      Effect.gen(function* () {
        const resolver = yield* EngineTypeResolver.EngineTypeResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "Sub/MyGame.uproject", '{ "FileVersion": 3 }');

        const detected = yield* resolver.detect(cwd);

        expect(detected).toBeNull();
      }),
    );

    it.effect("detects a three.js project via a package.json dependency", () =>
      Effect.gen(function* () {
        const resolver = yield* EngineTypeResolver.EngineTypeResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(
          cwd,
          "package.json",
          '{ "name": "app", "dependencies": { "three": "^0.160.0" } }',
        );

        const detected = yield* resolver.detect(cwd);

        expect(detected).toBe("threejs");
      }),
    );

    it.effect("detects a three.js project via a devDependencies entry", () =>
      Effect.gen(function* () {
        const resolver = yield* EngineTypeResolver.EngineTypeResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(
          cwd,
          "package.json",
          '{ "name": "app", "devDependencies": { "three": "^0.160.0" } }',
        );

        const detected = yield* resolver.detect(cwd);

        expect(detected).toBe("threejs");
      }),
    );

    // Priority-order regression test: this is the scenario the priority
    // order exists for. A Unity project commonly ships a package.json for
    // editor tooling or a companion web build — the native Unity marker
    // must win, not a first-match race over an unordered candidate list.
    it.effect("resolves a Unity project that also has a package.json to unity, not threejs", () =>
      Effect.gen(function* () {
        const resolver = yield* EngineTypeResolver.EngineTypeResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(
          cwd,
          "ProjectSettings/ProjectVersion.txt",
          "m_EditorVersion: 6000.0.23f1\n",
        );
        yield* writeTextFile(
          cwd,
          "package.json",
          '{ "name": "tooling", "dependencies": { "three": "^0.160.0" } }',
        );

        const detected = yield* resolver.detect(cwd);

        expect(detected).toBe("unity");
      }),
    );

    it.effect("resolves a Godot project that also has a package.json to godot, not threejs", () =>
      Effect.gen(function* () {
        const resolver = yield* EngineTypeResolver.EngineTypeResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "project.godot", "[gd_scene load_steps=1 format=3]\n");
        yield* writeTextFile(
          cwd,
          "package.json",
          '{ "name": "tooling", "dependencies": { "three": "^0.160.0" } }',
        );

        const detected = yield* resolver.detect(cwd);

        expect(detected).toBe("godot");
      }),
    );

    it.effect(
      "resolves an Unreal project that also has a package.json to unreal, not threejs",
      () =>
        Effect.gen(function* () {
          const resolver = yield* EngineTypeResolver.EngineTypeResolver;
          const cwd = yield* makeTempDir;
          yield* writeTextFile(cwd, "MyGame.uproject", '{ "FileVersion": 3 }');
          yield* writeTextFile(
            cwd,
            "package.json",
            '{ "name": "tooling", "dependencies": { "three": "^0.160.0" } }',
          );

          const detected = yield* resolver.detect(cwd);

          expect(detected).toBe("unreal");
        }),
    );

    it.effect("returns null for an unknown project", () =>
      Effect.gen(function* () {
        const resolver = yield* EngineTypeResolver.EngineTypeResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "README.md", "# just a folder\n");

        const detected = yield* resolver.detect(cwd);

        expect(detected).toBeNull();
      }),
    );

    it.effect("returns null for an empty package.json with no three dependency", () =>
      Effect.gen(function* () {
        const resolver = yield* EngineTypeResolver.EngineTypeResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "package.json", '{ "name": "app" }');

        const detected = yield* resolver.detect(cwd);

        expect(detected).toBeNull();
      }),
    );

    it.effect("returns null (does not fail) for invalid package.json", () =>
      Effect.gen(function* () {
        const resolver = yield* EngineTypeResolver.EngineTypeResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "package.json", "{ not json");

        const detected = yield* resolver.detect(cwd);

        expect(detected).toBeNull();
      }),
    );

    it.effect("returns null (does not throw) for a missing workspace root", () =>
      Effect.gen(function* () {
        const resolver = yield* EngineTypeResolver.EngineTypeResolver;
        const cwd = yield* makeTempDir;
        const missingCwd = `${cwd}/does-not-exist`;

        const detected = yield* resolver.detect(missingCwd);

        expect(detected).toBeNull();
      }),
    );
  });
});
