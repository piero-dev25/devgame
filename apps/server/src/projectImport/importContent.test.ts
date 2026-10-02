// @effect-diagnostics nodeBuiltinImport:off
/**
 * MrMakImport.importContent against a real temp source repo and a new
 * comparison destination: first import, reruns, a changed source, an
 * interrupted import (resume and rollback) and link resolution afterwards.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterAll, beforeAll, expect, it, vi } from "@effect/vitest";
import { MrMakImportReceipt } from "@t3tools/contracts";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { makeProviderRegistryLayer } from "../provider/testUtils/providerRegistryMock.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as ProjectWorkspace from "../projectWorkspace/ProjectWorkspace.ts";
import type { ImportContentRequest } from "./importContent.ts";
import * as MrMakImport from "./MrMakImport.ts";

const withDependencies = <E, R>(service: Layer.Layer<MrMakImport.MrMakImport, E, R>) =>
  service.pipe(
    Layer.provide(GitVcsDriver.layer.pipe(Layer.provide(VcsProcess.layer))),
    Layer.provide(ProcessRunner.layer),
    Layer.provide(makeProviderRegistryLayer()),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mrmak-content-test-" })),
  );
const TestLayer = withDependencies(MrMakImport.layer);

type InterruptedCall = "rename" | "writeFile" | "remove";

/** A file system whose `rename`, `writeFile` or `remove` fails where `fails` says so. */
const failingFileSystem = (fails: (method: InterruptedCall, path: string) => boolean) =>
  Layer.effect(
    FileSystem.FileSystem,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const injected = (method: InterruptedCall, pathOrDescriptor: string) =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "Unknown",
            module: "FileSystem",
            method,
            description: "injected interruption",
            pathOrDescriptor,
          }),
        );
      return {
        ...fileSystem,
        rename: (from: string, to: string) =>
          fails("rename", from) ? injected("rename", from) : fileSystem.rename(from, to),
        writeFile: (...args: Parameters<FileSystem.FileSystem["writeFile"]>) =>
          fails("writeFile", args[0])
            ? injected("writeFile", args[0])
            : fileSystem.writeFile(...args),
        remove: (...args: Parameters<FileSystem.FileSystem["remove"]>) =>
          fails("remove", args[0]) ? injected("remove", args[0]) : fileSystem.remove(...args),
      } satisfies FileSystem.FileSystem;
    }),
  );

/** A service on a failing file system. `fresh`, so the test's already-built service is not reused. */
const interruptedWhen = (fails: (method: InterruptedCall, path: string) => boolean) =>
  withDependencies(Layer.fresh(MrMakImport.layer).pipe(Layer.provide(failingFileSystem(fails))));
const isStaged = (filePath: string) =>
  filePath.includes("/.devgame/import/staging/") && filePath.includes("/files/");
/** Moves out of a staging `files/` folder fail after the first `successes`. */
const interruptedAfter = (successes: number) => {
  let moves = 0;
  return interruptedWhen(
    (method, from) => method === "rename" && isStaged(from) && ++moves > successes,
  );
};
const WorkspaceReaderLayer = ProjectWorkspace.layer.pipe(
  Layer.provide(
    WorkspaceFileSystem.layer.pipe(
      Layer.provide(WorkspacePaths.layer),
      Layer.provide(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
    ),
  ),
  Layer.provide(WorkspacePaths.layer),
  Layer.provide(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mrmak-content-ws-" })),
);

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x10, 0x80]);
const MP4 = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x0d, 0x0a, 0xfe]);
// Odd spacing and an unknown key: only a byte-for-byte copy keeps both.
const REGISTRY = `{ "entities": [
  {"id": "hero", "title": "Hero", "folder": "2026_hero", "defaultStep": 1, "x-board": {"zoom": 2},
   "steps": [{"name": "Board", "path": "index.html"}, {"name": "Notes", "path": "notes.md"}]},
  {"id": "villain", "title": "Villain", "folder": "2026_villain",
   "steps": [{"name": "Report", "path": "report.html"}]}
] }
`;

