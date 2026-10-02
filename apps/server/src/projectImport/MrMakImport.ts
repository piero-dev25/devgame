// @effect-diagnostics nodeBuiltinImport:off
/**
 * MrMakImport - dry-run inventory of what importing a Mr. Mak workspace into
 * a DevGame project would copy.
 *
 * READ-ONLY. Content comes from the source's committed HEAD (`ls-tree` and
 * `cat-file --batch`), never its working tree, which may hold uncommitted app
 * edits. Git runs with an argv (no shell), `GIT_OPTIONAL_LOCKS=0` and fsmonitor
 * off so not even the index is refreshed. The working tree is only listed
 * (top-level names, untracked paths inside the selected roots, and a stat of
 * known credential files) to report what is excluded; `.mrmak` is named,
 * never entered. The destination is only read, to classify conflicts.
 *
 * @module MrMakImport
 */
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import {
  MRMAK_IMPORT_ROOTS,
  WorkspaceManifest,
  type MrMakImportDestinationState,
  type MrMakImportEntry,
  type MrMakImportExclusion,
  type MrMakImportExclusionRule,
  type MrMakImportFileKind,
  type MrMakImportIssue,
  type MrMakImportPlan,
  type MrMakImportRoot,
} from "@t3tools/contracts";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import {
  extractHrefs,
  makeBatchParser,
  requirementsFrom,
  resolveLink,
} from "./mrMakImportContent.ts";

const posix = NodePath.posix;
const READ_ONLY_GIT_ENV = { GIT_OPTIONAL_LOCKS: "0" };
const READ_ONLY_GIT_ARGS = ["-c", "core.fsmonitor=false", "-c", "core.quotePath=false"];
const LISTING_MAX_BYTES = 32 * 1024 * 1024;
const LINK_SCAN_MAX_BYTES = 1024 * 1024;
const LINK_SCAN_EXTENSIONS = new Set([".html", ".htm", ".md", ".markdown", ".css", ".svg"]);
const MEDIA_EXTENSIONS =
  /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp|mp4|webm|mov|mp3|wav|ogg|m4a|glb|gltf|fbx|obj|blend|hdr|exr|ttf|otf|woff2?|pdf)$/i;
const SCRIPT_EXTENSIONS = /\.(py|mjs|cjs|js|ts|sh|ps1|cmd|bat)$/i;
const SECRET_NAME =
  /^(\.env(\..+)?|auth\.json|credentials\.json|tokens?\.json|.+\.pem|.+\.key|id_rsa.*)$/i;
/** Not portable: backslashes, control or replacement characters, Windows-reserved characters, trailing dots or spaces. */
// eslint-disable-next-line no-control-regex
const MALFORMED_PATH = /[\\\u0000-\u001f\u007f�<>:"|?*]|[. ]$|[. ]\//;
const STEP_ISSUE = {
  missing: "missing-step",
  escape: "escape",
  malformed: "malformed-path",
} as const;
/** Credential files outside the roots, checked by stat only. */
const KNOWN_CREDENTIAL_PATHS = [".claude/settings.local.json", ".codex/auth.json"];
const REQUIREMENT_SOURCES = new Set([".mcp.json", ".codex/config.toml"]);
const SKILLS_ROOT = ".agents/skills";
const REGISTRY_PATH = "workspace/workspace.json";

const decodeRegistry = Schema.decodeUnknownEffect(fromLenientJson(WorkspaceManifest));

export class MrMakImportPlanError extends Schema.TaggedError<MrMakImportPlanError>()(
  "MrMakImportPlanError",
  {
    reason: Schema.Literals(["not-repository-root", "no-head", "listing-truncated", "git"]),
    sourceRoot: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "not-repository-root":
        return `${this.sourceRoot} is not the root of a git repository.`;
      case "no-head":
        return `${this.sourceRoot} has no committed HEAD to import from.`;
      case "listing-truncated":
        return `The committed file listing of ${this.sourceRoot} is too large to plan.`;
      case "git":
        return `Reading the committed tree of ${this.sourceRoot} failed.`;
    }
  }
}

export interface MrMakImportPlanRequest {
  /** Absolute path of the Mr. Mak repository root. */
  readonly sourceRoot: string;
  /** Absolute path of the destination project root; omitted skips conflict checks. */
  readonly destinationRoot?: string | undefined;
  /** Defaults to every root in `MRMAK_IMPORT_ROOTS`. */
  readonly roots?: ReadonlyArray<MrMakImportRoot> | undefined;
}

