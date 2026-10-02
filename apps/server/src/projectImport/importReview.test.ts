// @effect-diagnostics nodeBuiltinImport:off
/**
 * MrMakImport.review / apply / status against real temp repositories: the dry
 * run the dialog shows, the guards apply puts around it, and the import state
 * a project reads back from disk after a restart.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterAll, beforeAll, expect, it, vi } from "@effect/vitest";
import { MrMakImportReceipt } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { makeProviderRegistryLayer } from "../provider/testUtils/providerRegistryMock.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as MrMakImport from "./MrMakImport.ts";

/** `fresh`: a second build stands in for a restarted server with no memory of the first. */
const ServiceLayer = Layer.fresh(MrMakImport.layer).pipe(
  Layer.provide(GitVcsDriver.layer.pipe(Layer.provide(VcsProcess.layer))),
  Layer.provide(ProcessRunner.layer),
  Layer.provide(makeProviderRegistryLayer()),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mrmak-review-test-" })),
);

const SOURCE_FILES: Record<string, string> = {
  "workspace/workspace.json": JSON.stringify({
    entities: [
      {
        id: "intro",
        title: "Intro",
        folder: "intro",
        steps: [{ name: "Read", path: "index.html" }],
      },
    ],
  }),
  "workspace/intro/index.html": "<html><body>Intro</body></html>\n",
  "processes/review.md": "# Review\n",
  "context/brand.md": "# Brand\n",
  "docs/readme.md": "# Mr. Mak\n",
  ".agents/skills/alpha/SKILL.md": "---\nname: alpha\n---\nAlpha.\n",
};

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8" });
const write = (root: string, relativePath: string, contents: string) => {
  NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, relativePath)), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(root, relativePath), contents);
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

/** A committed Mr. Mak source and a destination shaped like a new DevGame project. */
const makeFixture = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const base = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-mrmak-review-" }),
  );
  const source = NodePath.join(base, "source");
  for (const [relativePath, contents] of Object.entries(SOURCE_FILES)) {
    write(source, relativePath, contents);
  }
  git(source, "init", "-q");
  git(source, "add", "-A");
  git(source, "commit", "-q", "-m", "mr mak");
  const destination = NodePath.join(base, "comparison");
  write(destination, "README.md", "# Comparison\n");
  write(destination, "assets/icon.svg", "<svg/>\n");
  git(destination, "init", "-q");
  return { source, destination, request: { sourceRoot: source, destinationRoot: destination } };
});

const ReceiptJson = {
  decode: Schema.decodeUnknownSync(Schema.fromJsonString(MrMakImportReceipt)),
  encode: Schema.encodeSync(Schema.fromJsonString(MrMakImportReceipt)),
};

const NO_CHOICES ={ choices: {}, skillChoices: [], confirmExistingProject: false };

