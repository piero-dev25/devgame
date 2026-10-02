// @effect-diagnostics nodeBuiltinImport:off
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
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
import * as ProjectWorkspace from "./ProjectWorkspace.ts";

const MR_MAK_FIXTURE_PATH = NodeURL.fileURLToPath(
  new URL("./__fixtures__/mr-mak-workspace.json", import.meta.url),
);

const WorkspaceEntriesLayer = WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer));
const WorkspaceFileSystemLayer = WorkspaceFileSystem.layer.pipe(
  Layer.provide(WorkspacePaths.layer),
  Layer.provide(WorkspaceEntriesLayer),
);

const TestLayer = ProjectWorkspace.layer.pipe(
  Layer.provide(WorkspaceFileSystemLayer),
  Layer.provide(WorkspacePaths.layer),
  Layer.provide(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
  Layer.provide(
    ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-project-workspace-test-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const makeRoot = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-project-workspace-" });
});

const writeFile = Effect.fn("writeFile")(function* (
  root: string,
  relativePath: string,
  contents = "",
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(root, relativePath);
  yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true }).pipe(Effect.orDie);
  yield* fileSystem.writeFileString(absolutePath, contents).pipe(Effect.orDie);
});

const writeManifest = (root: string, manifest: unknown) =>
  writeFile(root, "workspace/workspace.json", JSON.stringify(manifest, null, 2));

const entity = (overrides: Record<string, unknown> = {}) => ({
  id: "card",
  title: "Card",
  folder: "card",
  steps: [{ name: "Report", path: "report.md" }],
  ...overrides,
});

const readManifest = (root: string) =>
  Effect.flatMap(ProjectWorkspace.ProjectWorkspace, (service) => service.readManifest(root));

const readOk = (root: string) =>
  Effect.gen(function* () {
    const result = yield* readManifest(root);
    if (result._tag !== "ok") return yield* Effect.die(`expected ok, got ${result._tag}`);
    return result.manifest;
  });

const readError = (root: string) => Effect.flip(readManifest(root));