export class MrMakImport extends Context.Service<
  MrMakImport,
  {
    /** Plan an import without writing anything to the source, destination or home folders. */
    readonly plan: (
      input: MrMakImportPlanRequest,
    ) => Effect.Effect<MrMakImportPlan, MrMakImportPlanError>;
  }
>()("t3/projectImport/MrMakImport") {}

interface TreeEntry {
  readonly mode: string;
  readonly type: string;
  readonly oid: string;
  readonly bytes: number;
  readonly path: string;
}

const parseLsTree = (stdout: string): Array<TreeEntry> =>
  stdout.split("\0").flatMap((record) => {
    const match = /^(\d+) (\w+) ([0-9a-f]+) +(\S+)\t([\s\S]+)$/.exec(record);
    if (!match) return [];
    const [, mode = "", type = "", oid = "", size = "", path = ""] = match;
    return [{ mode, type, oid, bytes: size === "-" ? 0 : Number(size), path }];
  });

/** Paths with a tracked change in `git status --porcelain=v1 -z` (renames carry a second path). */
const parseDirtyPaths = (stdout: string): Array<string> => {
  const records = stdout.split("\0");
  const paths: Array<string> = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index] ?? "";
    if (record.length < 4) continue;
    paths.push(record.slice(3));
    if (record[0] === "R" || record[0] === "C") index++;
  }
  return paths;
};

const topLevelRule = (name: string): [MrMakImportExclusionRule, string] => {
  if (name === ".git") return ["vcs", "Version control internals."];
  if (name === "node_modules") return ["dependencies", "Installed dependencies."];
  if (name === "dist" || name.endsWith(".tsbuildinfo")) return ["build-output", "Build output."];
  if (name === ".cache") return ["cache", "Local cache."];
  if (name === ".mrmak") {
    return ["live-session", "Live Mr. Mak session data; listed by name only, never read."];
  }
  if (name === "scripts") return ["app-tooling", "Mr. Mak app tooling."];
  if (name === ".env.example" || name === ".mcp.json" || name === ".codex") {
    return ["requirement-template", "Listed as a sanitized requirement template, never copied."];
  }
  if (SECRET_NAME.test(name)) return ["secret", "Credentials are never imported."];
  if (name === ".claude") {
    return ["skill-distribution", "Distribution copy of .agents/skills; materialized by M3."];
  }
  if (
    /^(src|src-tauri|desktop|package(-lock)?\.json|index\.html|vite\.config\.ts|tsconfig\.json|eslint\.config\.js|Setup\.ps1|Start Mr\. Mak\.cmd)$/.test(
      name,
    )
  ) {
    return ["app-code", "Mr. Mak desktop app code; DevGame replaces the app."];
  }
  return ["not-selected", "Outside the selected import roots."];
};

/** Exclusions that apply to a path inside a selected root, or null when it is importable. */
const inRootRule = (path: string): [MrMakImportExclusionRule, string] | null => {
  const segments = path.replace(/\/$/, "").split("/");
  const name = segments.at(-1) ?? "";
  if (segments.includes(".git")) return ["vcs", "Version control internals."];
  if (segments.includes("node_modules")) return ["dependencies", "Installed dependencies."];
  if (segments.includes(".cache")) return ["cache", "Local cache."];
  if (segments.includes("dist") || segments.includes("__pycache__") || /\.py[co]$/.test(name)) {
    return ["build-output", "Build output."];
  }
  if (name === ".env.example") {
    return ["requirement-template", "Listed as a sanitized requirement template, never copied."];
  }
  if (SECRET_NAME.test(name)) return ["secret", "Credentials are never imported."];
  return null;
};

const fileKind = (path: string): MrMakImportFileKind => {
  if (path === REGISTRY_PATH) return "registry";
  if (path.startsWith(`${SKILLS_ROOT}/`)) {
    const inSkill = path.split("/").slice(3);
    if (inSkill[0] === "scripts") return "script";
    if (inSkill[0] === "references") return "reference";
    return MEDIA_EXTENSIONS.test(path) ? "media" : "skill";
  }
  if (MEDIA_EXTENSIONS.test(path)) return "media";
  if (SCRIPT_EXTENSIONS.test(path)) return "script";
  if (path.startsWith("workspace/")) return "card";
  if (path.startsWith("context/")) return "context";
  if (path.startsWith("processes/") || path.startsWith("knowledge/")) return "reference";
  return "doc";
};

