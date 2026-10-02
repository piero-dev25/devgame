// @effect-diagnostics nodeBuiltinImport:off
/**
 * MrMakImport against a real temp git repo shaped like the Mr. Mak trial:
 * committed content, then a polluted working tree (edits, untracked files,
 * secrets, live session data) that the plan must report but never import.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { MrMakImportPlan } from "@t3tools/contracts";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as MrMakImport from "./MrMakImport.ts";

const TestLayer = MrMakImport.layer.pipe(
  Layer.provide(GitVcsDriver.layer.pipe(Layer.provide(VcsProcess.layer))),
  Layer.provide(ProcessRunner.layer),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mrmak-import-test-" })),
);

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x10, 0x80]);
const REGISTRY = `{"entities": [{"id": "hero", "title": "Hero", "folder": "2026_hero", "steps": [
  {"name": "Board", "path": "index.html"},
  {"name": "Gone", "path": "missing.md"},
  {"name": "Sneaky", "path": "../../package.json"}
]}]}`;
const HTML = `<link rel="stylesheet" href="../_shared/report.css">
<img src="img/hero.png"><img src="img/gone.png"><a href="#top">top</a>
<a href="https://example.com/x">x</a><script src="/abs.js"></script>`;

const encodePlan = Schema.encodeSync(fromJsonStringPretty(MrMakImportPlan));

const sha256 = (bytes: string | Uint8Array) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=t@example.com",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } },
  );

const write = (root: string, relativePath: string, contents: string | Uint8Array) => {
  NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, relativePath)), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(root, relativePath), contents);
};

/** A committed Mr. Mak-shaped repo, then a polluted working tree, plus a destination. */
const makeFixture = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const base = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-mrmak-import-" }),
  );
  const source = NodePath.join(base, "source");
  const destination = NodePath.join(base, "destination");
  write(base, "outside-secret.txt", "not yours");
  const committed: Record<string, string | Uint8Array> = {
    "workspace/workspace.json": REGISTRY,
    "workspace/2026_hero/index.html": HTML,
    "workspace/2026_hero/img/hero.png": PNG,
    "workspace/2026_hero/notes.md":
      "[goals](../../context/goals.md) [app](../../src/app.ts) [win](C:\\Users\\me\\a.png)\n",
    "workspace/2026_hero/bad\\name.md": "windows path\n",
    "workspace/_shared/report.css": 'body { background: url("../2026_hero/img/hero.png"); }\n',
    "context/goals.md": "# Goals\n",
    "docs/guide.md": "# Guide v1\n",
    ".agents/skills/alpha/SKILL.md":
      "---\nname: alpha\ndescription: Alpha skill with a SECRET_DESCRIPTION.\nlicense: MIT\n---\n# Alpha\n",
    ".agents/skills/alpha/scripts/run.py": "print('hi')\n",
    ".agents/skills/alpha/references/ref.md": "# Ref\n",
    ".agents/skills/alpha/.github/workflow.yml": "on: push\n",
    ".claude/skills/alpha/SKILL.md": "---\nname: alpha\n---\n",
    ".mcp.json": '{"mcpServers": {"fal": {"command": "npx", "env": {"FAL_KEY": "sk-live-value"}}}}',
    ".env.example": "FAL_KEY=example-value\n",
    ".gitignore":
      ".env\n**/auth.json\n**/token.json\n.claude/settings.local.json\n.mrmak/\nnode_modules/\ndist/\n.cache/\n",
    "src/app.ts": "export const app = 1;\n",
    "src-tauri/main.rs": "fn main() {}\n",
    "desktop/service.mjs": "export {};\n",
    "scripts/sync-skills.mjs": "// copies skills\n",
    "package.json": "{}\n",
  };
  for (const [relativePath, contents] of Object.entries(committed)) {
    write(source, relativePath, contents);
  }
  if (symlinksSupported) {
    NodeFS.symlinkSync(
      "../../../outside-secret.txt",
      NodePath.join(source, "workspace/2026_hero/leak.txt"),
    );
    NodeFS.symlinkSync(
      "../_shared/report.css",
      NodePath.join(source, "workspace/2026_hero/alias.css"),
    );
  }
  git(source, "init", "-q");
  git(source, "add", "-A");
  git(source, "commit", "-q", "-m", "initial");

  // Working-tree pollution: none of it may reach the plan's content.
  write(source, "workspace/workspace.json", '{"entities": []}');
  write(source, "src/app.ts", "export const app = 2;\n");
  write(source, "workspace/2026_hero/draft.md", "# not committed\n");
  write(source, "workspace/node_modules/pkg/index.js", "module.exports = 1;\n");
  write(source, "workspace/auth.json", '{"token":"x"}');
  write(source, "context/token.json", '{"token":"y"}');
  write(source, ".env", "FAL_KEY=real\n");
  write(source, ".claude/settings.local.json", "{}");
  write(source, ".mrmak/session.json", '{"chat":"history"}');
  write(source, "node_modules/x/index.js", "1");
  write(source, "dist/out.js", "1");
  write(source, ".cache/blob", "1");

  write(destination, "context/goals.md", "# Goals\n");
  write(destination, "docs/guide.md", "# Guide edited at destination\n");
  return { base, source, destination };
});