it.layer(TestLayer, { excludeTestServices: true })("ProjectWorkspace.readManifest", (it) => {
  describe("registry file", () => {
    it.effect("decodes the real Mr. Mak registry, keeping step order and defaultStep", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* makeRoot;
        const fixture = yield* fileSystem.readFileString(MR_MAK_FIXTURE_PATH);
        yield* writeFile(root, "workspace/workspace.json", fixture);
        yield* writeFile(root, "workspace/2026-09-15_my-dream-game/index.html", "<p>64</p>");
        yield* writeFile(root, "workspace/2026-09-15_creative-mcp/report.html", "<p>r</p>");
        yield* writeFile(root, "workspace/2026-09-15_creative-mcp/connect.md", "# c");

        const manifest = yield* readOk(root);

        expect(manifest.entities.map((e) => e.id)).toEqual([
          "my-dream-game",
          "creative-mcp",
          "make-workspace-yours",
          "arachne-character",
        ]);
        const [dream, creative, yours, arachne] = manifest.entities;
        expect(dream).toMatchObject({
          title: "My Dream Game",
          type: "group",
          category: "project",
          folder: "2026-09-15_my-dream-game",
          status: "active",
          pinned: true,
          sample: true,
          defaultStep: 0,
          created: "2026-09-15",
          updated: "2026-09-15",
        });
        expect(creative?.steps).toEqual([
          {
            name: "Tool shortlist",
            path: "report.html",
            relativePath: "workspace/2026-09-15_creative-mcp/report.html",
            exists: true,
          },
          {
            name: "Connect a tool",
            path: "connect.md",
            relativePath: "workspace/2026-09-15_creative-mcp/connect.md",
            exists: true,
          },
        ]);
        expect(yours?.steps.map((s) => s.name)).toEqual(["Get started", "Everyday use", "Customize"]);
        expect(arachne?.steps).toHaveLength(10);
        expect(arachne?.steps[9]?.path).toBe("report_motion.html");
        expect(arachne).not.toHaveProperty("defaultStep");
        // Only the step files this test did not create are reported.
        expect(new Set(manifest.issues.map((issue) => issue.kind))).toEqual(
          new Set(["step-missing"]),
        );
        expect(manifest.issues.map((issue) => issue.entityId)).not.toContain("creative-mcp");
      }),
    );

    it.effect("ignores unknown keys and accepts a registry with only required fields", () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        yield* writeManifest(root, { version: 2, entities: [entity({ color: "red" })] });
        yield* writeFile(root, "workspace/card/report.md", "# hi");

        const manifest = yield* readOk(root);

        expect(manifest.entities).toEqual([
          {
            id: "card",
            title: "Card",
            folder: "card",
            steps: [
              {
                name: "Report",
                path: "report.md",
                relativePath: "workspace/card/report.md",
                exists: true,
              },
            ],
          },
        ]);
        expect(manifest.issues).toEqual([]);
      }),
    );

    it.effect("returns missing, not an error, when there is no registry", () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        expect(yield* readManifest(root)).toEqual({ _tag: "missing" });

        yield* writeFile(root, "workspace/other.txt", "not a registry");
        expect(yield* readManifest(root)).toEqual({ _tag: "missing" });
      }),
    );

    it.effect("fails as malformed for invalid JSON", () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        yield* writeFile(root, "workspace/workspace.json", '{"entities": [');

        const error = yield* readError(root);

        expect(error).toBeInstanceOf(ProjectWorkspace.ProjectWorkspaceManifestError);
        expect(error.reason).toBe("malformed");
        expect(error.message).toContain("workspace/workspace.json is not a valid workspace registry");
      }),
    );

    it.effect("fails as malformed for a wrong shape", () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        yield* writeManifest(root, { entities: [{ id: "x", title: "X", folder: "x", steps: [{}] }] });
        expect((yield* readError(root)).reason).toBe("malformed");

        yield* writeManifest(root, { entities: {} });
        expect((yield* readError(root)).reason).toBe("malformed");

        yield* writeManifest(root, [entity()]);
        expect((yield* readError(root)).reason).toBe("malformed");
      }),
    );

    it.effect("fails as truncated for a registry over 1 MiB", () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        yield* writeManifest(root, { entities: [], padding: "x".repeat(1024 * 1024) });

        const error = yield* readError(root);

        expect(error.reason).toBe("truncated");
        expect(error.message).toContain("larger than 1 MiB");
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "fails as escape when the registry is a symlink to a file outside the root",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* makeRoot;
          const outside = yield* makeRoot;
          yield* writeManifest(outside, { entities: [entity({ id: "outside" })] });
          yield* fileSystem.makeDirectory(path.join(root, "workspace"));
          yield* fileSystem.symlink(
            path.join(outside, "workspace/workspace.json"),
            path.join(root, "workspace/workspace.json"),
          );

          expect((yield* readError(root)).reason).toBe("escape");
        }),
    );
  });

  describe("paths", () => {
    it.effect("flags '..' and absolute folder or step paths as escapes and never reads them", () =>
      Effect.gen(function* () {
        const root = yield* makeRoot;
        const outside = yield* makeRoot;
        yield* writeFile(outside, "secret.md", "secret");
        yield* writeFile(root, "inside.md", "root file outside workspace/");
        yield* writeManifest(root, {
          entities: [
            entity({ id: "up-folder", folder: "../..", steps: [{ name: "a", path: "x.md" }] }),
            entity({ id: "abs-folder", folder: outside, steps: [{ name: "a", path: "secret.md" }] }),
            entity({
              id: "bad-steps",
              steps: [
                { name: "climb", path: "../../inside.md" },
                { name: "abs", path: `${outside}/secret.md` },
              ],
            }),
          ],
        });

        const manifest = yield* readOk(root);

        const steps = manifest.entities.flatMap((e) => e.steps);
        expect(steps).toHaveLength(4);
        for (const step of steps) {
          expect(step).toMatchObject({ relativePath: null, exists: false, issue: "escape" });
        }
        expect(manifest.issues.map((issue) => [issue.kind, issue.entityId, issue.stepIndex])).toEqual(
          [
            ["folder-escape", "up-folder", undefined],
            ["folder-escape", "abs-folder", undefined],
            ["step-escape", "bad-steps", 0],
            ["step-escape", "bad-steps", 1],
          ],
        );
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "flags a step symlinked outside the project root as an escape",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* makeRoot;
          const outside = yield* makeRoot;
          yield* writeFile(outside, "secret.md", "secret");
          yield* writeFile(root, "workspace/card/real.md", "# real");
          yield* fileSystem.symlink(
            path.join(outside, "secret.md"),
            path.join(root, "workspace/card/report.md"),
          );
          yield* writeManifest(root, {
            entities: [
              entity({
                steps: [
                  { name: "linked", path: "report.md" },
                  { name: "real", path: "real.md" },
                ],
              }),
            ],
          });

          const manifest = yield* readOk(root);

          expect(manifest.entities[0]?.steps).toEqual([
            { name: "linked", path: "report.md", relativePath: null, exists: false, issue: "escape" },
            { name: "real", path: "real.md", relativePath: "workspace/card/real.md", exists: true },
          ]);
          expect(manifest.issues).toMatchObject([{ kind: "step-escape", stepIndex: 0 }]);
        }),
    );

    it.effect("reports a missing or non-file step without failing the read", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* makeRoot;
        yield* fileSystem.makeDirectory(path.join(root, "workspace/card/dir"), { recursive: true });
        yield* writeManifest(root, {
          entities: [
            entity({
              steps: [
                { name: "gone", path: "gone.md" },
                { name: "dir", path: "dir" },
              ],
            }),
          ],
        });

        const manifest = yield* readOk(root);

        expect(manifest.entities[0]?.steps).toEqual([
          {
            name: "gone",
            path: "gone.md",
            relativePath: "workspace/card/gone.md",
            exists: false,
            issue: "missing",
          },
          {
            name: "dir",
            path: "dir",
            relativePath: "workspace/card/dir",
            exists: false,
            issue: "not-file",
          },
        ]);
        expect(manifest.issues.map((issue) => issue.kind)).toEqual(["step-missing", "step-not-file"]);
      }),
    );
  });

  it.effect("reports duplicate entity ids as an issue and keeps both entities", () =>
    Effect.gen(function* () {
      const root = yield* makeRoot;
      yield* writeFile(root, "workspace/card/report.md", "# hi");
      yield* writeManifest(root, { entities: [entity(), entity({ title: "Again" })] });

      const manifest = yield* readOk(root);

      expect(manifest.entities.map((e) => e.title)).toEqual(["Card", "Again"]);
      expect(manifest.issues).toEqual([
        { kind: "duplicate-id", entityId: "card", message: 'Entity id "card" appears more than once.' },
      ]);
    }),
  );

  it.effect("reads only the given project's root", () =>
    Effect.gen(function* () {
      const rootA = yield* makeRoot;
      const rootB = yield* makeRoot;
      yield* writeManifest(rootA, { entities: [entity({ id: "a-card", folder: "a" })] });
      yield* writeManifest(rootB, { entities: [entity({ id: "b-card", folder: "a" })] });
      yield* writeFile(rootB, "workspace/a/report.md", "only in B");

      const manifest = yield* readOk(rootA);

      expect(manifest.entities.map((e) => e.id)).toEqual(["a-card"]);
      expect(manifest.entities[0]?.steps[0]).toMatchObject({ exists: false, issue: "missing" });
    }),
  );

  it.effect("writes nothing: registry bytes, mtime and the project tree are unchanged", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* makeRoot;
      const registryPath = path.join(root, "workspace/workspace.json");
      // Trailing comma and an unknown key: a rewrite from the decoded schema would change both.
      const contents = '{"entities": [{"id":"card","title":"Card","folder":"card","steps":[],"x":1},]}';
      yield* writeFile(root, "workspace/workspace.json", contents);
      const listTree = fileSystem.readDirectory(root, { recursive: true }).pipe(
        Effect.map((entries) => [...entries].toSorted()),
      );
      const treeBefore = yield* listTree;
      const statBefore = yield* fileSystem.stat(registryPath);

      yield* readOk(root);
      yield* readOk(root);

      const statAfter = yield* fileSystem.stat(registryPath);
      expect(yield* fileSystem.readFileString(registryPath)).toBe(contents);
      expect(statAfter.mtime).toEqual(statBefore.mtime);
      expect(statAfter.size).toBe(statBefore.size);
      expect(yield* listTree).toEqual(treeBefore);
    }),
  );
});