const sha256 = (bytes: string | Uint8Array) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", ["-c", "core.safecrlf=false", ...args], {
    cwd,
    encoding: "utf8",
  });

const write = (root: string, relativePath: string, contents: string | Uint8Array) => {
  NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, relativePath)), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(root, relativePath), contents);
};
const read = (root: string, relativePath: string) =>
  NodeFS.readFileSync(NodePath.join(root, relativePath), "utf8");
/** A file's bytes, or a symlink's own link text. */
const contentsAt = (root: string, relativePath: string) => {
  const absolute = NodePath.join(root, relativePath);
  return NodeFS.lstatSync(absolute).isSymbolicLink()
    ? NodeFS.readlinkSync(absolute)
    : NodeFS.readFileSync(absolute);
};
const exists = (root: string, relativePath: string) =>
  NodeFS.existsSync(NodePath.join(root, relativePath));

/** Every path under `root` (optionally skipping one child) with its size, mtime and hash. */
const snapshotTree = (root: string, skip?: string) => {
  const rows: Array<string> = [];
  const visit = (directory: string) => {
    for (const dirent of NodeFS.readdirSync(directory, { withFileTypes: true })) {
      const absolute = NodePath.join(directory, dirent.name);
      if (absolute === skip) continue;
      const stat = NodeFS.lstatSync(absolute);
      if (dirent.isDirectory()) {
        rows.push(`${absolute}/ ${stat.mtimeMs}`);
        visit(absolute);
      } else {
        const contents = dirent.isSymbolicLink()
          ? NodeFS.readlinkSync(absolute)
          : NodeFS.readFileSync(absolute);
        rows.push(`${absolute} ${stat.size} ${stat.mtimeMs} ${sha256(contents)}`);
      }
    }
  };
  visit(root);
  return rows.toSorted();
};

beforeAll(() => {
  // Commits made here and by the importer need an identity and no signing prompt.
  vi.stubEnv("GIT_AUTHOR_NAME", "Test");
  vi.stubEnv("GIT_AUTHOR_EMAIL", "t@example.com");
  vi.stubEnv("GIT_COMMITTER_NAME", "Test");
  vi.stubEnv("GIT_COMMITTER_EMAIL", "t@example.com");
  vi.stubEnv("GIT_CONFIG_COUNT", "1");
  vi.stubEnv("GIT_CONFIG_KEY_0", "commit.gpgsign");
  vi.stubEnv("GIT_CONFIG_VALUE_0", "false");
});
afterAll(() => {
  vi.unstubAllEnvs();
});

/** A committed Mr. Mak-shaped source with a polluted working tree; the destination does not exist yet. */
const makeFixture = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const base = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-mrmak-content-" }),
  );
  const source = NodePath.join(base, "source");
  const destination = NodePath.join(base, "comparison");
  const committed: Record<string, string | Uint8Array> = {
    "workspace/workspace.json": REGISTRY,
    "workspace/2026_hero/index.html":
      '<link rel="stylesheet" href="../_shared/report.css"><img src="img/hero.png">\n',
    "workspace/2026_hero/notes.md": "[goals](../../context/goals.md)\n",
    "workspace/2026_hero/img/hero.png": PNG,
    "workspace/2026_villain/report.html":
      '<link href="../_shared/report.css" rel="stylesheet"><video src="media/clip.mp4"></video>\n',
    "workspace/2026_villain/media/clip.mp4": MP4,
    "workspace/_shared/report.css": 'body { background: url("../2026_hero/img/hero.png"); }\n',
    "context/goals.md": "# Goals\n",
    "docs/guide.md": "# Guide v1\n",
    "docs/old.md": "# Old\n",
    ".agents/skills/alpha/SKILL.md": "---\nname: alpha\n---\nRun [it](scripts/run.py).\n",
    ".agents/skills/alpha/scripts/run.py": "print('hi')\n",
    "src/app.ts": "export const app = 1;\n",
  };
  for (const [relativePath, contents] of Object.entries(committed)) {
    write(source, relativePath, contents);
  }
  if (symlinksSupported) {
    NodeFS.symlinkSync(
      "../_shared/report.css",
      NodePath.join(source, "workspace/2026_hero/alias.css"),
    );
  }
  NodeFS.chmodSync(NodePath.join(source, ".agents/skills/alpha/scripts/run.py"), 0o755);
  git(source, "init", "-q");
  git(source, "add", "-A");
  git(source, "commit", "-q", "-m", "initial");
  write(source, "workspace/workspace.json", '{"entities": []}');
  write(source, ".env", "FAL_KEY=real\n");
  return { base, source, destination };
});

