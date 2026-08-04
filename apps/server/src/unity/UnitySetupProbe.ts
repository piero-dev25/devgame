/**
 * `UnitySetupProbe` — the read-only "what's missing to make Unity work"
 * check. See docs/workbench/plan-setup-integration.md, §1/§2, and
 * `packages/contracts/src/unitySetup.ts` for the wire shape this gathers
 * data for. Ties together every input `UnitySetupClassifier.ts`'s PURE
 * `classifyUnitySetup` needs, then returns both the raw facts (increment
 * 3's future per-item panel) and the one classified primary state
 * (increment 2's future toolbar message) from a SINGLE probe call.
 *
 * PROJECT PATH IS SERVER-RESOLVED, NEVER CALLER-SUPPLIED — plan §1's F6,
 * second half. This server process is already scoped to exactly ONE
 * project (`ServerConfig.cwd` — confirmed at
 * `apps/server/src/serverRuntimeStartup.ts:211`, the same value seeded
 * into the bootstrap project at server start; every T3 server process is
 * one project, one process). There is no multi-project registry to
 * validate a caller-supplied path against, and therefore nothing for a
 * caller to supply: `workspaceRoot` below is read directly from
 * `ServerConfig`, not from any request input. `POST /unity/command`'s
 * caller-supplied `workspaceRoot` is only safe there because
 * `presence:command` is desktop-owner-only (already running locally with
 * full filesystem access regardless of what path it names) — this
 * service is reachable via the broadly-granted `presence:read` and must
 * not mirror that pattern.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as NodeOS from "node:os";
import * as Path from "effect/Path";

import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { normalizeWorkspaceRoot } from "@t3tools/shared/workspaceRootPath";
import type {
  UnitySetupFacts,
  UnitySetupPipelineListOutcome,
  UnitySetupProbeResult,
} from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as EditorPresenceRegistry from "../editorPresence/EditorPresenceRegistry.ts";
import { probeUnityLockfilePresent } from "../editorPresence/UnityColdStart.ts";
import {
  classifyUnitySetup,
  type UnitySetupClassifierInput,
  type UnitySetupClassifierPipelineList,
} from "./UnitySetupClassifier.ts";
import * as UnityPackageLock from "./UnityPackageLock.ts";
import * as UnityPipelineClient from "./UnityPipelineClient.ts";

const PIPELINE_PACKAGE_ID = "com.unity.pipeline";
const SELECTION_PACKAGE_ID = "com.ironmind.editor-presence";

/** Plan §2's F3 default — tunable, per that section's own note. */
const PAIRING_GRACE_WINDOW_MS = 15_000;

/** Kept alongside the probe so `UnitySetupClassifierPipelineList`'s
 * `cliError` command string is the exact literal this module ran, not a
 * guess reconstructed by whoever renders S12. */
export const PIPELINE_LIST_COMMAND = "unity pipeline list --json";

// F11's candidate-path fix (plan §7): a Windows/Linux user, or anyone
// whose installer wrote somewhere else, must not be told S1 ("not
// installed") when a real binary sits off-PATH. Plan §8, item 3 flags the
// installer's ACTUAL on-disk behavior as UNEXERCISED — no real `unity`
// install has been observed by this change. This checks the ONE location
// this repo's own history names (`~/.unity/bin/unity`, cited from
// `~/.unity/env`'s own comment plus mtime correlation on the original
// author's machine) as a best-effort starting point, not a settled list —
// §8-3 should expand or correct this once the installer's real behavior is
// confirmed. A miss here reports S1, not a false S2 — see
// `findCliCandidatePath`'s own doc below for why that's the safe default.
function homeUnityCliCandidatePath(path: Path.Path, homeDir: string): string {
  return path.join(homeDir, ".unity", "bin", "unity");
}

export class UnitySetupProbe extends Context.Service<
  UnitySetupProbe,
  {
    readonly probe: () => Effect.Effect<UnitySetupProbeResult>;
  }
