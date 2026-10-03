// @effect-diagnostics nodeBuiltinImport:off
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { RUN_PROFILES_FILE_NAME } from "@t3tools/contracts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as RunProfiles from "./RunProfiles.ts";

const KAIGEN_FIXTURE_PATH = NodeURL.fileURLToPath(
  new URL("./__fixtures__/kaigen-horde-spike.devgame.runtime.json", import.meta.url),
);
const KAIGEN_BINARY = "Runtime/out/macos/debug/kaigen-horde-spike";
const CAPTURE_ID = "vfx-capture-fire-front-0.65";
/** The named CAPTURE profile: `tools/capture_kaigen_vfx.sh` writing into the run's own directory. */
const SCRIPT_CAPTURE_ID = "capture-fire-front-0.65";
const CAPTURE_SCRIPT = "tools/capture_kaigen_vfx.sh";
/** The `tools/capture_kaigen_vfx.sh --no-build` invocation for effect 1, view Z, age 0.65. */
const CAPTURE_ARGS = [
  "--vfx",
  "--commands",
  "2.30:key_down:1;2.36:key_up:1;2.40:key_down:Space;2.46:key_up:Space;2.47:key_down:Z;2.49:key_up:Z;2.50:vfx_capture_hold:0.65;2.55:key_down:R;2.61:key_up:R;3.5500:vfx_capture_probe;3.6500:screenshot:{{runDir}}/fire-front-t00_65.png:full;4.4500:quit",
];

const WorkspaceEntriesLayer = WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer));
const WorkspaceFileSystemLayer = WorkspaceFileSystem.layer.pipe(
  Layer.provide(WorkspacePaths.layer),
  Layer.provide(WorkspaceEntriesLayer),
);

const TestLayer = RunProfiles.layer.pipe(
  Layer.provide(WorkspaceFileSystemLayer),
  Layer.provide(WorkspacePaths.layer),
  Layer.provide(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
  Layer.provide(
    ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-run-profiles-test-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const makeRoot = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-run-profiles-" });
});

const writeFile = Effect.fn("writeFile")(function* (
  root: string,
  relativePath: string,
  contents = "",
  mode = 0o644,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(root, relativePath);
  yield* fileSystem
    .makeDirectory(path.dirname(absolutePath), { recursive: true })
    .pipe(Effect.orDie);
  yield* fileSystem.writeFileString(absolutePath, contents).pipe(Effect.orDie);
  yield* fileSystem.chmod(absolutePath, mode).pipe(Effect.orDie);
});

const writeExecutable = (root: string, relativePath: string) =>
  writeFile(root, relativePath, "#!/bin/sh\nexit 0\n", 0o755);

const writeProfiles = (root: string, profiles: ReadonlyArray<unknown>) =>
  writeFile(root, RUN_PROFILES_FILE_NAME, JSON.stringify({ version: 1, profiles }, null, 2));

const profile = (overrides: Record<string, unknown> = {}) => ({
  id: "game",
  name: "Game",
  executable: "bin/game",
  args: [],
  ...overrides,
});

const load = (root: string) => Effect.flatMap(RunProfiles.RunProfiles, (s) => s.load(root));
const resolve = (root: string, id: string) =>
  Effect.flatMap(RunProfiles.RunProfiles, (s) => s.resolve(root, id));

const issueKinds = (statuses: ReadonlyArray<RunProfiles.RunProfileStatus>, id = "game") =>
  statuses.find((status) => status.profile.id === id)?.issues.map((issue) => issue.kind);

/** A temp project shaped like KaigenHordeSpike with the example manifest copied in. */
const makeKaigenProject = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const root = yield* makeRoot;
  const fixture = yield* fileSystem.readFileString(KAIGEN_FIXTURE_PATH);
  yield* writeFile(root, RUN_PROFILES_FILE_NAME, fixture);
  yield* writeExecutable(root, KAIGEN_BINARY);
  yield* writeExecutable(root, CAPTURE_SCRIPT);
  // The build tool exists and is executable, so nothing but the profile keeps it out of a plan.
  yield* writeExecutable(root, "Runtime/hz/hzbuild");
  return root;
});