it.layer(NodeServices.layer, { excludeTestServices: true })("MrMakImport review", (it) => {
  it.effect("dry-runs a new project with a stable fingerprint and writes nothing", () =>
    Effect.gen(function* () {
      const { destination, request } = yield* makeFixture;
      const before = NodeFS.readdirSync(destination, { recursive: true }).toSorted();
      const service = yield* MrMakImport.MrMakImport;
      const first = yield* service.review(request);
      const second = yield* service.review(request);

      expect(first.destination.kind).toBe("empty");
      expect(first.planId).toBe(second.planId);
      expect(first.conflicts).toEqual([]);
      expect(first.skills).toEqual([{ name: "alpha", files: 1, conflict: false }]);
      expect(first.totals.files).toBe(Object.keys(SOURCE_FILES).length);
      expect(NodeFS.readdirSync(destination, { recursive: true }).toSorted()).toEqual(before);
    }).pipe(Effect.provide(ServiceLayer)),
  );

  it.effect("lists file and skill conflicts once each, by the rules apply uses", () =>
    Effect.gen(function* () {
      const { destination, request } = yield* makeFixture;
      write(destination, "docs/readme.md", "# Ours\n");
      write(destination, ".agents/skills/alpha/SKILL.md", "---\nname: alpha\n---\nOurs.\n");
      write(destination, ".claude/skills/alpha/SKILL.md", "---\nname: alpha\n---\nOurs.\n");
      const service = yield* MrMakImport.MrMakImport;
      const summary = yield* service.review(request);

      expect(summary.destination.kind).toBe("existing");
      // The skill's own files are settled by its skill choice, not listed again.
      expect(summary.conflicts.map((conflict) => conflict.path)).toEqual(["docs/readme.md"]);
      expect(summary.skills).toEqual([{ name: "alpha", files: 1, conflict: true }]);

      const refusals = [
        // An existing project needs explicit confirmation.
        yield* service
          .apply({ ...request, ...NO_CHOICES, planId: summary.planId })
          .pipe(Effect.flip),
        // Every conflict needs a choice, the skill's included.
        yield* service
          .apply({
            ...request,
            ...NO_CHOICES,
            confirmExistingProject: true,
            planId: summary.planId,
          })
          .pipe(Effect.flip),
      ];
      expect(
        refusals.map((error) => error._tag === "MrMakImportReviewError" && error.reason),
      ).toEqual(["existing-project", "unresolved-conflicts"]);
      expect(refusals[1]?.message).toContain("docs/readme.md, skill alpha");
      expect(NodeFS.existsSync(NodePath.join(destination, ".devgame"))).toBe(false);

      const applied = yield* service.apply({
        ...request,
        planId: summary.planId,
        choices: { "docs/readme.md": "keep-destination" },
        skillChoices: [{ skill: "alpha", action: "import-renamed" }],
        confirmExistingProject: true,
      });
      expect(applied.status).toBe("imported");
      expect(applied.receiptPath).toBe(".devgame/import/receipt.json");
      expect(applied.receipt.outcomes.conflict).toBe(1);
      expect(applied.receipt.skills?.skills.map((skill) => skill.active)).toEqual(["alpha-mrmak"]);
      // keep-destination left the user's file alone.
      expect(NodeFS.readFileSync(NodePath.join(destination, "docs/readme.md"), "utf8")).toBe(
        "# Ours\n",
      );
    }).pipe(Effect.provide(ServiceLayer)),
  );

  it.effect("lists edits in a renamed skill's folder as conflicts before a re-import", () =>
    Effect.gen(function* () {
      const { source, destination, request } = yield* makeFixture;
      write(destination, ".agents/skills/alpha/SKILL.md", "---\nname: alpha\n---\nOurs.\n");
      const service = yield* MrMakImport.MrMakImport;
      const renamed = {
        skillChoices: [{ skill: "alpha", action: "import-renamed" as const }],
        confirmExistingProject: true,
      };
      const first = yield* service.review(request);
      yield* service.apply({ ...request, ...renamed, choices: {}, planId: first.planId });
      const renamedSkill = ".agents/skills/alpha-mrmak/SKILL.md";
      write(destination, renamedSkill, "---\nname: alpha-mrmak\n---\nEdited here.\n");
      // Both sides changed it: an update would overwrite the edit.
      write(source, ".agents/skills/alpha/SKILL.md", "---\nname: alpha\n---\nAlpha, revised.\n");
      git(source, "commit", "-q", "-am", "revise alpha");

      const again = yield* service.review(request);
      expect(again.skills).toEqual([{ name: "alpha", files: 1, conflict: true }]);
      expect(again.conflicts).toEqual([
        {
          path: renamedSkill,
          reason:
            "If alpha is imported as alpha-mrmak: Changed at the destination since the last import.",
        },
      ]);
      const refused = yield* service
        .apply({ ...request, ...renamed, choices: {}, planId: again.planId })
        .pipe(Effect.flip);
      expect(refused._tag === "MrMakImportReviewError" && refused.paths).toEqual([renamedSkill]);

      yield* service.apply({
        ...request,
        ...renamed,
        choices: { [renamedSkill]: "keep-destination" },
        planId: again.planId,
      });
      expect(NodeFS.readFileSync(NodePath.join(destination, renamedSkill), "utf8")).toContain(
        "Edited here.",
      );
    }).pipe(Effect.provide(ServiceLayer)),
  );

  it.effect("refuses a plan the source moved past since the dry run", () =>
    Effect.gen(function* () {
      const { source, destination, request } = yield* makeFixture;
      const service = yield* MrMakImport.MrMakImport;
      const reviewed = yield* service.review(request);
      write(source, "docs/readme.md", "# Mr. Mak, revised\n");
      git(source, "commit", "-q", "-am", "revise");

      const error = yield* service
        .apply({ ...request, ...NO_CHOICES, planId: reviewed.planId })
        .pipe(Effect.flip);
      expect(error._tag === "MrMakImportReviewError" && error.reason).toBe("stale-plan");
      expect(NodeFS.existsSync(NodePath.join(destination, ".devgame"))).toBe(false);
    }).pipe(Effect.provide(ServiceLayer)),
  );

  it.effect("reads each file's origin back from disk, also after a restart", () =>
    Effect.gen(function* () {
      const { destination, request } = yield* makeFixture;
      const imported = yield* Effect.gen(function* () {
        const service = yield* MrMakImport.MrMakImport;
        expect(yield* service.status({ destinationRoot: destination })).toEqual({ import: null });
        const summary = yield* service.review(request);
        return yield* service.apply({ ...request, ...NO_CHOICES, planId: summary.planId });
      }).pipe(Effect.provide(ServiceLayer));
      expect(imported.receipt.outcomes.written).toBe(Object.keys(SOURCE_FILES).length + 1);

      write(destination, "workspace/intro/index.html", "<html><body>Adapted</body></html>\n");
      NodeFS.rmSync(NodePath.join(destination, "context/brand.md"));
      write(destination, "processes/playtest.md", "# Playtest\n");

      // A new service instance: nothing but the destination's files tells it about the import.
      const status = yield* Effect.gen(function* () {
        const service = yield* MrMakImport.MrMakImport;
        return yield* service.status({ destinationRoot: destination });
      }).pipe(Effect.provide(ServiceLayer));
      const origins = Object.fromEntries(
        (status.import?.files ?? []).map((file) => [file.path, file.origin]),
      );
      expect(status.import?.receipt.importId).toBe(imported.receipt.importId);
      expect(status.import?.receipt.source.revision).toBe(imported.receipt.source.revision);
      expect(origins).toEqual({
        "workspace/workspace.json": "original",
        "workspace/intro/index.html": "adapted",
        "processes/review.md": "original",
        "processes/playtest.md": "devgame",
        "context/brand.md": "removed",
        "docs/readme.md": "original",
        ".agents/skills/alpha/SKILL.md": "original",
        ".claude/skills/alpha/SKILL.md": "original",
      });
    }),
  );

  it.effect("reads only receipt paths inside the project, and never opens a FIFO", () =>
    Effect.gen(function* () {
      const { destination, request } = yield* makeFixture;
      const service = yield* MrMakImport.MrMakImport;
      const summary = yield* service.review(request);
      yield* service.apply({ ...request, ...NO_CHOICES, planId: summary.planId });

      // A shared comparison repository can carry any receipt; this one points outside it.
      const base = NodePath.dirname(destination);
      write(base, "outside/secret.txt", "secret\n");
      NodeFS.symlinkSync(NodePath.join(base, "outside"), NodePath.join(destination, "linked"));
      NodeChildProcess.execFileSync("mkfifo", [NodePath.join(destination, "pipe")]);
      const secret = NodeCrypto.createHash("sha256").update("secret\n").digest("hex");
      const receiptPath = NodePath.join(destination, ".devgame/import/receipt.json");
      const receipt = ReceiptJson.decode(NodeFS.readFileSync(receiptPath, "utf8"));
      const planted = [
        "../outside/secret.txt",
        "processes/../../outside/secret.txt",
        NodePath.join(base, "outside/secret.txt"),
        "/dev/zero",
        "linked/secret.txt",
        "pipe",
      ];
      const files = planted.map((path) => ({
        path,
        sourceSha256: secret,
        destinationSha256: secret,
        outcome: "written" as const,
      }));
      NodeFS.writeFileSync(
        receiptPath,
        ReceiptJson.encode({ ...receipt, files: [...receipt.files, ...files] }),
      );

      const status = yield* service.status({ destinationRoot: destination });
      const origins = new Map((status.import?.files ?? []).map((file) => [file.path, file.origin]));
      expect(planted.map((path) => origins.get(path) ?? "not listed")).toEqual([
        "not listed",
        "not listed",
        "not listed",
        "not listed",
        // Plain paths, but behind a symlinked folder or not a regular file: never read.
        "removed",
        "removed",
      ]);
      expect(origins.get("docs/readme.md")).toBe("original");
    }).pipe(Effect.provide(ServiceLayer)),
  );
});