const withService = <A, E>(
  use: (service: MrMakImport.MrMakImport["Service"]) => Effect.Effect<A, E>,
) => Effect.flatMap(MrMakImport.MrMakImport, use);
const planFor = (source: string, destination: string) =>
  withService((service) => service.plan({ sourceRoot: source, destinationRoot: destination }));
const importInto = (destination: string, request: Omit<ImportContentRequest, "destinationRoot">) =>
  withService((service) => service.importContent({ ...request, destinationRoot: destination }));
const planAndImport = (source: string, destination: string) =>
  Effect.flatMap(planFor(source, destination), (plan) => importInto(destination, { plan }));

const readWorkspace = (destination: string) =>
  Effect.flatMap(ProjectWorkspace.ProjectWorkspace, (reader) =>
    reader.readManifest(destination),
  ).pipe(Effect.provide(WorkspaceReaderLayer));
const readReceipt = (destination: string) =>
  Schema.decodeSync(fromLenientJson(MrMakImportReceipt))(
    read(destination, ".devgame/import/receipt.json"),
  );
const outcomeOf = (receipt: MrMakImportReceipt, path: string) =>
  receipt.files.find((file) => file.path === path)?.outcome;
const stagingEntries = (destination: string) =>
  exists(destination, ".devgame/import/staging")
    ? NodeFS.readdirSync(NodePath.join(destination, ".devgame/import/staging"))
    : [];

