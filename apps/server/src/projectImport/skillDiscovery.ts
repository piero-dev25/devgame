// @effect-diagnostics nodeBuiltinImport:off
/**
 * skillDiscovery - which imported skills Claude and Codex actually discover
 * as project skills of a destination.
 *
 * Claude reads only `<cwd>/.claude/skills` for project scope; Codex reads the
 * repository's `.agents/skills`. A probe returns what a provider reports for a
 * cwd: in the server, the provider registry's own fresh workspace scan; outside
 * it, `cliSkillProbe`, which runs `codex app-server` with an argv (no shell).
 * Neither runs the Claude CLI: Claude's side is the server's own filesystem
 * scan (ClaudeSkills.ts), the one the Claude driver uses.
 *
 * @module skillDiscovery
 */
import * as NodePath from "node:path";

import type { MrMakSkillDiscoveryReport, ServerProviderSkill } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { discoverClaudeSkills } from "../provider/Drivers/ClaudeSkills.ts";
import { probeCodexSkillsForCwd } from "../provider/Layers/CodexProvider.ts";
import type { ProviderRegistryShape } from "../provider/Services/ProviderRegistry.ts";

type Provider = MrMakSkillDiscoveryReport["provider"];

/** What a provider reports for `cwd`; null when it is not installed, enabled or answering. */
export type SkillProbe<R = never> = (
  provider: Provider,
  cwd: string,
) => Effect.Effect<ReadonlyArray<ServerProviderSkill> | null, never, R>;

const PROJECT_ROOTS: Record<Provider, string> = {
  claude: ".claude/skills",
  codex: ".agents/skills",
};
const DRIVERS: Record<Provider, string> = { claude: "claudeAgent", codex: "codex" };

/** Sorts a provider's skills for `cwd` into project skills and copies found elsewhere. */
export const discoveryReport = (
  provider: Provider,
  cwd: string,
  expected: ReadonlyArray<string>,
  skills: ReadonlyArray<ServerProviderSkill> | null,
): MrMakSkillDiscoveryReport => {
  const projectRoot = NodePath.join(cwd, PROJECT_ROOTS[provider]);
  const project = new Set<string>();
  const elsewhere = new Set<string>();
  for (const skill of skills ?? []) {
    if (!skill.enabled) continue;
    const relative = NodePath.relative(projectRoot, skill.path);
    const inProject =
      relative !== "" && !relative.startsWith("..") && !NodePath.isAbsolute(relative);
    if (inProject) project.add(relative.split(NodePath.sep)[0] ?? relative);
    else elsewhere.add(skill.name);
  }
  const unseen = expected.filter((name) => !project.has(name));
  return {
    provider,
    status: skills === null ? "unavailable" : "checked",
    projectRoot,
    discovered: [...project].toSorted(),
    missing: unseen.filter((name) => !elsewhere.has(name)),
    shadowed: unseen.filter((name) => elsewhere.has(name)),
  };
};

export const checkSkillDiscovery = <R>(
  cwd: string,
  expected: ReadonlyArray<string>,
  probe: SkillProbe<R>,
) =>
  Effect.forEach(["claude", "codex"] as const, (provider) =>
    probe(provider, cwd).pipe(
      Effect.map((skills) => discoveryReport(provider, cwd, expected, skills)),
    ),
  );

/**
 * A fresh workspace scan by the first enabled, installed instance of each
 * provider. A failed scan leaves the registry's cached snapshot in place, so
 * only a snapshot taken after the scan started counts.
 */
export const registrySkillProbe =
  (registry: ProviderRegistryShape): SkillProbe =>
  (provider, cwd) =>
    Effect.gen(function* () {
      const instance = (yield* registry.getProviders).find(
        (candidate) =>
          candidate.driver === DRIVERS[provider] && candidate.enabled && candidate.installed,
      );
      if (instance === undefined) return null;
      const startedAt = yield* Clock.currentTimeMillis;
      const providers = yield* registry.refreshWorkspaceSnapshot({
        instanceId: instance.instanceId,
        cwd,
        fresh: true,
      });
      const snapshot = providers
        .find((candidate) => candidate.instanceId === instance.instanceId)
        ?.workspaceSnapshots?.find((candidate) => candidate.cwd === cwd);
      if (snapshot === undefined || Date.parse(snapshot.checkedAt) < startedAt) return null;
      return snapshot.skills;
    });

/** The providers' own probes, run directly with the user's default configuration. */
export const cliSkillProbe =
  (
    codexBinaryPath: string,
  ): SkillProbe<FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner> =>
  (provider, cwd) =>
    provider === "claude"
      ? discoverClaudeSkills({ homePath: "" }, cwd)
      : probeCodexSkillsForCwd({ binaryPath: codexBinaryPath, cwd }).pipe(
          Effect.scoped,
          Effect.timeout("60 seconds"),
          Effect.orElseSucceed(() => null),
        );
