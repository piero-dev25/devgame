import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as UnityPackageLock from "./UnityPackageLock.ts";

const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(UnityPackageLock.layer),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-unity-package-lock-" });
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

it.layer(TestLayer)("UnityPackageLockLive", (it) => {
  describe("readDependencies", () => {
    it.effect("returns an empty map when packages-lock.json doesn't exist at all", () =>
      Effect.gen(function* () {
        const lock = yield* UnityPackageLock.UnityPackageLock;
        const cwd = yield* makeTempDir;

        const dependencies = yield* lock.readDependencies(cwd);

        expect(dependencies.size).toBe(0);
      }),
    );

    // Plan §1's F1: this is the load-bearing case — an EMBEDDED package
    // (source: "embedded") has NO manifest.json entry at all, and its lock
    // entry's own presence is already sufficient proof of installation. The
    // owner's real Mafia Game project has exactly this shape for
    // com.elringus.naninovel.
    it.effect("reports an EMBEDDED package as installed from the lock entry alone (F1)", () =>
      Effect.gen(function* () {
        const lock = yield* UnityPackageLock.UnityPackageLock;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(
          cwd,
          "Packages/packages-lock.json",
          encodeJson({
            dependencies: {
              "com.elringus.naninovel": {
                version: "file:com.elringus.naninovel",
                depth: 0,
                source: "embedded",
              },
            },
          }),
        );

        const dependencies = yield* lock.readDependencies(cwd);

        expect(dependencies.get("com.elringus.naninovel")).toEqual({
          version: "file:com.elringus.naninovel",
          depth: 0,
          source: "embedded",
        });
      }),
    );

    it.effect("reports a registry-resolved package's version", () =>
      Effect.gen(function* () {
        const lock = yield* UnityPackageLock.UnityPackageLock;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(
          cwd,
          "Packages/packages-lock.json",
          encodeJson({
            dependencies: {
              "com.unity.pipeline": { version: "0.4.0-exp.1", depth: 0, source: "registry" },
            },
          }),
        );

        const dependencies = yield* lock.readDependencies(cwd);

        expect(dependencies.get("com.unity.pipeline")?.version).toBe("0.4.0-exp.1");
      }),
    );

    it.effect("a package with no entry at all is genuinely absent — not a false positive", () =>
      Effect.gen(function* () {
        const lock = yield* UnityPackageLock.UnityPackageLock;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(
          cwd,
          "Packages/packages-lock.json",
          encodeJson({ dependencies: { "com.unity.pipeline": { version: "0.4.0-exp.1" } } }),
        );

        const dependencies = yield* lock.readDependencies(cwd);

        expect(dependencies.has("com.ironmind.editor-presence")).toBe(false);
      }),
    );

    it.effect(
      "malformed JSON degrades to an empty map, the SAFE direction for an installed-check",
      () =>
        Effect.gen(function* () {
          const lock = yield* UnityPackageLock.UnityPackageLock;
          const cwd = yield* makeTempDir;
          yield* writeTextFile(cwd, "Packages/packages-lock.json", "{ this is not valid json");

          const dependencies = yield* lock.readDependencies(cwd);

          expect(dependencies.size).toBe(0);
        }),
    );

    it.effect("valid JSON with no dependencies object degrades to an empty map", () =>
      Effect.gen(function* () {
        const lock = yield* UnityPackageLock.UnityPackageLock;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "Packages/packages-lock.json", encodeJson({ notes: "empty" }));

        const dependencies = yield* lock.readDependencies(cwd);

        expect(dependencies.size).toBe(0);
      }),
    );
  });

  describe("readManifestDependencyIds", () => {
    it.effect("reads both dependencies and devDependencies", () =>
      Effect.gen(function* () {
        const lock = yield* UnityPackageLock.UnityPackageLock;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(
          cwd,
          "Packages/manifest.json",
          encodeJson({
            dependencies: { "com.unity.pipeline": "0.4.0-exp.1" },
            devDependencies: { "com.unity.test-framework": "1.4.6" },
          }),
        );

        const ids = yield* lock.readManifestDependencyIds(cwd);

        expect(ids.has("com.unity.pipeline")).toBe(true);
        expect(ids.has("com.unity.test-framework")).toBe(true);
      }),
    );

    it.effect("returns an empty set when manifest.json doesn't exist", () =>
      Effect.gen(function* () {
        const lock = yield* UnityPackageLock.UnityPackageLock;
        const cwd = yield* makeTempDir;

        const ids = yield* lock.readManifestDependencyIds(cwd);

        expect(ids.size).toBe(0);
      }),
    );

    // Plan §1's F1: an embedded package like com.elringus.naninovel is
    // absent from manifest.json even though it's genuinely installed — this
    // function's own callers must never treat that absence as "not
    // installed" (readDependencies above is the authoritative check; this
    // one is declared-intent only).
    it.effect(
      "an embedded package's absence here does not mean it isn't installed — this is intent-only",
      () =>
        Effect.gen(function* () {
          const lock = yield* UnityPackageLock.UnityPackageLock;
          const cwd = yield* makeTempDir;
          yield* writeTextFile(cwd, "Packages/manifest.json", encodeJson({ dependencies: {} }));
          yield* writeTextFile(
            cwd,
            "Packages/packages-lock.json",
            encodeJson({
              dependencies: {
                "com.elringus.naninovel": {
                  version: "file:com.elringus.naninovel",
                  source: "embedded",
                },
              },
            }),
          );

          const manifestIds = yield* lock.readManifestDependencyIds(cwd);
          const lockDependencies = yield* lock.readDependencies(cwd);

          expect(manifestIds.has("com.elringus.naninovel")).toBe(false);
          expect(lockDependencies.has("com.elringus.naninovel")).toBe(true);
        }),
    );
  });
});
