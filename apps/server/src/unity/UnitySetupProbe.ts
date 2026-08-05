/**
 * `UnitySetupProbe` — the read-only "what's missing to make Unity work"
 * check. See docs/workbench/plan-setup-integration.md, §1/§2, and
 * `packages/contracts/src/unitySetup.ts` for the wire shape this gathers
 * data for. Ties together every input `UnitySetupClassifier.ts`'s PURE
 * `classifyUnitySetup` needs, then returns both the raw facts (increment
 * 3's future per-item panel) and the one classified primary state
 * (increment 2's future toolbar message) from a SINGLE probe call.
 *
 * PROJECT PATH IS SERVER-RESOLVED, NEVER CALLER-SUPPLIED. The HTTP route
 * resolves an opaque `projectId` through `ProjectionSnapshotQuery`, then
 * passes the canonical project root into this service. No filesystem path
 * crosses the wire, and this service never consults process cwd.
 */
import * as Clock from "effect/Clock";
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
  UnitySetupProbeSuccess,
} from "@t3tools/contracts";

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
const UNITY_PROJECT_VERSION_PATH = ["ProjectSettings", "ProjectVersion.txt"] as const;

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
    readonly probe: (workspaceRoot: string) => Effect.Effect<UnitySetupProbeSuccess>;
  }
>()("t3/unity/UnitySetupProbe") {}

