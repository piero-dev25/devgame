// @effect-diagnostics nodeBuiltinImport:off
/**
 * MrMakImport.importSkills against a real temp source repo: the full
 * `.agents/skills` tree, the `.claude/skills` sync subset, per-skill conflict
 * choices, reruns, HOME isolation, and what each provider's discovery reports.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterAll, beforeAll, expect, it, vi } from "@effect/vitest";
import {
  MrMakImportReceipt,
  MrMakSkillDiscoveryReport,
  ServerProvider,
  type MrMakSkillConflictChoice,
  type ServerProviderSkill,
} from "@t3tools/contracts";
import { fromJsonStringPretty, fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { makeProviderRegistryLayer } from "../provider/testUtils/providerRegistryMock.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { MrMakSkillImportError } from "./importSkills.ts";
import * as MrMakImport from "./MrMakImport.ts";
import { checkSkillDiscovery, cliSkillProbe, discoveryReport } from "./skillDiscovery.ts";

/** `fresh`, so a test's own registry is not swapped for an already-built service's. */
const layerWith = (registry: Layer.Layer<ProviderRegistry>) =>
  Layer.fresh(MrMakImport.layer).pipe(
    Layer.provide(GitVcsDriver.layer.pipe(Layer.provide(VcsProcess.layer))),
    Layer.provide(ProcessRunner.layer),
    Layer.provide(registry),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mrmak-skills-test-" })),
  );
const TestLayer = layerWith(makeProviderRegistryLayer());
const decodeProvider = Schema.decodeUnknownSync(ServerProvider);
const decodeReceipt = Schema.decodeUnknownEffect(fromLenientJson(MrMakImportReceipt));
const encodeReports = Schema.encodeEffect(
  fromJsonStringPretty(Schema.Array(MrMakSkillDiscoveryReport)),
);

const ALPHA_SKILL = `---
name: alpha
description: Generates art with fal.ai.
---
Run [the script](scripts/run.py) as \`.agents/skills/alpha/scripts/run.py\`, or invoke /alpha.
See [the guide](references/guide.md). Needs blender and FAL_KEY.
`;
const SOURCE_FILES: Record<string, string> = {
  ".agents/skills/alpha/SKILL.md": ALPHA_SKILL,
  ".agents/skills/alpha/scripts/run.py": "import os, fal_client\nos.environ['FAL_KEY']\n",
  ".agents/skills/alpha/references/guide.md": "# Guide\n",
  ".agents/skills/beta/SKILL.md": "---\nname: beta\n---\nSee [notes](docs/notes.md).\n",
  ".agents/skills/beta/docs/notes.md": "notes\n",
  ".agents/skills/beta/.github/workflows/ci.yml": "on: push\n",
  ".agents/skills/beta/.gitignore": "out/\n",
  ".agents/skills/beta/docs/raw/.keep": "",
  ".agents/skills/beta/tools/.python-version": "3.12\n",
  ".agents/skills/gamma/SKILL.md": "---\nname: gamma\n---\nUses the higgsfield CLI.\n",
  ".agents/skills/gamma/scripts/gen.mjs": "console.log(process.env.HIGGSFIELD_API_KEY);\n",
  ".agents/skills/gamma/__pycache__/gen.cpython-312.pyc": "\u0000compiled",
  "docs/readme.md": "# Mr. Mak\n",
};

const sha256 = (bytes: string | Uint8Array) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8" });
const write = (root: string, relativePath: string, contents: string) => {
  NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, relativePath)), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(root, relativePath), contents);
};
const read = (root: string, relativePath: string) =>
  NodeFS.readFileSync(NodePath.join(root, relativePath), "utf8");
const exists = (root: string, relativePath: string) =>
  NodeFS.existsSync(NodePath.join(root, relativePath));
/** Every file under `root` as relative path to sha256. */
const filesUnder = (root: string): Record<string, string> =>
  NodeFS.existsSync(root)
    ? Object.fromEntries(
        NodeFS.readdirSync(root, { recursive: true, withFileTypes: true })
          .filter((dirent) => dirent.isFile())
          .map((dirent): [string, string] => {
            const absolute = NodePath.join(dirent.parentPath, dirent.name);
            return [NodePath.relative(root, absolute), sha256(NodeFS.readFileSync(absolute))];
          })
          .toSorted(([a], [b]) => a.localeCompare(b)),
      )
    : {};