>()("t3/unity/UnitySetupProbe") {}

export const make = Effect.gen(function* () {
  const unityPipelineClient = yield* UnityPipelineClient.UnityPipelineClient;
  const packageLock = yield* UnityPackageLock.UnityPackageLock;
  const editorPresenceRegistry = yield* EditorPresenceRegistry.EditorPresenceRegistry;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  // Captured once, when this Layer is constructed — which happens exactly
  // once, at server boot (this service's Layer is part of the same
  // dependency graph every other singleton server service is). This IS
  // "the server process's own start time" plan §2's F3 asks for; no
  // separate lifecycle event or persisted timestamp is needed for a value
  // that only ever needs to survive for the life of this one process.
  const serverStartedAtMs = yield* Effect.sync(() => Date.now());

  /** Not found (S1) is the SAFE default when the discovered-path check
   * itself can't run (permission error, no HOME, etc.) — degrading to "I
   * found a path" on an I/O failure would be the wrong direction: it would
   * tell a user DevGame found something that in fact was never confirmed.
   * Best-effort, matching `EngineTypeResolver.ts`'s own posture for the
   * identical class of problem. */
  const findCliCandidatePath = Effect.fn("UnitySetupProbe.findCliCandidatePath")(
    function* (): Effect.fn.Return<string | null> {
      // Read via `HostProcessEnvironment` (a `Context.Reference`, same
      // injection point `os-jank.ts`'s `hydratePosixHome` uses for the
      // identical class of problem) rather than `NodeOS.homedir()`
      // directly — this candidate path is a REAL, easy-to-hit false
      // positive on any machine that happens to have the Unity CLI
      // installed at its default location (this repo's own dev machine
      // does), which a test suite must be able to override, not merely
      // hope never collides with. Falls back to `NodeOS.homedir()` only
      // when `HOME` itself is unset/blank, matching `hydratePosixHome`'s
      // own fallback direction.
      const env = yield* HostProcessEnvironment;
      const homeDir = env.HOME?.trim() ? env.HOME : NodeOS.homedir();
      const candidate = homeUnityCliCandidatePath(path, homeDir);
      const exists = yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false));
      return exists ? candidate : null;
    },
  );

  const probeCliUnavailable = Effect.fn("UnitySetupProbe.probeCliUnavailable")(
    function* (): Effect.fn.Return<UnitySetupProbeResult> {
      const cliDiscoveredPath = yield* findCliCandidatePath();
      const classifierInput: UnitySetupClassifierInput = {
        cliAvailable: false,
        cliDiscoveredPath,
        // Phase 1 has no install action (§5, increments 4a-4c are Phase
        // 2) — this is always false until that ships, per this field's
        // own doc comment in UnitySetupClassifier.ts.
        justInstalledThisSession: false,
        lockfilePresent: false,
        pipelinePackageInstalled: false,
        selectionPackageInstalled: false,
        pipelineList: { _tag: "notRun" },
        selectionPublisherRegistered: false,
        withinPairingGraceWindow: false,
      };
      const facts: UnitySetupFacts = {
        cliAvailable: false,
        cliDiscoveredPath,
        lockfilePresent: false,
        pipelinePackage: { installed: false, resolvedVersion: null },
        selectionPackage: { installed: false, resolvedVersion: null },
        selectionPublisherRegistered: false,
        withinPairingGraceWindow: false,
      };
      return { facts, primary: classifyUnitySetup(classifierInput) };
    },
  );

  const probe: UnitySetupProbe["Service"]["probe"] = Effect.fn("UnitySetupProbe.probe")(
    function* () {
      const workspaceRoot = serverConfig.cwd;

      const cliAvailable = yield* unityPipelineClient.isAvailable();
      if (!cliAvailable) {
        return yield* probeCliUnavailable();
      }

      const lockfilePresent = yield* probeUnityLockfilePresent(workspaceRoot).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
      const dependencies = yield* packageLock.readDependencies(workspaceRoot);
      const pipelineEntry = dependencies.get(PIPELINE_PACKAGE_ID) ?? null;
      const selectionEntry = dependencies.get(SELECTION_PACKAGE_ID) ?? null;

      // ALWAYS called once the CLI is confirmed available — this route
      // itself IS the "on demand" trigger the plan's own cadence table
      // names (panel open / Play click / explicit refresh), so there is
      // no separate "ambient" tier above this to defer the ~400ms cost
      // to. One consequence, noted explicitly rather than left implicit:
      // `UnitySetupClassifierInput.pipelineList` is therefore NEVER
      // `{_tag: "notRun"}` by the time `classifyUnitySetup` runs from
      // THIS service — S4' is reachable and correctly handled by the pure
      // classifier (and is unit-tested directly, per
      // `UnitySetupClassifier.test.ts`), but is not observable through
      // this particular route today. A future caller that adds its own
      // short-TTL cache in front of the `pipeline list` call (to bound
      // request rate from a chattier caller than "on demand") would make
      // it reachable live, without any change to the classifier itself.
      const listResult = yield* unityPipelineClient.list();
      let classifierPipelineList: UnitySetupClassifierPipelineList;
      let factsPipelineList: UnitySetupPipelineListOutcome;
      if (listResult._tag === "ok") {
        const matched =
          listResult.value.instances.find(
            (instance) =>
              normalizeWorkspaceRoot(instance.projectPath) ===
              normalizeWorkspaceRoot(workspaceRoot),
          ) ?? null;
        // `latestVersion` is CLI-wide (plan §1, corrected against the real
        // captured sample — see UnityPipelineClient.ts), so it's read off
        // the list result itself, not off `matched`.
        const { latestVersion } = listResult.value;
        classifierPipelineList = { _tag: "ran", matched, latestVersion };
        factsPipelineList = { _tag: "ran", matched, latestVersion };
      } else {
        // `notReady`/`cliUnavailable` are not real outcomes for `list()`
        // (see that method's own doc comment in UnityPipelineClient.ts),
        // but the return type still allows them structurally — folded
        // into the same verbatim-message S12 path as a genuine `error`
        // rather than silently discarded, matching this whole module's
        // "never guess at an unfamiliar shape" posture.
        const message =
          listResult._tag === "error" ? listResult.message : "the Unity CLI became unavailable";
        classifierPipelineList = { _tag: "cliError", message, command: PIPELINE_LIST_COMMAND };
        factsPipelineList = { _tag: "cliError", message };
      }

      const selectionPublisherRegistered =
        yield* editorPresenceRegistry.hasPublisherForWorkspace(workspaceRoot);
      const withinPairingGraceWindow = Date.now() - serverStartedAtMs < PAIRING_GRACE_WINDOW_MS;

      const classifierInput: UnitySetupClassifierInput = {
        cliAvailable: true,
        cliDiscoveredPath: null,
        justInstalledThisSession: false,
        lockfilePresent,
        pipelinePackageInstalled: pipelineEntry !== null,
        selectionPackageInstalled: selectionEntry !== null,
        pipelineList: classifierPipelineList,
        selectionPublisherRegistered,
        withinPairingGraceWindow,
      };

      const facts: UnitySetupFacts = {
        cliAvailable: true,
        cliDiscoveredPath: null,
        lockfilePresent,
        pipelinePackage: {
          installed: pipelineEntry !== null,
          resolvedVersion: pipelineEntry?.version ?? null,
        },
        selectionPackage: {
          installed: selectionEntry !== null,
          resolvedVersion: selectionEntry?.version ?? null,
        },
        pipelineList: factsPipelineList,
        selectionPublisherRegistered,
        withinPairingGraceWindow,
      };

      return { facts, primary: classifyUnitySetup(classifierInput) };
    },
  );

  return UnitySetupProbe.of({ probe });
});

export const layer = Layer.effect(UnitySetupProbe, make);