const plan = (input: MrMakImport.MrMakImportPlanRequest) =>
  Effect.flatMap(MrMakImport.MrMakImport, (service) => service.plan(input));

const entry = (result: MrMakImportPlan, sourcePath: string) =>
  result.entries.find((candidate) => candidate.sourcePath === sourcePath);
const ruleOf = (result: MrMakImportPlan, path: string) =>
  result.exclusions.find((exclusion) => exclusion.path === path)?.rule;

/** Every file under a directory (including .git) with its size, mtime and hash. */
const snapshotTree = (root: string) => {
  const rows: Array<string> = [];
  const visit = (directory: string) => {
    for (const dirent of NodeFS.readdirSync(directory, { withFileTypes: true })) {
      const absolute = NodePath.join(directory, dirent.name);
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

it.layer(NodeServices.layer, { excludeTestServices: true })("MrMakImport.plan", (it) => {
  it.effect("inventories the selected roots from HEAD and excludes app code with reasons", () =>
    Effect.gen(function* () {
      const { source } = yield* makeFixture;
      const result = yield* plan({ sourceRoot: source });

      expect(result.source.revision).toBe(git(source, "rev-parse", "HEAD").trim());
      expect(result.source.branch).toBe(git(source, "symbolic-ref", "--short", "HEAD").trim());
      const png = entry(result, "workspace/2026_hero/img/hero.png");
      expect(png).toMatchObject({ kind: "media", bytes: PNG.length, sha256: sha256(PNG) });
      expect(entry(result, "workspace/workspace.json")?.kind).toBe("registry");
      expect(entry(result, "workspace/2026_hero/index.html")?.kind).toBe("card");
      expect(entry(result, "context/goals.md")?.kind).toBe("context");
      expect(entry(result, ".agents/skills/alpha/scripts/run.py")?.kind).toBe("script");
      expect(entry(result, ".agents/skills/alpha/references/ref.md")?.kind).toBe("reference");
      expect(entry(result, ".agents/skills/alpha/SKILL.md")?.kind).toBe("skill");

      const outsideRoots = result.entries.filter(
        (candidate) => !/^(workspace|context|docs|\.agents\/skills)\//.test(candidate.sourcePath),
      );
      expect(outsideRoots).toEqual([]);
      expect({
        ".git": ruleOf(result, ".git"),
        node_modules: ruleOf(result, "node_modules"),
        dist: ruleOf(result, "dist"),
        ".cache": ruleOf(result, ".cache"),
        ".mrmak": ruleOf(result, ".mrmak"),
        src: ruleOf(result, "src"),
        "src-tauri": ruleOf(result, "src-tauri"),
        desktop: ruleOf(result, "desktop"),
        "package.json": ruleOf(result, "package.json"),
        scripts: ruleOf(result, "scripts"),
        ".claude": ruleOf(result, ".claude"),
        ".mcp.json": ruleOf(result, ".mcp.json"),
      }).toEqual({
        ".git": "vcs",
        node_modules: "dependencies",
        dist: "build-output",
        ".cache": "cache",
        ".mrmak": "live-session",
        src: "app-code",
        "src-tauri": "app-code",
        desktop: "app-code",
        "package.json": "app-code",
        scripts: "app-tooling",
        ".claude": "skill-distribution",
        ".mcp.json": "requirement-template",
      });
      expect(result.excludedStores.map((store) => store.name).join()).toMatch(/chat history/i);
      expect(
        result.issues.filter((issue) => issue.kind === "malformed-path").map((issue) => issue.path),
      ).toEqual(["workspace/2026_hero/bad\\name.md"]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("reports secrets and untracked paths as excluded, never as entries", () =>
    Effect.gen(function* () {
      const { source } = yield* makeFixture;
      const result = yield* plan({ sourceRoot: source });

      for (const secret of [
        ".env",
        "workspace/auth.json",
        "context/token.json",
        ".claude/settings.local.json",
      ]) {
        expect([secret, ruleOf(result, secret)]).toEqual([secret, "secret"]);
      }
      expect(ruleOf(result, "workspace/2026_hero/draft.md")).toBe("untracked");
      expect(ruleOf(result, "workspace/node_modules/")).toBe("dependencies");
      expect(ruleOf(result, ".env.example")).toBe("requirement-template");
      expect(entry(result, "workspace/2026_hero/draft.md")).toBeUndefined();
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("plans committed content when the working tree has edits", () =>
    Effect.gen(function* () {
      const { source } = yield* makeFixture;
      const result = yield* plan({ sourceRoot: source });

      const registry = entry(result, "workspace/workspace.json");
      expect(registry).toMatchObject({
        sha256: sha256(REGISTRY),
        bytes: Buffer.byteLength(REGISTRY),
        headBlobOid: git(source, "rev-parse", "HEAD:workspace/workspace.json").trim(),
        dirtyInWorktree: true,
      });
      expect(result.source.dirtyPaths.toSorted()).toEqual([
        "src/app.ts",
        "workspace/workspace.json",
      ]);
      // The HEAD registry's steps are what get checked, not the emptied working copy.
      expect(registry?.links.map((link) => [link.href, link.status])).toEqual([
        ["2026_hero/index.html", "resolved"],
        ["2026_hero/missing.md", "missing"],
        ["2026_hero/../../package.json", "escape"],
      ]);
      expect(result.issues).toContainEqual(
        expect.objectContaining({ kind: "missing-step", path: "workspace/2026_hero/missing.md" }),
      );
      expect(result.issues).toContainEqual(
        expect.objectContaining({ kind: "escape", path: "workspace/2026_hero/../../package.json" }),
      );
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("resolves relative links and reports missing, external and malformed ones", () =>
    Effect.gen(function* () {
      const { source } = yield* makeFixture;
      const result = yield* plan({ sourceRoot: source });

      const linksOf = (path: string) =>
        entry(result, path)?.links.map((link) => [link.href, link.resolved, link.status]);
      expect(linksOf("workspace/2026_hero/index.html")).toEqual([
        ["../_shared/report.css", "workspace/_shared/report.css", "resolved"],
        ["img/hero.png", "workspace/2026_hero/img/hero.png", "resolved"],
        ["img/gone.png", "workspace/2026_hero/img/gone.png", "missing"],
        ["https://example.com/x", null, "external"],
        ["/abs.js", null, "external"],
      ]);
      expect(linksOf("workspace/_shared/report.css")).toEqual([
        ["../2026_hero/img/hero.png", "workspace/2026_hero/img/hero.png", "resolved"],
      ]);
      expect(linksOf("workspace/2026_hero/notes.md")).toEqual([
        ["../../context/goals.md", "context/goals.md", "resolved"],
        ["../../src/app.ts", "src/app.ts", "not-selected"],
        ["C:\\Users\\me\\a.png", null, "malformed"],
      ]);
      expect(result.issues).toContainEqual({
        kind: "missing-link",
        path: "workspace/2026_hero/index.html",
        detail: "img/gone.png does not exist in HEAD.",
      });
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect.skipIf(!symlinksSupported)("never plans a symlink that escapes its root", () =>
    Effect.gen(function* () {
      const { source } = yield* makeFixture;
      const result = yield* plan({ sourceRoot: source });

      expect(entry(result, "workspace/2026_hero/leak.txt")).toBeUndefined();
      expect(result.issues).toContainEqual(
        expect.objectContaining({ kind: "escape", path: "workspace/2026_hero/leak.txt" }),
      );
      expect(entry(result, "workspace/2026_hero/alias.css")?.symlinkTarget).toBe(
        "workspace/_shared/report.css",
      );
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("classifies destination conflicts by content", () =>
    Effect.gen(function* () {
      const { source, destination } = yield* makeFixture;
      const result = yield* plan({ sourceRoot: source, destinationRoot: destination });

      expect(entry(result, "context/goals.md")?.destination).toBe("exists-identical");
      expect(entry(result, "docs/guide.md")?.destination).toBe("exists-different");
      expect(entry(result, "workspace/workspace.json")?.destination).toBe("new");
      expect(result.totals).toMatchObject({
        existsIdentical: 1,
        existsDifferent: 1,
        new: result.entries.length - 2,
      });
      const unchecked = yield* plan({ sourceRoot: source });
      expect(new Set(unchecked.entries.map((candidate) => candidate.destination))).toEqual(
        new Set(["not-checked"]),
      );
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("counts the skill tree twice and lists requirements without values", () =>
    Effect.gen(function* () {
      const { source } = yield* makeFixture;
      const result = yield* plan({ sourceRoot: source, roots: [".agents/skills", "context"] });

      expect(result.skills).toEqual({ fullTreeFiles: 4, distributionFiles: 3 });
      expect(ruleOf(result, "docs")).toBe("not-selected");
      expect(ruleOf(result, "workspace")).toBe("not-selected");
      expect(result.requirements).toEqual(
        expect.arrayContaining([
          { source: ".mcp.json", kind: "mcp-server", name: "fal", keys: ["FAL_KEY"] },
          { source: ".env.example", kind: "env-var", name: "FAL_KEY", keys: [] },
          {
            source: ".agents/skills/alpha/SKILL.md",
            kind: "skill",
            name: "alpha",
            keys: ["name", "description", "license"],
          },
        ]),
      );
      const serialized = encodePlan({ ...result, entries: [] });
      expect(serialized).not.toMatch(/sk-live-value|example-value|SECRET_DESCRIPTION/);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("writes nothing to the source, its git dir, the destination or HOME", () =>
    Effect.gen(function* () {
      const { base, source, destination } = yield* makeFixture;
      const home = NodePath.join(base, "home");
      NodeFS.mkdirSync(home);
      const before = [
        snapshotTree(source),
        snapshotTree(destination),
        git(source, "status", "--porcelain"),
      ];
      const previousHome = process.env.HOME;
      process.env.HOME = home;
      yield* plan({ sourceRoot: source, destinationRoot: destination }).pipe(
        Effect.ensuring(Effect.sync(() => (process.env.HOME = previousHome))),
      );
      expect([
        snapshotTree(source),
        snapshotTree(destination),
        git(source, "status", "--porcelain"),
      ]).toEqual(before);
      expect(NodeFS.readdirSync(home)).toEqual([]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("refuses a folder that is not a repository root", () =>
    Effect.gen(function* () {
      const { source } = yield* makeFixture;
      const error = yield* plan({ sourceRoot: NodePath.join(source, "workspace") }).pipe(
        Effect.flip,
      );
      expect(error).toBeInstanceOf(MrMakImport.MrMakImportPlanError);
      expect(error.reason).toBe("not-repository-root");
    }).pipe(Effect.provide(TestLayer)),
  );

  /**
   * The real dry run against the Mr. Mak trial. Opt-in:
   * DEVGAME_MRMAK_IMPORT_LIVE=1 MRMAK_SOURCE=... MRMAK_DEST=... MRMAK_PLAN_OUT=plan.json
   */
  it.effect.skipIf(process.env.DEVGAME_MRMAK_IMPORT_LIVE !== "1")(
    "live: plans the real Mr. Mak workspace without writing to it",
    () =>
      Effect.gen(function* () {
        const source = process.env.MRMAK_SOURCE ?? "";
        const out = process.env.MRMAK_PLAN_OUT ?? "";
        expect([source.length > 0, out.length > 0]).toEqual([true, true]);
        const indexPath = NodePath.join(source, ".git/index");
        const before = [git(source, "status", "--porcelain"), NodeFS.statSync(indexPath).mtimeMs];
        const result = yield* plan({ sourceRoot: source, destinationRoot: process.env.MRMAK_DEST });
        expect([git(source, "status", "--porcelain"), NodeFS.statSync(indexPath).mtimeMs]).toEqual(
          before,
        );
        expect(result.entries.length).toBeGreaterThan(0);
        NodeFS.writeFileSync(out, `${encodePlan(result)}\n`);
      }).pipe(Effect.provide(TestLayer)),
    120_000,
  );
});