/** scripts/sync-skills.mjs, transliterated: the files it would copy into `.claude/skills`. */
const syncSkillsSubset = (source: string) => {
  const files: Array<string> = [];
  const visit = (relative: string) => {
    for (const entry of NodeFS.readdirSync(NodePath.join(source, relative), {
      withFileTypes: true,
    })) {
      if (entry.name.startsWith(".") || ["__pycache__", "node_modules"].includes(entry.name)) {
        continue;
      }
      const name = NodePath.join(relative, entry.name);
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile() && !/\.(?:pyc|pyo)$/.test(entry.name)) files.push(name);
    }
  };
  visit("");
  return files.toSorted();
};

beforeAll(() => {
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

const makeFixture = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const base = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-mrmak-skills-" }),
  );
  const source = NodePath.join(base, "source");
  for (const [relativePath, contents] of Object.entries(SOURCE_FILES)) {
    write(source, relativePath, contents);
  }
  NodeFS.chmodSync(NodePath.join(source, ".agents/skills/alpha/scripts/run.py"), 0o755);
  git(source, "init", "-q");
  git(source, "add", "-A");
  git(source, "commit", "-q", "-m", "skills");
  return { base, source, destination: NodePath.join(base, "comparison") };
});

const importSkills = (
  source: string,
  destination: string,
  skillChoices?: ReadonlyArray<MrMakSkillConflictChoice>,
) =>
  Effect.gen(function* () {
    const service = yield* MrMakImport.MrMakImport;
    const plan = yield* service.plan({
      sourceRoot: source,
      destinationRoot: destination,
      roots: [".agents/skills", "docs"],
    });
    return yield* service.importSkills({ plan, destinationRoot: destination, skillChoices });
  });