it.layer(NodeServices.layer, { excludeTestServices: true })("MrMakImport.importContent", (it) => {
  it.effect("first import copies committed bytes into a new repo with a labelled commit", () =>
    Effect.gen(function* () {
      const { base, source, destination } = yield* makeFixture;
      const sourceBefore = snapshotTree(source);
      const outsideBefore = snapshotTree(base, destination);
      const plan = yield* planFor(source, destination);
      const result = yield* importInto(destination, { plan });

      expect(result.status).toBe("imported");
      expect(result.receiptPath).toBe(NodePath.join(destination, ".devgame/import/receipt.json"));
      const receipt = readReceipt(destination);
      expect(receipt).toEqual(result.receipt);
      expect(receipt.source.revision).toBe(git(source, "rev-parse", "HEAD").trim());
      expect(receipt.transforms).toEqual([]);
      expect(receipt.conflicts).toEqual([]);
      expect(receipt.exclusions.find((exclusion) => exclusion.path === "src")?.rule).toBe(
        "app-code",
      );
      expect(receipt.files.map((file) => file.outcome)).toEqual(plan.entries.map(() => "written"));
      for (const entry of plan.entries) {
        const bytes = contentsAt(destination, entry.destinationPath);
        expect([entry.destinationPath, sha256(bytes)]).toEqual([
          entry.destinationPath,
          entry.sha256,
        ]);
      }
      // The registry and media are HEAD's bytes, not the polluted working tree.
      expect(read(destination, "workspace/workspace.json")).toBe(REGISTRY);
      expect(
        NodeFS.readFileSync(NodePath.join(destination, "workspace/2026_hero/img/hero.png")),
      ).toEqual(PNG);
      if (symlinksSupported) {
        const alias = NodePath.join(destination, "workspace/2026_hero/alias.css");
        expect(NodeFS.readlinkSync(alias)).toBe("../_shared/report.css");
      }
      expect(exists(destination, "src/app.ts") || exists(destination, ".env")).toBe(false);
      expect(stagingEntries(destination)).toEqual([]);

      const manifest = yield* readWorkspace(destination);
      expect(manifest._tag).toBe("ok");
      if (manifest._tag !== "ok") return;
      expect(
        manifest.manifest.entities.map((entity) => [
          entity.id,
          entity.defaultStep,
          entity.steps.map((step) => step.name),
        ]),
      ).toEqual([
        ["hero", 1, ["Board", "Notes"]],
        ["villain", undefined, ["Report"]],
      ]);

      expect(result.commit).toEqual({ status: "committed", detail: null });
      expect(git(destination, "log", "--format=%s").trim()).toBe(
        "Import Mr. Mak original content (DevGame import)",
      );
      expect(git(destination, "ls-files").trim().split("\n").toSorted()).toEqual(
        [
          ...plan.entries.map((entry) => entry.destinationPath),
          ".devgame/import/.gitignore",
          ".devgame/import/receipt.json",
        ].toSorted(),
      );
      expect(git(destination, "status", "--porcelain")).toBe("");
      // The executable bit survives, on disk and in the baseline commit.
      const script = ".agents/skills/alpha/scripts/run.py";
      expect(plan.entries.find((entry) => entry.destinationPath === script)?.executable).toBe(true);
      expect(NodeFS.statSync(NodePath.join(destination, script)).mode & 0o111).not.toBe(0);
      expect(NodeFS.statSync(NodePath.join(destination, "docs/guide.md")).mode & 0o111).toBe(0);
      expect(git(destination, "ls-files", "-s", "--", script).split(" ")[0]).toBe("100755");
      expect(git(destination, "ls-files", "-s", "--", "docs/guide.md").split(" ")[0]).toBe(
        "100644",
      );
      expect(snapshotTree(source)).toEqual(sourceBefore);
      expect(snapshotTree(base, destination)).toEqual(outsideBefore);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("rerunning the same source changes nothing and keeps additions and local edits", () =>
    Effect.gen(function* () {
      const { source, destination } = yield* makeFixture;
      yield* planAndImport(source, destination);
      write(destination, "workspace/2026_hero/adaptation.md", "# DevGame adaptation\n");
      write(destination, "docs/guide.md", "# Guide, adapted\n");
      NodeFS.rmSync(NodePath.join(destination, "docs/old.md"));
      const before = snapshotTree(destination);

      const rerun = yield* planAndImport(source, destination);

      expect(rerun.status).toBe("unchanged");
      expect(snapshotTree(destination)).toEqual(before);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "a changed source lists its diff, updates untouched files and never overwrites edits",
    () =>
      Effect.gen(function* () {
        const { source, destination } = yield* makeFixture;
        const first = yield* planAndImport(source, destination);
        write(destination, "docs/guide.md", "# Guide, adapted\n");
        write(destination, "context/goals.md", "# Goals, adapted\n");
        write(destination, "workspace/2026_hero/adaptation.md", "# Mine\n");
        write(source, "docs/guide.md", "# Guide v2\n");
        write(source, "workspace/2026_hero/notes.md", "[goals](../../context/goals.md) v2\n");
        write(source, "docs/new.md", "# New\n");
        git(source, "rm", "-q", "docs/old.md");
        git(source, "add", "docs", "workspace/2026_hero/notes.md");
        git(source, "commit", "-q", "-m", "v2");

        const plan = yield* planFor(source, destination);
        const second = yield* importInto(destination, { plan });
        const receipt = second.receipt;

        expect(receipt.previousImportId).toBe(first.receipt.importId);
        expect(receipt.changes.map((change) => [change.path, change.change]).toSorted()).toEqual([
          ["docs/guide.md", "modified"],
          ["docs/new.md", "added"],
          ["docs/old.md", "removed"],
          ["workspace/2026_hero/notes.md", "modified"],
        ]);
        expect({
          guide: outcomeOf(receipt, "docs/guide.md"),
          goals: outcomeOf(receipt, "context/goals.md"),
          notes: outcomeOf(receipt, "workspace/2026_hero/notes.md"),
          added: outcomeOf(receipt, "docs/new.md"),
        }).toEqual({ guide: "conflict", goals: "kept-local", notes: "updated", added: "written" });
        expect(receipt.conflicts.map((conflict) => conflict.path)).toEqual(["docs/guide.md"]);
        expect(read(destination, "docs/guide.md")).toBe("# Guide, adapted\n");
        expect(read(destination, "context/goals.md")).toBe("# Goals, adapted\n");
        expect(read(destination, "workspace/2026_hero/notes.md")).toContain("v2");
        expect(read(destination, "docs/old.md")).toBe("# Old\n");
        expect(read(destination, "workspace/2026_hero/adaptation.md")).toBe("# Mine\n");
        expect(
          read(
            destination,
            `.devgame/import/replaced/${receipt.importId}/workspace/2026_hero/notes.md`,
          ),
        ).toBe("[goals](../../context/goals.md)\n");
        expect(second.commit.status).toBe("skipped");
        expect(git(destination, "log", "--format=%s").trim().split("\n")).toHaveLength(1);

        // Only an explicit choice takes the source over the local edit, and the edit is kept aside.
        const chosen = yield* importInto(destination, {
          plan,
          choices: { "docs/guide.md": "take-source" },
        });
        expect(outcomeOf(chosen.receipt, "docs/guide.md")).toBe("replaced");
        expect(outcomeOf(chosen.receipt, "context/goals.md")).toBe("kept-local");
        expect(read(destination, "docs/guide.md")).toBe("# Guide v2\n");
        expect(
          read(destination, `.devgame/import/replaced/${chosen.receipt.importId}/docs/guide.md`),
        ).toBe("# Guide, adapted\n");
        expect(read(destination, "context/goals.md")).toBe("# Goals, adapted\n");
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("an interrupted import publishes no receipt and resumes from its staged writes", () =>
    Effect.gen(function* () {
      const { source, destination } = yield* makeFixture;
      const plan = yield* planFor(source, destination);
      const failure = yield* importInto(destination, { plan }).pipe(
        Effect.provide(interruptedAfter(3)),
        Effect.flip,
      );
      expect(failure.reason).toBe("filesystem");
      expect(exists(destination, ".devgame/import/receipt.json")).toBe(false);
      const [importId] = stagingEntries(destination);
      expect(exists(destination, `.devgame/import/staging/${importId}/manifest.json`)).toBe(true);
      const landed = plan.entries.filter((entry) => exists(destination, entry.destinationPath));
      expect(landed).toHaveLength(3);

      // A different plan cannot start on top of the interrupted one.
      const other = yield* importInto(destination, {
        plan: { ...plan, entries: plan.entries.slice(1) },
      }).pipe(Effect.flip);
      expect(other.reason).toBe("pending-import");

      const resumed = yield* importInto(destination, { plan });
      expect(resumed.status).toBe("imported");
      expect(resumed.receipt.importId).toBe(importId);
      expect(resumed.receipt.files.every((file) => file.outcome === "written")).toBe(true);
      for (const entry of plan.entries) {
        expect(sha256(contentsAt(destination, entry.destinationPath))).toBe(entry.sha256);
      }
      expect(stagingEntries(destination)).toEqual([]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("rolling back an interrupted import removes only its own untouched writes", () =>
    Effect.gen(function* () {
      const { source, destination } = yield* makeFixture;
      write(destination, "workspace/2026_hero/user-note.md", "# Mine\n");
      write(destination, "docs/guide.md", "# My guide\n");
      const plan = yield* planFor(source, destination);
      const writes = plan.entries.filter((entry) => entry.destination !== "exists-identical");
      yield* importInto(destination, { plan, choices: { "docs/guide.md": "take-source" } }).pipe(
        Effect.provide(interruptedAfter(writes.length - 2)),
        Effect.flip,
      );
      expect(read(destination, "docs/guide.md")).toBe("# Guide v1\n");
      write(destination, "context/goals.md", "# Goals, edited after the interruption\n");
      const [importId = ""] = stagingEntries(destination);

      const result = yield* withService((service) =>
        service.rollbackImport({ destinationRoot: destination, importId }),
      );

      expect(result.kept).toEqual(["context/goals.md"]);
      expect(result.restored).toEqual(["docs/guide.md"]);
      expect(result.removed).toHaveLength(writes.length - 3);
      expect(read(destination, "docs/guide.md")).toBe("# My guide\n");
      expect(read(destination, "workspace/2026_hero/user-note.md")).toBe("# Mine\n");
      expect(read(destination, "context/goals.md")).toBe(
        "# Goals, edited after the interruption\n",
      );
      const left = snapshotTree(destination)
        .map((row) => NodePath.relative(destination, row.split(" ")[0] ?? ""))
        .filter((relative) => !relative.startsWith(".devgame"));
      // Folders the import created are gone again; the user's folders and files remain.
      expect(left.toSorted()).toEqual([
        "context",
        "context/goals.md",
        "docs",
        "docs/guide.md",
        "workspace",
        "workspace/2026_hero",
        "workspace/2026_hero/user-note.md",
      ]);
      expect(stagingEntries(destination)).toEqual([]);
      expect(exists(destination, ".devgame/import/receipt.json")).toBe(false);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("every card step, report link and media reference resolves after import", () =>
    Effect.gen(function* () {
      const { source, destination } = yield* makeFixture;
      const plan = yield* planFor(source, destination);
      expect(plan.issues).toEqual([]);
      yield* importInto(destination, { plan });

      const links = plan.entries.flatMap((entry) =>
        entry.links.map((link) => ({ from: entry.destinationPath, ...link })),
      );
      expect(links.map((link) => link.resolved)).toEqual(
        expect.arrayContaining([
          "workspace/_shared/report.css",
          "workspace/2026_hero/img/hero.png",
          "workspace/2026_villain/media/clip.mp4",
          "context/goals.md",
          ".agents/skills/alpha/scripts/run.py",
        ]),
      );
      for (const link of links) {
        expect([link.from, link.href, link.status]).toEqual([link.from, link.href, "resolved"]);
        expect([link.resolved, exists(destination, link.resolved ?? "")]).toEqual([
          link.resolved,
          true,
        ]);
      }
      const manifest = yield* readWorkspace(destination);
      expect(manifest._tag === "ok" ? manifest.manifest.issues : manifest).toEqual([]);
      if (manifest._tag !== "ok") return;
      expect(
        manifest.manifest.entities.flatMap((entity) => entity.steps.map((step) => step.exists)),
      ).toEqual([true, true, true]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("refuses a destination inside the source and writes nothing there", () =>
    Effect.gen(function* () {
      const { source } = yield* makeFixture;
      const before = snapshotTree(source);
      const plan = yield* planFor(source, NodePath.join(source, "comparison"));
      const error = yield* importInto(NodePath.join(source, "comparison"), { plan }).pipe(
        Effect.flip,
      );
      expect(error.reason).toBe("unsafe-destination");
      expect(snapshotTree(source)).toEqual(before);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "refuses home, hidden home folders and symlinked parents before creating anything",
    () =>
      Effect.gen(function* () {
        const { base, source, destination } = yield* makeFixture;
        const plan = yield* planFor(source, destination);
        const home = NodeOS.homedir();
        const hidden = `.devgame-import-test-${NodeCrypto.randomUUID()}`;
        const refused = (target: string) =>
          importInto(target, { plan }).pipe(
            Effect.flip,
            Effect.map((error) => error.reason),
          );
        const sourceBefore = snapshotTree(source);
        try {
          expect(yield* refused(home)).toBe("unsafe-destination");
          expect(yield* refused(NodePath.join(home, hidden, "comparison"))).toBe(
            "unsafe-destination",
          );
          if (symlinksSupported) {
            NodeFS.symlinkSync(source, NodePath.join(base, "source-link"));
            NodeFS.symlinkSync(home, NodePath.join(base, "home-link"));
            expect(yield* refused(NodePath.join(base, "source-link/comparison"))).toBe(
              "unsafe-destination",
            );
            expect(yield* refused(NodePath.join(base, "home-link", hidden, "comparison"))).toBe(
              "unsafe-destination",
            );
          }
          expect(exists(source, "comparison")).toBe(false);
          expect(snapshotTree(source)).toEqual(sourceBefore);
          expect(exists(home, hidden)).toBe(false);
        } finally {
          NodeFS.rmSync(NodePath.join(home, hidden), { recursive: true, force: true });
        }
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("a rerun with choices that no longer matter is unchanged and keeps the receipt", () =>
    Effect.gen(function* () {
      const { source, destination } = yield* makeFixture;
      yield* planAndImport(source, destination);
      write(destination, "docs/guide.md", "# Guide, adapted\n");
      write(source, "docs/guide.md", "# Guide v2\n");
      git(source, "add", "docs/guide.md");
      git(source, "commit", "-q", "-m", "v2");
      const plan = yield* planFor(source, destination);
      const conflicted = yield* importInto(destination, { plan });
      expect(conflicted.receipt.conflicts.map((conflict) => conflict.path)).toEqual([
        "docs/guide.md",
      ]);
      const chosen = yield* importInto(destination, {
        plan,
        choices: { "docs/guide.md": "take-source" },
      });
      expect(outcomeOf(chosen.receipt, "docs/guide.md")).toBe("replaced");
      const receiptBefore = read(destination, ".devgame/import/receipt.json");

      const withoutChoice = yield* importInto(destination, { plan });
      const keepChoice = yield* importInto(destination, {
        plan,
        choices: { "docs/guide.md": "keep-destination" },
      });
      const sameChoice = yield* importInto(destination, {
        plan,
        choices: { "docs/guide.md": "take-source" },
      });

      expect([withoutChoice.status, keepChoice.status, sameChoice.status]).toEqual([
        "unchanged",
        "unchanged",
        "unchanged",
      ]);
      expect(withoutChoice.receipt.importId).toBe(chosen.receipt.importId);
      expect(read(destination, ".devgame/import/receipt.json")).toBe(receiptBefore);
      expect(stagingEntries(destination)).toEqual([]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("the baseline commit takes glob-like names literally and nothing else", () =>
    Effect.gen(function* () {
      const { source, destination } = yield* makeFixture;
      write(source, "docs/[d].md", "# Bracketed\n");
      git(source, "add", "docs/[d].md");
      git(source, "commit", "-q", "-m", "bracketed");
      write(destination, "docs/d.md", "# Private\n");
      write(destination, "docs/x.md", "# Also private\n");

      const result = yield* planAndImport(source, destination);

      expect(result.commit.status).toBe("committed");
      const committed = git(destination, "ls-files").trim().split("\n");
      expect(committed).toContain("docs/[d].md");
      expect(committed).not.toContain("docs/d.md");
      expect(committed).not.toContain("docs/x.md");
      expect(read(destination, "docs/d.md")).toBe("# Private\n");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "a crash after the receipt is published cannot be rolled back and the rerun commits",
    () =>
      Effect.gen(function* () {
        const { source, destination } = yield* makeFixture;
        const plan = yield* planFor(source, destination);
        const crashed = yield* importInto(destination, { plan }).pipe(
          Effect.provide(
            interruptedWhen(
              (method, filePath) =>
                method === "remove" && /\/\.devgame\/import\/staging\/[0-9a-f]{16}$/.test(filePath),
            ),
          ),
          Effect.flip,
        );
        expect(crashed.reason).toBe("filesystem");
        const receipt = readReceipt(destination);
        expect(stagingEntries(destination)).toEqual([receipt.importId]);
        expect(exists(destination, ".git")).toBe(false);

        const rollback = yield* withService((service) =>
          service.rollbackImport({ destinationRoot: destination, importId: receipt.importId }),
        ).pipe(Effect.flip);
        expect(rollback.reason).toBe("nothing-to-roll-back");
        for (const entry of plan.entries) {
          expect([entry.destinationPath, exists(destination, entry.destinationPath)]).toEqual([
            entry.destinationPath,
            true,
          ]);
        }

        const rerun = yield* importInto(destination, { plan });
        expect(rerun.status).toBe("unchanged");
        expect(rerun.commit).toEqual({ status: "committed", detail: null });
        expect(git(destination, "log", "--format=%s").trim()).toBe(
          "Import Mr. Mak original content (DevGame import)",
        );
        expect(git(destination, "status", "--porcelain")).toBe("");
        expect(stagingEntries(destination)).toEqual([]);

        const again = yield* importInto(destination, { plan });
        expect(again.commit.status).toBe("skipped");
        expect(git(destination, "log", "--format=%s").trim().split("\n")).toHaveLength(1);
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("rolling back an import cut short while staging reports nothing as kept", () =>
    Effect.gen(function* () {
      const { base, source, destination } = yield* makeFixture;
      write(destination, "docs/guide.md", "# My guide\n");
      const plan = yield* planFor(source, destination);
      yield* importInto(destination, { plan, choices: { "docs/guide.md": "take-source" } }).pipe(
        Effect.provide(
          interruptedWhen((method, filePath) => method === "writeFile" && isStaged(filePath)),
        ),
        Effect.flip,
      );
      const [importId = ""] = stagingEntries(destination);

      const result = yield* withService((service) =>
        service.rollbackImport({ destinationRoot: destination, importId }),
      );

      expect(result).toEqual({ removed: [], restored: [], kept: [] });
      expect(read(destination, "docs/guide.md")).toBe("# My guide\n");
      expect(stagingEntries(destination)).toEqual([]);

      // Rolling back somewhere that does not exist creates nothing.
      const missing = yield* withService((service) =>
        service.rollbackImport({
          destinationRoot: NodePath.join(base, "never", "made"),
          importId,
        }),
      ).pipe(Effect.flip);
      expect(missing.reason).toBe("nothing-to-roll-back");
      expect(exists(base, "never")).toBe(false);
    }).pipe(Effect.provide(TestLayer)),
  );

  const live = process.env.DEVGAME_MRMAK_IMPORT_LIVE === "1";
  it.effect.skipIf(!live)(
    "imports the real Mr. Mak workspace (DEVGAME_MRMAK_IMPORT_LIVE=1, MRMAK_SOURCE, MRMAK_DEST)",
    () =>
      Effect.gen(function* () {
        const source = process.env.MRMAK_SOURCE ?? "";
        const destination = process.env.MRMAK_DEST ?? "";
        expect([NodePath.isAbsolute(source), NodePath.isAbsolute(destination)]).toEqual([
          true,
          true,
        ]);
        const result = yield* planAndImport(source, destination);
        yield* Effect.sync(() =>
          process.stdout.write(
            `Mr. Mak import ${result.status}: receipt ${result.receiptPath} ` +
              `(${result.receipt.files.length} files, ${result.receipt.conflicts.length} conflicts, ` +
              `commit ${result.commit.status})\n`,
          ),
        );
        expect(result.receipt.transforms).toEqual([]);
      }).pipe(Effect.provide(TestLayer)),
    10 * 60_000,
  );
});