/** The sync-skills.mjs rule: no dot-entries, __pycache__, node_modules or compiled Python. */
const inSkillDistribution = (path: string) => {
  const segments = path.slice(SKILLS_ROOT.length + 1).split("/");
  return (
    !segments.some(
      (segment) =>
        segment.startsWith(".") || segment === "__pycache__" || segment === "node_modules",
    ) && !/\.py[co]$/.test(path)
  );
};

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const processRunner = yield* ProcessRunner.ProcessRunner;

  const isOutside = (root: string, target: string) => {
    const relative = path.relative(root, target);
    return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  };

  const plan: MrMakImport["Service"]["plan"] = Effect.fn("MrMakImport.plan")(function* (input) {
    const sourceRoot = input.sourceRoot;
    const fail = (reason: MrMakImportPlanError["reason"]) => (cause?: unknown) =>
      new MrMakImportPlanError({ reason, sourceRoot, cause });
    const runGit = (operation: string, args: ReadonlyArray<string>) =>
      git
        .execute({
          operation: `MrMakImport.${operation}`,
          cwd: sourceRoot,
          args: [...READ_ONLY_GIT_ARGS, ...args],
          env: READ_ONLY_GIT_ENV,
          allowNonZeroExit: true,
          maxOutputBytes: LISTING_MAX_BYTES,
        })
        .pipe(Effect.mapError(fail("git")));

    const realSource = yield* fileSystem
      .realPath(sourceRoot)
      .pipe(Effect.mapError(fail("not-repository-root")));
    const topLevel = yield* runGit("toplevel", ["rev-parse", "--show-toplevel"]);
    const realTopLevel = yield* fileSystem
      .realPath(topLevel.stdout.trim() || sourceRoot)
      .pipe(Effect.mapError(fail("not-repository-root")));
    if (topLevel.exitCode !== 0 || realTopLevel !== realSource) {
      return yield* fail("not-repository-root")();
    }
    const head = yield* runGit("head", ["rev-parse", "--verify", "-q", "HEAD^{commit}"]);
    if (head.exitCode !== 0) return yield* fail("no-head")();
    const branch = yield* runGit("branch", ["symbolic-ref", "--short", "-q", "HEAD"]);
    const tree = yield* runGit("tree", ["ls-tree", "-r", "-l", "-z", "--full-tree", "HEAD"]);
    const status = yield* runGit("status", [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=no",
    ]);
    const roots = [...new Set(input.roots ?? MRMAK_IMPORT_ROOTS)];
    // No --exclude-standard: ignored files inside a root (secrets, inbox drops) are reported too.
    const untracked = yield* runGit("untracked", [
      "ls-files",
      "--others",
      "--directory",
      "-z",
      "--",
      ...roots,
    ]);
    if (tree.stdoutTruncated || status.stdoutTruncated || untracked.stdoutTruncated) {
      return yield* fail("listing-truncated")();
    }

    const rootOf = (filePath: string) =>
      roots.find((root) => filePath === root || filePath.startsWith(`${root}/`));
    const headEntries = parseLsTree(tree.stdout);
    const headPaths = new Set(headEntries.map((entry) => entry.path));
    const dirtyPaths = parseDirtyPaths(status.stdout);
    const dirty = new Set(dirtyPaths);
    const exclusions: Array<MrMakImportExclusion> = [];
    const issues: Array<MrMakImportIssue> = [];
    const exclude = (filePath: string, [rule, reason]: [MrMakImportExclusionRule, string]) =>
      exclusions.push({ path: filePath, rule, reason });

    // Top-level names outside the roots: committed entries plus what the working tree holds.
    const worktreeNames = yield* fileSystem
      .readDirectory(realSource)
      .pipe(Effect.orElseSucceed((): Array<string> => []));
    const outsideNames = new Set<string>();
    for (const name of [...headEntries.map((entry) => entry.path), ...worktreeNames]) {
      if (rootOf(name)) continue;
      const segments = name.split("/");
      const partial = roots.some((root) => root.startsWith(`${segments[0]}/`));
      outsideNames.add(partial ? segments.slice(0, 2).join("/") : (segments[0] ?? name));
    }
    for (const name of [...outsideNames].toSorted()) {
      if (rootOf(name) || roots.some((root) => root.startsWith(`${name}/`))) continue;
      exclude(name, topLevelRule(name.split("/")[0] ?? name));
    }
    for (const credential of KNOWN_CREDENTIAL_PATHS) {
      if (
        yield* fileSystem
          .exists(path.join(realSource, credential))
          .pipe(Effect.orElseSucceed(() => false))
      ) {
        exclude(credential, ["secret", "Credentials are never imported."]);
      }
    }
    for (const filePath of untracked.stdout.split("\0").filter((entry) => entry.length > 0)) {
      exclude(
        filePath,
        inRootRule(filePath) ?? ["untracked", "Not in the committed HEAD; only HEAD is imported."],
      );
    }

    // Committed files inside the roots.
    const selected: Array<TreeEntry & { readonly root: MrMakImportRoot }> = [];
    const keep = new Set<string>();
    const requirementPaths: Array<TreeEntry> = [];
    for (const entry of headEntries) {
      const isSkillManifest = /^\.agents\/skills\/[^/]+\/SKILL\.md$/.test(entry.path);
      if (
        REQUIREMENT_SOURCES.has(entry.path) ||
        entry.path.endsWith(".env.example") ||
        isSkillManifest
      ) {
        requirementPaths.push(entry);
        keep.add(entry.oid);
      }
      const root = rootOf(entry.path);
      if (!root) continue;
      if (entry.type === "commit") {
        exclude(entry.path, ["submodule", "Nested repository; not part of this tree."]);
        continue;
      }
      if (MALFORMED_PATH.test(entry.path)) {
        issues.push({
          kind: "malformed-path",
          path: entry.path,
          detail: "Not a portable file name.",
        });
        continue;
      }
      const rule = inRootRule(entry.path);
      if (rule) {
        exclude(entry.path, rule);
        continue;
      }
      selected.push({ ...entry, root });
      const scanText =
        LINK_SCAN_EXTENSIONS.has(posix.extname(entry.path).toLowerCase()) &&
        entry.bytes <= LINK_SCAN_MAX_BYTES;
      if (scanText || entry.mode === "120000" || entry.path === REGISTRY_PATH) keep.add(entry.oid);
    }

    const oids = [...new Set([...selected, ...requirementPaths].map((entry) => entry.oid))];
    const parser = makeBatchParser(keep);
    if (oids.length > 0) {
      const batch = yield* processRunner
        .run({
          command: "git",
          args: [...READ_ONLY_GIT_ARGS, "cat-file", "--batch"],
          cwd: realSource,
          env: READ_ONLY_GIT_ENV,
          stdin: `${oids.join("\n")}\n`,
          onStdoutChunk: parser.push,
          maxOutputBytes: 64 * 1024,
          outputMode: "truncate",
          timeout: "10 minutes",
        })
        .pipe(Effect.mapError(fail("git")));
      if (batch.code !== 0 || parser.blobs.size !== oids.length) return yield* fail("git")();
    }
    const blob = (oid: string) => parser.blobs.get(oid) ?? { sha256: "", text: null };

    // Symlinks must point inside their own root; escaping ones are never planned.
    const included = selected.filter((entry) => {
      if (entry.mode !== "120000") return true;
      const target = blob(entry.oid).text ?? "";
      const resolved = posix.normalize(posix.join(posix.dirname(entry.path), target));
      const escapes =
        posix.isAbsolute(target) ||
        (resolved !== entry.root && !resolved.startsWith(`${entry.root}/`));
      if (escapes) {
        issues.push({
          kind: "escape",
          path: entry.path,
          detail: `Symlink to ${target} leaves ${entry.root}/.`,
        });
      }
      return !escapes;
    });
    const linkContext = { included: new Set(included.map((entry) => entry.path)), head: headPaths };

    const registryLinks = Effect.fn("MrMakImport.registryLinks")(function* (text: string) {
      const manifest = yield* decodeRegistry(text).pipe(Effect.option);
      if (manifest._tag === "None") {
        issues.push({
          kind: "registry-malformed",
          path: REGISTRY_PATH,
          detail: "Not a workspace registry.",
        });
        return [];
      }
      return manifest.value.entities.flatMap((entity) =>
        entity.steps.map((step) => {
          const link = resolveLink(
            REGISTRY_PATH,
            `${entity.folder}/${step.path}`,
            linkContext,
            "workspace",
          );
          if (
            link.status === "missing" ||
            link.status === "escape" ||
            link.status === "malformed"
          ) {
            issues.push({
              kind: STEP_ISSUE[link.status],
              path: link.resolved ?? `workspace/${entity.folder}/${step.path}`,
              detail: `Step "${step.name}" of card "${entity.id}": ${
                link.status === "missing" ? "no such file in HEAD" : `not a path inside workspace/`
              }.`,
            });
          }
          return link;
        }),
      );
    });

    const realDestination =
      input.destinationRoot === undefined
        ? null
        : yield* fileSystem.realPath(input.destinationRoot).pipe(Effect.orElseSucceed(() => null));
    const destinationState = Effect.fn("MrMakImport.destinationState")(function* (
      relativePath: string,
      sha256: string,
    ) {
      if (input.destinationRoot === undefined) return "not-checked" as const;
      if (realDestination === null) return "new" as const;
      const target = yield* fileSystem
        .realPath(path.join(realDestination, relativePath))
        .pipe(Effect.orElseSucceed(() => null));
      if (target === null) return "new" as const;
      // Anything we cannot prove identical is a conflict; M2 never overwrites one.
      if (isOutside(realDestination, target)) return "exists-different" as const;
      const bytes = yield* fileSystem.readFile(target).pipe(Effect.orElseSucceed(() => null));
      if (bytes === null) return "exists-different" as const;
      const destinationSha = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
      return destinationSha === sha256
        ? ("exists-identical" as const)
        : ("exists-different" as const);
    });

    const entries: Array<MrMakImportEntry> = [];
    for (const entry of included) {
      const { sha256, text } = blob(entry.oid);
      const isLink = entry.mode === "120000";
      const links =
        entry.path === REGISTRY_PATH
          ? yield* registryLinks(text ?? "")
          : isLink || text === null
            ? []
            : extractHrefs(entry.path, text).map((href) =>
                resolveLink(entry.path, href, linkContext),
              );
      for (const link of links) {
        if (entry.path !== REGISTRY_PATH && link.status === "missing") {
          issues.push({
            kind: "missing-link",
            path: entry.path,
            detail: `${link.href} does not exist in HEAD.`,
          });
        }
      }
      const destination: MrMakImportDestinationState = yield* destinationState(entry.path, sha256);
      entries.push({
        root: entry.root,
        sourcePath: entry.path,
        destinationPath: entry.path,
        bytes: entry.bytes,
        sha256,
        headBlobOid: entry.oid,
        kind: fileKind(entry.path),
        dirtyInWorktree: dirty.has(entry.path),
        symlinkTarget: isLink
          ? posix.normalize(posix.join(posix.dirname(entry.path), text ?? ""))
          : null,
        destination,
        links,
      });
    }

    const requirements = requirementPaths.flatMap((entry) => {
      const text = blob(entry.oid).text;
      return text === null ? [] : requirementsFrom(entry.path, text);
    });
    const skillFiles = included.filter((entry) => entry.root === SKILLS_ROOT);
    const count = (state: MrMakImportDestinationState) =>
      entries.filter((entry) => entry.destination === state).length;

    return {
      source: {
        repositoryPath: realSource,
        revision: head.stdout.trim(),
        branch: branch.exitCode === 0 ? branch.stdout.trim() || null : null,
        dirtyPaths,
      },
      destinationPath: realDestination ?? input.destinationRoot ?? null,
      roots,
      entries,
      exclusions,
      requirements,
      excludedStores: [
        {
          name: "Live chat history (.mrmak sessions and provider chat histories)",
          reason: "Stays in the original Mr. Mak app; chats are not migrated.",
        },
      ],
      issues,
      skills: {
        fullTreeFiles: skillFiles.length,
        distributionFiles: skillFiles.filter((entry) => inSkillDistribution(entry.path)).length,
      },
      totals: {
        files: entries.length,
        bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
        new: count("new"),
        existsIdentical: count("exists-identical"),
        existsDifferent: count("exists-different"),
        exclusions: exclusions.length,
        issues: issues.length,
      },
    } satisfies MrMakImportPlan;
  });

  return MrMakImport.of({ plan });
});

export const layer = Layer.effect(MrMakImport, make);