it.layer(NodeServices.layer, { excludeTestServices: true })("MrMakImport.importSkills", (it) => {
  it.effect("copies the full skill tree and an identical sync-skills subset for Claude", () =>
    Effect.gen(function* () {
      const { source, destination } = yield* makeFixture;
      const result = yield* importSkills(source, destination);

      // .agents/skills: every committed skill file, dot-entries included; compiled Python never.
      const committed = git(source, "ls-files", "--", ".agents/skills")
        .trim()
        .split("\n")
        .filter((file) => !file.includes("__pycache__"));
      const agents = filesUnder(NodePath.join(destination, ".agents/skills"));
      expect(Object.keys(agents).map((file) => `.agents/skills/${file}`)).toEqual(
        committed.toSorted((a, b) => a.localeCompare(b)),
      );
      for (const file of committed) {
        expect([file, agents[file.slice(".agents/skills/".length)]]).toEqual([
          file,
          sha256(NodeFS.readFileSync(NodePath.join(source, file))),
        ]);
      }
      // .claude/skills: exactly what sync-skills.mjs would copy, byte for byte.
      const claude = filesUnder(NodePath.join(destination, ".claude/skills"));
      const subset = syncSkillsSubset(NodePath.join(source, ".agents/skills"));
      expect(Object.keys(claude).toSorted()).toEqual(subset);
      for (const file of subset) expect(claude[file]).toBe(agents[file]);
      expect(subset).not.toContain("beta/.gitignore");
      expect(Object.keys(agents)).toContain("beta/.github/workflows/ci.yml");
      expect(
        NodeFS.statSync(NodePath.join(destination, ".claude/skills/alpha/scripts/run.py")).mode &
          0o111,
      ).not.toBe(0);

      const skills = result.skills;
      expect(skills.totals).toEqual({
        skills: 3,
        files: committed.length,
        distributionFiles: subset.length,
        agentsOnlyFiles: committed.length - subset.length,
      });
      expect(skills.equivalence).toEqual({ verified: true, differences: [] });
      expect(skills.names).toEqual({ alpha: "alpha", beta: "beta", gamma: "gamma" });
      expect(skills.baseline.map((file) => file.path).toSorted()).toEqual(committed.toSorted());
      expect(result.receipt.skills).toEqual(skills);
      expect(result.receipt.transforms).toEqual([]);
      // Links the SKILL.md files use resolve in both copies.
      for (const target of [
        "alpha/scripts/run.py",
        "alpha/references/guide.md",
        "beta/docs/notes.md",
      ]) {
        expect([
          exists(destination, `.agents/skills/${target}`),
          exists(destination, `.claude/skills/${target}`),
        ]).toEqual([true, true]);
      }
      // Requirements are listed from SKILL.md and scripts, never activated.
      const requirements = (name: string) =>
        skills.skills
          .find((skill) => skill.original === name)
          ?.requirements.map((requirement) => `${requirement.kind}:${requirement.name}`);
      expect(requirements("alpha")).toEqual(
        expect.arrayContaining([
          "paid-provider:fal.ai",
          "tool:blender",
          "env-var:FAL_KEY",
          "tool:python",
        ]),
      );
      expect(requirements("gamma")).toEqual(
        expect.arrayContaining([
          "paid-provider:Higgsfield",
          "env-var:HIGGSFIELD_API_KEY",
          "tool:node",
        ]),
      );
      expect(requirements("beta")).toEqual([]);
      // Both trees are in the baseline commit, so worktree threads see the skills too.
      const tracked = git(destination, "ls-files");
      expect(tracked).toContain(".claude/skills/alpha/SKILL.md");
      expect(tracked).toContain(".agents/skills/beta/.github/workflows/ci.yml");
      expect(git(destination, "status", "--porcelain")).toBe("");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("a different skill with the same name needs a choice: keep it or rename ours", () =>
    Effect.gen(function* () {
      const { base, source, destination } = yield* makeFixture;
      write(destination, ".agents/skills/alpha/SKILL.md", "---\nname: alpha\n---\nMine.\n");
      const before = filesUnder(destination);

      const error = yield* importSkills(source, destination).pipe(Effect.flip);
      expect(error).toBeInstanceOf(MrMakSkillImportError);
      expect(error).toMatchObject({ reason: "skill-conflict", skills: ["alpha"] });
      expect(filesUnder(destination)).toEqual(before);

      const kept = yield* importSkills(source, destination, [
        { skill: "alpha", action: "keep-existing" },
      ]);
      expect(read(destination, ".agents/skills/alpha/SKILL.md")).toContain("Mine.");
      expect(exists(destination, ".claude/skills/alpha")).toBe(false);
      expect(kept.skills.names).toEqual({ beta: "beta", gamma: "gamma" });
      expect(kept.skills.skills.find((skill) => skill.original === "alpha")?.action).toBe(
        "kept-existing",
      );

      const renamedInto = NodePath.join(base, "renamed");
      write(renamedInto, ".claude/skills/alpha/SKILL.md", "---\nname: alpha\n---\nMine.\n");
      const choice = [{ skill: "alpha", action: "import-renamed" as const }];
      const renamed = yield* importSkills(source, renamedInto, choice);
      expect(read(renamedInto, ".claude/skills/alpha/SKILL.md")).toContain("Mine.");
      expect(renamed.skills.names.alpha).toBe("alpha-mrmak");
      for (const copy of [".agents/skills/alpha-mrmak", ".claude/skills/alpha-mrmak"]) {
        const skill = read(renamedInto, `${copy}/SKILL.md`);
        expect(skill).toMatch(/^---\nname: alpha-mrmak\n/);
        expect(skill).toContain(
          "`.agents/skills/alpha-mrmak/scripts/run.py`, or invoke /alpha-mrmak.",
        );
        // Only references to the skill's own name change.
        expect(skill).toContain("Generates art with fal.ai.");
        expect(read(renamedInto, `${copy}/scripts/run.py`)).toBe(
          SOURCE_FILES[".agents/skills/alpha/scripts/run.py"],
        );
      }
      expect(renamed.receipt.transforms).toEqual([
        ".agents/skills/alpha-mrmak/SKILL.md: references to skill alpha renamed to alpha-mrmak",
        ".claude/skills/alpha-mrmak/SKILL.md: references to skill alpha renamed to alpha-mrmak",
      ]);
      expect(renamed.skills.equivalence.verified).toBe(true);
      // The baseline keeps the unmodified source hash of the renamed file.
      expect(
        renamed.skills.baseline.find((file) => file.path === ".agents/skills/alpha/SKILL.md")
          ?.sha256,
      ).toBe(sha256(ALPHA_SKILL));

      const rerun = yield* importSkills(source, renamedInto, choice);
      expect(rerun.status).toBe("unchanged");

      const taken = yield* importSkills(source, renamedInto, [
        { skill: "alpha", action: "import-renamed", newName: "beta" },
      ]).pipe(Effect.flip);
      expect(taken).toMatchObject({ reason: "invalid-choice", skills: ["alpha"] });
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("a rerun changes nothing and keeps skills the user added", () =>
    Effect.gen(function* () {
      const { source, destination } = yield* makeFixture;
      yield* importSkills(source, destination);
      write(destination, ".agents/skills/mine/SKILL.md", "---\nname: mine\n---\n");
      write(destination, ".claude/skills/mine/SKILL.md", "---\nname: mine\n---\n");
      const before = filesUnder(destination);

      const rerun = yield* importSkills(source, destination);

      expect(rerun.status).toBe("unchanged");
      expect(filesUnder(destination)).toEqual(before);
      expect(rerun.skills.equivalence.verified).toBe(true);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("writes nothing under HOME, refuses home skill folders and runs no provider", () =>
    Effect.gen(function* () {
      const { base, source, destination } = yield* makeFixture;
      const home = NodePath.join(base, "home");
      for (const folder of [".claude/skills", ".codex/skills", ".agents/skills"]) {
        NodeFS.mkdirSync(NodePath.join(home, folder), { recursive: true });
      }
      // Provider CLIs on PATH that leave a mark if anything runs them.
      const bin = NodePath.join(base, "bin");
      const marks = NodePath.join(base, "marks");
      NodeFS.mkdirSync(marks);
      for (const tool of ["fal", "higgsfield", "blender", "ffmpeg", "python", "python3"]) {
        write(bin, tool, `#!/bin/sh\ntouch "${marks}/${tool}"\n`);
        NodeFS.chmodSync(NodePath.join(bin, tool), 0o755);
      }
      const homeBefore = filesUnder(home);
      const previous = { HOME: process.env.HOME, PATH: process.env.PATH };
      const restore = Effect.sync(() => {
        process.env.HOME = previous.HOME;
        process.env.PATH = previous.PATH;
      });
      process.env.HOME = home;
      process.env.PATH = `${bin}${NodePath.delimiter}${previous.PATH ?? ""}`;

      const result = yield* importSkills(source, destination).pipe(Effect.ensuring(restore));
      expect(result.status).toBe("imported");
      process.env.HOME = home;
      const refused = yield* importSkills(source, NodePath.join(home, ".claude")).pipe(
        Effect.flip,
        Effect.ensuring(restore),
      );

      expect(refused).toMatchObject({ reason: "unsafe-destination" });
      expect(filesUnder(home)).toEqual(homeBefore);
      expect(NodeFS.readdirSync(NodePath.join(home, ".claude/skills"))).toEqual([]);
      expect(NodeFS.readdirSync(marks)).toEqual([]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("reports which imported skills each provider discovers in the destination", () =>
    Effect.gen(function* () {
      const { base, source, destination } = yield* makeFixture;
      yield* importSkills(source, destination);
      const cwd = NodeFS.realpathSync(destination);
      const skill = (name: string, path: string, enabled = true): ServerProviderSkill => ({
        name,
        path,
        enabled,
      });
      const scans: Array<{ instanceId: string; cwd: string; fresh: boolean | undefined }> = [];
      const provider = (driver: string, skills: ReadonlyArray<ServerProviderSkill>) =>
        decodeProvider({
          instanceId: driver,
          driver,
          enabled: true,
          installed: true,
          version: "1.0.0",
          status: "ready",
          auth: { status: "authenticated" },
          checkedAt: "2026-10-03T00:00:00.000Z",
          models: [],
          workspaceSnapshots: [
            { cwd, checkedAt: "2026-10-03T00:00:00.000Z", slashCommands: [], skills },
          ],
        });
      const providers = [
        provider("claudeAgent", [
          skill("alpha", NodePath.join(cwd, ".claude/skills/alpha/SKILL.md")),
          // Claude's user scope wins a name collision, so beta is not the project copy.
          skill("beta", NodePath.join(base, "home/.claude/skills/beta/SKILL.md")),
          skill("gamma", NodePath.join(cwd, ".claude/skills/gamma/SKILL.md"), false),
        ]),
        provider(
          "codex",
          ["alpha", "beta", "gamma"].map((name) =>
            skill(name, NodePath.join(cwd, `.agents/skills/${name}/SKILL.md`)),
          ),
        ),
      ];
      const registry = Layer.effect(
        ProviderRegistry,
        Effect.map(ProviderRegistry, (mock) =>
          ProviderRegistry.of({
            ...mock,
            refreshWorkspaceSnapshot: (input) =>
              Effect.sync(() => {
                scans.push({ instanceId: input.instanceId, cwd: input.cwd, fresh: input.fresh });
                return providers;
              }),
          }),
        ),
      ).pipe(Layer.provide(makeProviderRegistryLayer(providers)));

      const reports = yield* Effect.flatMap(MrMakImport.MrMakImport, (service) =>
        service.verifySkillDiscovery({ destinationRoot: destination }),
      ).pipe(Effect.provide(layerWith(registry)));

      expect(scans).toEqual([
        { instanceId: "claudeAgent", cwd, fresh: true },
        { instanceId: "codex", cwd, fresh: true },
      ]);
      expect(reports).toEqual([
        {
          provider: "claude",
          status: "checked",
          projectRoot: NodePath.join(cwd, ".claude/skills"),
          discovered: ["alpha"],
          missing: ["gamma"],
          shadowed: ["beta"],
        },
        {
          provider: "codex",
          status: "checked",
          projectRoot: NodePath.join(cwd, ".agents/skills"),
          discovered: ["alpha", "beta", "gamma"],
          missing: [],
          shadowed: [],
        },
      ]);
      // No installed instance: nothing was checked and every skill is missing.
      expect(discoveryReport("codex", cwd, ["alpha"], null)).toMatchObject({
        status: "unavailable",
        missing: ["alpha"],
      });
    }).pipe(Effect.provide(TestLayer)),
  );

  /** Opt-in: DEVGAME_MRMAK_IMPORT_LIVE=1 MRMAK_SOURCE=<Mr. Mak repo> MRMAK_DEST=<new comparison folder> */
  it.effect.skipIf(process.env.DEVGAME_MRMAK_IMPORT_LIVE !== "1")(
    "live: imports the real Mr. Mak skills",
    () =>
      Effect.gen(function* () {
        const source = process.env.MRMAK_SOURCE ?? "";
        const destination = process.env.MRMAK_DEST ?? "";
        expect([NodePath.isAbsolute(source), NodePath.isAbsolute(destination)]).toEqual([
          true,
          true,
        ]);
        const service = yield* MrMakImport.MrMakImport;
        const plan = yield* service.plan({ sourceRoot: source, destinationRoot: destination });
        const result = yield* service.importSkills({ plan, destinationRoot: destination });
        const { totals, equivalence } = result.skills;
        process.stdout.write(
          `Mr. Mak skills ${result.status}: ${totals.skills} skills, ${totals.files} files in .agents/skills, ` +
            `${totals.distributionFiles} in .claude/skills, ${totals.agentsOnlyFiles} agents-only; ` +
            `verified ${equivalence.verified} (${equivalence.differences.length} differences)\n`,
        );
        expect(totals.files).toBe(totals.distributionFiles + totals.agentsOnlyFiles);
        expect(equivalence.verified).toBe(true);
      }).pipe(Effect.provide(TestLayer)),
    10 * 60_000,
  );

  /** Opt-in: DEVGAME_MRMAK_DISCOVERY_LIVE=1 MRMAK_DEST=<imported comparison folder> [CODEX_BINARY] */
  it.effect.skipIf(process.env.DEVGAME_MRMAK_DISCOVERY_LIVE !== "1")(
    "live: asks the installed Claude and Codex what they discover",
    () =>
      Effect.gen(function* () {
        const cwd = NodeFS.realpathSync(process.env.MRMAK_DEST ?? "");
        const receipt = yield* decodeReceipt(read(cwd, ".devgame/import/receipt.json"));
        const reports = yield* checkSkillDiscovery(
          cwd,
          Object.values(receipt.skills?.names ?? {}),
          cliSkillProbe(process.env.CODEX_BINARY ?? "codex"),
        );
        process.stdout.write(`${yield* encodeReports(reports)}\n`);
        for (const report of reports) expect(report.missing).toEqual([]);
      }),
    120_000,
  );
});