it.layer(TestLayer, { excludeTestServices: true })("RunProfiles", (it) => {
  describe("Kaigen example manifest", () => {
    it.effect("lists both profiles as valid and keeps the capture argv byte for byte", () =>
      Effect.gen(function* () {
        const root = yield* makeKaigenProject;

        const statuses = yield* load(root);

        expect(statuses.map((s) => [s.profile.id, s.valid, s.issues])).toEqual([
          ["vfx-arena", true, []],
          [CAPTURE_ID, true, []],
          [SCRIPT_CAPTURE_ID, true, []],
        ]);
        expect(statuses[1]?.profile.args).toEqual(CAPTURE_ARGS);
      }),
    );

    it.effect("resolves the capture profile to the existing binary with no build step", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* makeKaigenProject;

        const runDir = "/state/runs/project-1/run-1";
        const plan = yield* resolve(root, CAPTURE_ID);
        const bound = RunProfiles.bindRunDirectory(plan, runDir);

        expect(plan.absExecutable).toBe(path.join(root, KAIGEN_BINARY));
        expect(plan.absCwd).toBe(path.join(root, "Runtime"));
        expect(plan.args).toEqual(CAPTURE_ARGS);
        // The screenshot lands in the run's own directory, never in the game project.
        expect(bound.args[2]).toContain(`screenshot:${runDir}/fire-front-t00_65.png:full`);
        expect(bound.outputs.map((output) => [output.name, output.location, output.absPath])).toEqual([
          ["capture", "run", `${runDir}/fire-front-t00_65.png`],
        ]);
        expect(plan.logPatterns).toEqual([
          "VFX capture probe:.*effect age 0\\.65(,|$)",
          "screenshot saved:",
        ]);
        // No shell wrapper and no build or install anywhere in what gets spawned.
        const spawned = [plan.absExecutable, ...plan.args].join("\n");
        expect(spawned).not.toMatch(/hzbuild|\binstall\b|(^|\/)(ba|z)?sh$/m);
        expect(plan.args).not.toContain("-c");
        // Resolving is read-only: the capture directory is not created ahead of the run.
        expect(yield* fileSystem.exists(path.join(root, "work"))).toBe(false);
      }),
    );

    it.effect("resolves the arena profile to the same binary with only --vfx", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const root = yield* makeKaigenProject;

        const plan = yield* resolve(root, "vfx-arena");

        expect(plan).toEqual({
          profileId: "vfx-arena",
          absExecutable: path.join(root, KAIGEN_BINARY),
          args: ["--vfx"],
          absCwd: path.join(root, "Runtime"),
          envAllowList: [],
          outputs: [],
          logPatterns: [],
          recordsEvidence: false,
          build: { path: KAIGEN_BINARY, absPath: path.join(root, KAIGEN_BINARY) },
          workspaceCard: null,
        });
      }),
    );

    it.effect(
      "resolves the CAPTURE profile to the capture script, writing into the run's own directory",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* makeKaigenProject;
          const runDir = "/state/runs/project-1/run-1";

          const plan = yield* resolve(root, SCRIPT_CAPTURE_ID);
          const bound = RunProfiles.bindRunDirectory(plan, runDir);

          expect(plan.absExecutable).toBe(path.join(root, CAPTURE_SCRIPT));
          expect(plan.absCwd).toBe(root);
          // The script's argv: effect, view, age, absolute PNG under the state dir, --no-build.
          expect(bound.args).toEqual([
            "1",
            "front",
            "0.65",
            `${runDir}/fire-front-t00_65.png`,
            "--no-build",
          ]);
          expect(bound.outputs.map((output) => [output.location, output.absPath])).toEqual([
            ["run", `${runDir}/fire-front-t00_65.png`],
            ["run", `${runDir}/fire-front-t00_65.log`],
          ]);
          expect(plan.logPatterns).toEqual([
            "VFX capture probe:.*effect age 0\\.65(,|$)",
            "screenshot saved:",
          ]);
          // Evidence fingerprints the game binary the script runs, not the script.
          expect(plan.recordsEvidence).toBe(true);
          expect(plan.build).toEqual({
            path: KAIGEN_BINARY,
            absPath: path.join(root, KAIGEN_BINARY),
          });
          // Nothing is written into the project for the capture.
          expect(yield* fileSystem.exists(path.join(root, "work"))).toBe(false);
        }),
    );

    it.effect(
      "lists the capture profile as invalid when the build is missing, never building",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* makeKaigenProject;
          yield* fileSystem.remove(path.join(root, KAIGEN_BINARY));

          const statuses = yield* load(root);
          const error = yield* Effect.flip(resolve(root, CAPTURE_ID));

          expect(issueKinds(statuses, CAPTURE_ID)).toEqual(["executable-missing"]);
          expect(
            statuses
              .filter((status) => status.profile.executable === KAIGEN_BINARY)
              .every((status) => !status.valid),
          ).toBe(true);
          // The script profile still launches; its evidence records the build as unknown.
          expect(issueKinds(statuses, SCRIPT_CAPTURE_ID)).toEqual([]);
          expect(error).toBeInstanceOf(RunProfiles.RunProfileExecutableMissing);
          expect(error.message).toContain(KAIGEN_BINARY);
          expect(yield* fileSystem.exists(path.join(root, KAIGEN_BINARY))).toBe(false);
        }),
    );
  });

  describe("literal arguments", () => {
    it.effect("passes shell metacharacters, variables and whitespace through untouched", () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        const args = ["$HOME", "${PATH}", "a b", "  padded  ", "x;y", "`id`", "*", "'q'", "", "-c"];
        yield* writeExecutable(root, "bin/game");
        yield* writeProfiles(root, [profile({ args })]);

        const plan = yield* resolve(root, "game");

        expect(plan.args).toEqual(args);
      }),
    );

    it.effect("rejects a shell-string args value as a malformed file", () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        yield* writeExecutable(root, "bin/game");
        yield* writeProfiles(root, [profile({ args: "--vfx --commands foo" })]);

        const error = yield* Effect.flip(load(root));

        expect(error).toBeInstanceOf(RunProfiles.RunProfilesMalformed);
        expect(error.reason).toBe("malformed");
      }),
    );
  });

  describe("root containment", () => {
    for (const [field, value, kind] of [
      ["executable", "/bin/sh", "executable-escape"],
      ["executable", "../outside/game", "executable-escape"],
      ["cwd", "/tmp", "cwd-escape"],
      ["cwd", "bin/../..", "cwd-escape"],
    ] as const) {
      it.effect(`flags ${field} "${value}" as an escape and refuses to resolve it`, () =>
        Effect.gen(function* () {
          const root = yield* makeRoot;
          yield* writeExecutable(root, "bin/game");
          yield* writeProfiles(root, [profile({ [field]: value })]);

          const statuses = yield* load(root);
          const error = yield* Effect.flip(resolve(root, "game"));

          expect(issueKinds(statuses)).toEqual([kind]);
          expect(error).toBeInstanceOf(RunProfiles.RunProfilePathEscape);
          expect(error).toMatchObject({ field, path: value });
        }),
      );
    }

    it.effect("flags an output path that climbs out of the root", () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        yield* writeExecutable(root, "bin/game");
        yield* writeProfiles(root, [
          profile({ outputs: [{ name: "shot", kind: "image", path: "../shot.png" }] }),
        ]);

        const error = yield* Effect.flip(resolve(root, "game"));

        expect(error).toBeInstanceOf(RunProfiles.RunProfilePathEscape);
        expect(error).toMatchObject({ field: "output", path: "../shot.png" });
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "flags an executable symlinked to a file outside the root",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* makeRoot;
          const outside = yield* makeRoot;
          yield* writeExecutable(outside, "game");
          yield* fileSystem.makeDirectory(path.join(root, "bin"));
          yield* fileSystem.symlink(path.join(outside, "game"), path.join(root, "bin/game"));
          yield* writeProfiles(root, [profile()]);

          const statuses = yield* load(root);
          const error = yield* Effect.flip(resolve(root, "game"));

          expect(issueKinds(statuses)).toEqual(["executable-escape"]);
          expect(error).toBeInstanceOf(RunProfiles.RunProfilePathEscape);
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "flags an output whose not-yet-existing file sits under a directory linked outside",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* makeRoot;
          const outside = yield* makeRoot;
          yield* writeExecutable(root, "bin/game");
          yield* fileSystem.symlink(outside, path.join(root, "work"));
          yield* writeProfiles(root, [
            profile({ outputs: [{ name: "shot", kind: "image", path: "work/captures/a.png" }] }),
          ]);

          expect(issueKinds(yield* load(root))).toEqual(["output-escape"]);
        }),
    );

    for (const [label, linkPath, outputPath] of [
      ["the output file itself", "work/a.png", "work/a.png"],
      ["a directory on the output path", "work/captures", "work/captures/a.png"],
    ] as const) {
      it.effect.skipIf(!symlinksSupported)(
        `flags an output when ${label} is a dangling symlink to outside the root`,
        () =>
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const root = yield* makeRoot;
            const outside = yield* makeRoot;
            yield* writeExecutable(root, "bin/game");
            yield* fileSystem.makeDirectory(path.join(root, "work"));
            yield* fileSystem.symlink(
              path.join(outside, "not-yet-there"),
              path.join(root, linkPath),
            );
            yield* writeProfiles(root, [
              profile({ outputs: [{ name: "shot", kind: "image", path: outputPath }] }),
            ]);

            const statuses = yield* load(root);
            const error = yield* Effect.flip(resolve(root, "game"));

            expect(issueKinds(statuses)).toEqual(["output-escape"]);
            expect(error).toBeInstanceOf(RunProfiles.RunProfilePathEscape);
            expect(error).toMatchObject({ field: "output", path: outputPath });
          }),
      );
    }
  });

  describe("run directory and build paths", () => {
    it.effect("accepts only {{runDir}}/ followed by a path inside the run directory", () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        yield* writeExecutable(root, "bin/game");
        const output = (path: string) => ({ name: "shot", kind: "image", path });
        yield* writeProfiles(root, [
          profile({ id: "ok", outputs: [output("{{runDir}}/captures/a.png")] }),
          profile({ id: "climbs", outputs: [output("{{runDir}}/../a.png")] }),
          profile({ id: "inside", outputs: [output("work/{{runDir}}/a.png")] }),
          profile({ id: "bare", outputs: [output("{{runDir}}")] }),
        ]);

        const statuses = yield* load(root);

        expect(
          statuses.map((status) => [status.profile.id, issueKinds(statuses, status.profile.id)]),
        ).toEqual([
          ["ok", []],
          ["climbs", ["output-escape"]],
          ["inside", ["output-escape"]],
          ["bare", ["output-escape"]],
        ]);
        const bound = RunProfiles.bindRunDirectory(yield* resolve(root, "ok"), "/runs/r1");
        expect(bound.outputs[0]).toMatchObject({
          location: "run",
          relativePath: "captures/a.png",
          absPath: "/runs/r1/captures/a.png",
        });
      }),
    );

    it.effect("flags an evidence build path outside the root", () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        yield* writeExecutable(root, "bin/game");
        yield* writeProfiles(root, [
          profile({ evidence: { logPatterns: [], build: "../elsewhere/game" } }),
        ]);

        expect(issueKinds(yield* load(root))).toEqual(["build-escape"]);
        expect((yield* Effect.flip(resolve(root, "game")))._tag).toBe("RunProfileInvalid");
      }),
    );

    it.effect("links a profile's evidence to the workspace card it names", () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        yield* writeExecutable(root, "bin/game");
        yield* writeProfiles(root, [
          profile({
            evidence: {
              logPatterns: [],
              workspaceCard: { entityId: "fire-front", stepPath: "report.html" },
            },
          }),
        ]);

        const plan = yield* resolve(root, "game");

        expect(plan.recordsEvidence).toBe(true);
        expect(plan.workspaceCard).toEqual({ entityId: "fire-front", stepPath: "report.html" });
      }),
    );
  });

  describe("executable checks", () => {
    it.effect("flags a file without an execute bit as not executable", () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        yield* writeFile(root, "bin/game", "#!/bin/sh\n", 0o644);
        yield* writeProfiles(root, [profile()]);

        const statuses = yield* load(root);
        const error = yield* Effect.flip(resolve(root, "game"));

        expect(issueKinds(statuses)).toEqual(["executable-not-executable"]);
        expect(error).toBeInstanceOf(RunProfiles.RunProfileExecutableNotExecutable);
      }),
    );

    it.effect("flags a file only others may execute as not executable for the server user", () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        // Owner rw-, other --x: an execute bit is set, but not one the owner can use.
        yield* writeFile(root, "bin/game", "#!/bin/sh\nexit 0\n", 0o601);
        yield* writeProfiles(root, [profile()]);

        const statuses = yield* load(root);
        const error = yield* Effect.flip(resolve(root, "game"));

        expect(issueKinds(statuses)).toEqual(["executable-not-executable"]);
        expect(error).toBeInstanceOf(RunProfiles.RunProfileExecutableNotExecutable);
      }),
    );

    it.effect("flags a directory named as the executable as not executable", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* makeRoot;
        yield* fileSystem.makeDirectory(path.join(root, "bin/game"), { recursive: true });
        yield* writeProfiles(root, [profile()]);

        expect(issueKinds(yield* load(root))).toEqual(["executable-not-executable"]);
      }),
    );
  });

  describe("profile fields", () => {
    it.effect("defaults cwd to the project root and passes a valid env allow-list through", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const root = yield* makeRoot;
        yield* writeExecutable(root, "bin/game");
        yield* writeProfiles(root, [profile({ envAllowList: ["HOME", "VK_ICD_FILENAMES"] })]);

        const plan = yield* resolve(root, "game");

        expect(plan.absCwd).toBe(path.resolve(root));
        expect(plan.envAllowList).toEqual(["HOME", "VK_ICD_FILENAMES"]);
      }),
    );

    it.effect("refuses env names that look like secrets or loader variables", () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        const denied = [
          "AWS_SECRET_ACCESS_KEY",
          "GITHUB_TOKEN",
          "OPENAI_API_KEY",
          "DB_PASSWORD",
          "DYLD_INSERT_LIBRARIES",
          "LD_PRELOAD",
          "NODE_OPTIONS",
        ];
        yield* writeExecutable(root, "bin/game");
        yield* writeProfiles(root, [profile({ envAllowList: ["HOME", "LANG", ...denied] })]);

        const statuses = yield* load(root);
        const error = yield* Effect.flip(resolve(root, "game"));

        expect(issueKinds(statuses)).toEqual(denied.map(() => "env-name-invalid"));
        expect(error).toBeInstanceOf(RunProfiles.RunProfileInvalid);
        expect(error.message).toContain("GITHUB_TOKEN");
      }),
    );

    it.effect(
      "lists other unusable fields as issues and fails resolve with RunProfileInvalid",
      () =>
        Effect.gen(function* () {
          const root = yield* makeRoot;
          yield* writeExecutable(root, "bin/game");
          yield* writeProfiles(root, [
            profile({
              cwd: "missing-dir",
              envAllowList: ["OK", "NOT-A-NAME"],
              outputs: [
                { name: "log", kind: "log", path: "out/a.log" },
                { name: "log", kind: "file", path: "out/b.txt" },
              ],
              evidence: { logPatterns: ["("] },
            }),
          ]);

          const statuses = yield* load(root);
          const error = yield* Effect.flip(resolve(root, "game"));

          expect(issueKinds(statuses)).toEqual([
            "cwd-missing",
            "env-name-invalid",
            "output-name-duplicate",
            "log-pattern-invalid",
          ]);
          expect(error).toBeInstanceOf(RunProfiles.RunProfileInvalid);
        }),
    );

    it.effect("flags a duplicate id and resolves the first profile with that id", () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        yield* writeExecutable(root, "bin/game");
        yield* writeProfiles(root, [profile({ args: ["first"] }), profile({ args: ["second"] })]);

        const statuses = yield* load(root);
        const plan = yield* resolve(root, "game");

        expect(statuses.map((s) => s.valid)).toEqual([true, false]);
        expect(statuses[1]?.issues.map((issue) => issue.kind)).toEqual(["duplicate-id"]);
        expect(plan.args).toEqual(["first"]);
      }),
    );
  });

  describe("manifest file", () => {
    it.effect("treats a missing manifest as no profiles", () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;

        expect(yield* load(root)).toEqual([]);
        const error = yield* Effect.flip(resolve(root, "game"));
        expect(error).toBeInstanceOf(RunProfiles.RunProfileNotFound);
      }),
    );

    it.effect("fails with NotFound for an unknown profile id", () =>
      Effect.gen(function* () {
        const root = yield* makeKaigenProject;

        const error = yield* Effect.flip(resolve(root, "vfx-build"));

        expect(error).toBeInstanceOf(RunProfiles.RunProfileNotFound);
        expect(error).toMatchObject({ profileId: "vfx-build" });
      }),
    );

    for (const [label, contents] of [
      ["invalid JSON", "{ not json"],
      ["an unsupported version", JSON.stringify({ version: 2, profiles: [] })],
      ["a profile without an executable", JSON.stringify({ version: 1, profiles: [{ id: "a" }] })],
    ] as const) {
      it.effect(`fails as malformed for ${label}`, () =>
        Effect.gen(function* () {
          const root = yield* makeRoot;
          yield* writeFile(root, RUN_PROFILES_FILE_NAME, contents);

          const error = yield* Effect.flip(load(root));

          expect(error).toBeInstanceOf(RunProfiles.RunProfilesMalformed);
          expect(error.reason).toBe("malformed");
        }),
      );
    }
  });
});