export const make = Effect.gen(function* () {
  const unityPipelineClient = yield* UnityPipelineClient.UnityPipelineClient;
  const packageLock = yield* UnityPackageLock.UnityPackageLock;
  const editorPresenceRegistry = yield* EditorPresenceRegistry.EditorPresenceRegistry;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  // Captured once, when this Layer is constructed — which happens exactly
  // once, at server boot (this service's Layer is part of the same
  // dependency graph every other singleton server service is). This IS
  // "the server process's own start time" plan §2's F3 asks for; no
  // separate lifecycle event or persisted timestamp is needed for a value
  // that only ever needs to survive for the life of this one process.
  //
  // `Clock.currentTimeMillis`, not `Date.now()` — this codebase's own
  // `globalDateInEffect` rule (`tsconfig.base.json`) exists precisely so
  // time-dependent Effect code stays swappable for `TestClock` in tests.
  // This particular branch computes the S10/S10′ pairing-grace-window
  // split below, which a wall-clock read cannot exercise deterministically
  // — `TestClock.adjust` can. Found live (#118) as two real, unnoticed
  // `Date.now()` violations from tonight's own Unity-setup-detection work.
  const serverStartedAtMs = yield* Clock.currentTimeMillis;

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

  const probeCliUnavailable = Effect.fn("UnitySetupProbe.probeCliUnavailable")(function* (
    isUnityProject: boolean,
  ): Effect.fn.Return<UnitySetupProbeSuccess> {
    const cliDiscoveredPath = yield* findCliCandidatePath();
    const classifierInput: UnitySetupClassifierInput = {
      isUnityProject,
      cliAvailable: false,
      cliDiscoveredPath,
      // Phase 1 has no install action (§5, increments 4a-4c are Phase
      // 2) — this is always false until that ships, per this field's
      // own doc comment in UnitySetupClassifier.ts.
      justInstalledThisSession: false,
      lockfilePresent: false,
      pipelinePackageInstalled: false,
      // Structurally dead in this branch — `classifyUnitySetup` returns
      // S0/S1/S2/S2' from the project/CLI checks before ever reaching the
      // field this gates, same reasoning
      // `justInstalledThisSession: false` above already documents for this
      // exact branch. Left `false` rather than reading manifest.json for a
      // value that can't affect the outcome.
      pipelinePackageDeclaredInManifest: false,
      selectionPackageInstalled: false,
      pipelineList: { _tag: "notRun" },
      selectionPublisherRegistered: false,
      withinPairingGraceWindow: false,
    };
    const facts: UnitySetupFacts = {
      isUnityProject,
      cliAvailable: false,
      cliDiscoveredPath,
      lockfilePresent: false,
      pipelinePackage: { installed: false, resolvedVersion: null, declaredInManifest: false },
      selectionPackage: { installed: false, resolvedVersion: null, declaredInManifest: false },
      selectionPublisherRegistered: false,
      withinPairingGraceWindow: false,
    };
    return { facts, primary: classifyUnitySetup(classifierInput) };
  });

  const probe: UnitySetupProbe["Service"]["probe"] = Effect.fn("UnitySetupProbe.probe")(
    function* (workspaceRoot) {
      // This exact marker is the fact carried by the contract. It is checked
      // independently of CLI availability so a missing CLI cannot hide that
      // the resolved root is not a Unity project.
      const isUnityProject = yield* fileSystem
        .stat(path.join(workspaceRoot, ...UNITY_PROJECT_VERSION_PATH))
        .pipe(
          Effect.map((info) => info.type === "File"),
          Effect.orElseSucceed(() => false),
        );

      const cliAvailable = yield* unityPipelineClient.isAvailable();
      if (!cliAvailable) {
        return yield* probeCliUnavailable(isUnityProject);
      }

      const lockfilePresent = yield* probeUnityLockfilePresent(workspaceRoot).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
      const dependencies = yield* packageLock.readDependencies(workspaceRoot);
      const pipelineEntry = dependencies.get(PIPELINE_PACKAGE_ID) ?? null;
      const selectionEntry = dependencies.get(SELECTION_PACKAGE_ID) ?? null;
      // Declared-intent read (manifest.json), NOT the installed-check —
      // see `UnityPackageLock.ts`'s own module doc. Exists so a successful
      // `unity pipeline install` (plan §5's increment 4a) doesn't report
      // itself as a failure on the very next probe: found live (2026-08-04,
      // team-lead + presence-authz), install with no Editor running writes
      // ONLY this manifest line — the lock stays untouched until Unity
      // resolves it. See `UnitySetupClassifier.ts`'s S13 branch.
      const manifestDependencyIds = yield* packageLock.readManifestDependencyIds(workspaceRoot);
      const pipelinePackageDeclaredInManifest = manifestDependencyIds.has(PIPELINE_PACKAGE_ID);
      const selectionPackageDeclaredInManifest = manifestDependencyIds.has(SELECTION_PACKAGE_ID);

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
      // `workspaceRoot` pins the subprocess's own cwd, not a `--project-path`
      // filter (that flag still doesn't exist for this subcommand) — see
      // `UnityPipelineClient.ts`'s `list` doc comment for the live-observed
      // reason: the CLI's own output is sensitive to invocation directory.
      const listResult = yield* unityPipelineClient.list(workspaceRoot);
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
        const { latestVersion, unparseableInstanceCount } = listResult.value;
        // The classifier never sees `unparseableInstanceCount` — it's a
        // diagnostic/honesty fact (see UnitySetupPipelineListOutcome's doc
        // comment in packages/contracts/src/unitySetup.ts), not a
        // classification input; `matched`/`latestVersion` are exactly what
        // `classifyUnitySetup` needs and nothing more, same "facts vs.
        // primary state" separation the rest of this module already keeps.
        classifierPipelineList = { _tag: "ran", matched, latestVersion };
        factsPipelineList = { _tag: "ran", matched, latestVersion, unparseableInstanceCount };
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
      const nowMs = yield* Clock.currentTimeMillis;
      const withinPairingGraceWindow = nowMs - serverStartedAtMs < PAIRING_GRACE_WINDOW_MS;

      const classifierInput: UnitySetupClassifierInput = {
        isUnityProject,
        cliAvailable: true,
        cliDiscoveredPath: null,
        justInstalledThisSession: false,
        lockfilePresent,
        pipelinePackageInstalled: pipelineEntry !== null,
        pipelinePackageDeclaredInManifest,
        selectionPackageInstalled: selectionEntry !== null,
        pipelineList: classifierPipelineList,
        selectionPublisherRegistered,
        withinPairingGraceWindow,
      };

      const facts: UnitySetupFacts = {
        isUnityProject,
        cliAvailable: true,
        cliDiscoveredPath: null,
        lockfilePresent,
        pipelinePackage: {
          installed: pipelineEntry !== null,
          resolvedVersion: pipelineEntry?.version ?? null,
          declaredInManifest: pipelinePackageDeclaredInManifest,
        },
        selectionPackage: {
          installed: selectionEntry !== null,
          resolvedVersion: selectionEntry?.version ?? null,
          declaredInManifest: selectionPackageDeclaredInManifest,
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
