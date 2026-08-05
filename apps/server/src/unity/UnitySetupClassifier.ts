/**
 * PURE classification: given everything `UnitySetupProbe.ts` gathered,
 * decide the ONE primary state a toolbar should show — no I/O, no Effect,
 * a plain function of a plain input. Split out for the same reason
 * `UnityColdStart.ts` separates `resolveUnityLaunchPlan` from
 * `probeUnityLockfilePresent`: the DECISION is what needs exhaustive,
 * mutation-proved coverage (docs/workbench/plan-setup-integration.md §2's
 * whole table), and a plain function with a plain input is what makes that
 * tractable — no fake FileSystem, no fake ProcessRunner, one call per
 * case.
 *
 * The priority order below is a design choice this file owns, not
 * something the plan's table states explicitly as a single ordered list
 * (the table gives each state its OWN detector column). Project identity
 * gates everything (Unity setup is not a meaningful question for a root
 * without Unity's marker file), then CLI availability gates the remaining
 * checks (nothing else is knowable without it); Pipeline
 * package/liveness comes next (S1-S8, the toolbar's actual Play/Stop
 * concern); selection package/pairing comes last (S9-S10) — a project
 * that's otherwise fully ready for Pipeline but hasn't installed selection
 * yet should say so, not stay silent because the higher-priority checks
 * all happened to pass. S11 (everything green) and S12 (CLI's own message,
 * unrecognized) are the two structural fallbacks — S12 short-circuits the
 * MOMENT `pipeline list` itself fails, since nothing downstream of a
 * failed call can be classified from real data.
 *
 * S13 (added 2026-08-04, not in plan §2's original table — see that
 * field's own doc comment) sits inside the same "package presence" check
 * S4/S5 do, and wins over both: a project whose manifest already declares
 * `com.unity.pipeline` but whose lock doesn't have it yet is neither
 * "nobody added it" (S5) nor cleanly awaiting the user's action (S4) — it's
 * a real install that Unity simply hasn't resolved yet. Found live via a
 * successful `unity pipeline install` reporting itself back as "package
 * still missing" on the very next probe — the exact class of false message
 * this whole feature exists to eliminate, reproduced by its own success
 * path.
 */

export interface UnitySetupClassifierMatchedInstance {
  readonly isRunning: boolean;
  readonly isReachable: boolean;
  readonly safeMode: boolean | null;
  readonly updateAvailable: boolean | null;
}

export type UnitySetupClassifierPipelineList =
  | { readonly _tag: "notRun" }
  | { readonly _tag: "cliError"; readonly message: string; readonly command: string }
  | {
      readonly _tag: "ran";
      readonly matched: UnitySetupClassifierMatchedInstance | null;
      /** `unity pipeline list --json`'s own `data.latestVersion` — a
       * CLI-WIDE fact ("the newest Pipeline version this CLI knows how to
       * install"), NOT a per-instance one. Confirmed against a real
       * captured sample (2026-08-04, `Mafia Game`, a live Editor with no
       * Pipeline package installed): `data.latestVersion` sits alongside
       * `data.instances`, not inside any one instance object. Lives here,
       * sibling to `matched`, rather than on
       * `UnitySetupClassifierMatchedInstance`, for that reason — moving it
       * onto the matched instance was the original (wrong, reconstructed)
       * shape this file shipped with before that sample existed. */
      readonly latestVersion: string | null;
    };

export interface UnitySetupClassifierInput {
  /** Whether the resolved root contains
   * `ProjectSettings/ProjectVersion.txt`. */
  readonly isUnityProject: boolean;
  readonly cliAvailable: boolean;
  /** Populated only when `cliAvailable` is `false` and a candidate binary
   * was found off-PATH — plan §7's F11 fix. */
  readonly cliDiscoveredPath: string | null;
  /** Set by the caller ONLY right after an install action in the SAME
   * process succeeds (plan §5's F5 fix, increment 4b) — always `false` in
   * Phase 1, since no install action exists yet. Kept as a real input
   * (not hardcoded `false` inline) so this exact branch is unit-testable
   * now, ahead of Phase 2 wiring it for real. */
  readonly justInstalledThisSession: boolean;
  readonly lockfilePresent: boolean;
  readonly pipelinePackageInstalled: boolean;
  /** Whether `Packages/manifest.json` names `com.unity.pipeline` directly —
   * DECLARED intent, never the installed-check (`UnityPackageLock.ts`'s own
   * module doc: manifest is read "only for §3's future consent-prompt
   * honesty," never as a substitute for the lock). Exists so a successful
   * `install` (plan §5's increment 4a) doesn't report itself as a failure:
   * found live (2026-08-04, team-lead + presence-authz, following §8-1's
   * own experiment) — with no Editor running, `install` writes ONLY this
   * one manifest line; `packages-lock.json` is untouched until Unity next
   * resolves it. Without this fact, the very next probe after a SUCCESSFUL
   * install still reads `pipelinePackageInstalled: false` (correctly, per
   * F1's ruling — the lock genuinely has no entry yet) and falls through to
   * S4/S5's "package missing" sentence — a true install, reported as a
   * failure, by the classifier's own correct rule for a DIFFERENT question.
   * See `classifyUnitySetup`'s S13 branch for the fix: this fact doesn't
   * change what "installed" means, it adds the ONE piece of context that
   * distinguishes "never added" from "added, not yet resolved." */
  readonly pipelinePackageDeclaredInManifest: boolean;
  readonly selectionPackageInstalled: boolean;
  readonly pipelineList: UnitySetupClassifierPipelineList;
  /** Whether `EditorPresenceRegistry` has a publisher registered for this
   * project's workspace root right now — plan §2's F3. */
  readonly selectionPublisherRegistered: boolean;
  /** Whether this classification is happening inside the grace window
   * after server start — plan §2's F3, the window S10′ exists for. */
  readonly withinPairingGraceWindow: boolean;
}

export type UnitySetupPrimaryStateResult =
  | { readonly state: "S0"; readonly message: string }
  | { readonly state: "S1"; readonly message: string }
  | { readonly state: "S2"; readonly message: string; readonly discoveredPath: string }
  | { readonly state: "S2'"; readonly message: string }
  | { readonly state: "S4"; readonly message: string }
  | { readonly state: "S4'"; readonly message: string }
  | { readonly state: "S5"; readonly message: string }
  | { readonly state: "S6"; readonly message: string }
  | { readonly state: "S7a"; readonly message: string }
  | { readonly state: "S7b"; readonly message: string }
  | { readonly state: "S8"; readonly message: string; readonly latestVersion: string }
  | { readonly state: "S9"; readonly message: string }
  | { readonly state: "S10"; readonly message: string }
  | { readonly state: "S10'"; readonly message: string }
  | { readonly state: "S11" }
  | { readonly state: "S12"; readonly message: string; readonly command: string }
  | { readonly state: "S13"; readonly message: string };

// Every sentence below is copied VERBATIM from plan §2's table — a reader
// diffing this file against that table should find byte-identical text,
// not a paraphrase.
const S0_MESSAGE =
  "This project doesn't look like a Unity project — no ProjectSettings/ProjectVersion.txt was found.";
const S1_MESSAGE =
  "Unity's command-line tool isn't installed on this machine. DevGame needs it to talk to the Editor.";
const S2_PRIME_MESSAGE = "The Unity CLI is installed. Finishing setup…";
const S4_MESSAGE =
  "Unity is open, but this project doesn't have Unity's Pipeline package — that's why Play doesn't work here. DevGame can add it to this project.";
const S4_PRIME_MESSAGE = "Checking Unity's status…";
const S5_MESSAGE =
  "This project doesn't have Unity's Pipeline package, and Unity isn't open. Add the package, then open the project in Unity.";
const S6_MESSAGE =
  "Unity isn't open for this project. Open it in the Unity Editor, then try again.";
const S7A_MESSAGE =
  "Unity is in Safe Mode because of a compile error in this project. Fix the error in the Editor, then Unity will exit Safe Mode on its own.";
const S7B_MESSAGE = "Waiting for Unity to respond…";
/** NOT copied from plan §2's table — that table predates this state (added
 * 2026-08-04, team-lead + presence-authz, found live via §8-1's own
 * experiment). Deliberately does NOT say "open the project in Unity" the
 * way the first draft of this fix did — that phrasing is only true when
 * Unity is currently closed, and this state can just as easily fire while
 * Unity IS open and simply hasn't re-resolved yet (the exact liveness
 * ambiguity S4/S4' already exist to avoid making promises about). Worded to
 * be true either way. */
const S13_MESSAGE =
  "Pipeline is added to this project — Unity resolves it automatically, either right away if the project is already open, or the next time you open it.";
const S9_MESSAGE =
  "Unity selection chips are off — this project doesn't have DevGame's selection package.";
const S10_MESSAGE =
  "Unity has DevGame's selection package but isn't paired with this app yet. Pair it from Settings > Connections.";
const S10_PRIME_MESSAGE = "Checking Unity's connection…";

function buildS2Message(discoveredPath: string): string {
  return `The Unity CLI is installed at \`${discoveredPath}\`, but DevGame can't find it on this app's PATH. Quit and reopen DevGame; if it persists, tell us — this is a DevGame bug, not a Unity one.`;
}

function buildS8Message(latestVersion: string): string {
  return `This project's Pipeline package is older than your Unity CLI expects. Update it to \`${latestVersion}\`?`;
}

export function classifyUnitySetup(input: UnitySetupClassifierInput): UnitySetupPrimaryStateResult {
  // 1. Project identity wins before every setup fact. CLI availability,
  // package state, and Editor liveness are irrelevant for a non-Unity root.
  if (!input.isUnityProject) {
    return { state: "S0", message: S0_MESSAGE };
  }

  // 2. CLI availability gates everything downstream — nothing past this
  // point is knowable without a working `unity` binary.
  if (!input.cliAvailable) {
    if (input.justInstalledThisSession) {
      return { state: "S2'", message: S2_PRIME_MESSAGE };
    }
    if (input.cliDiscoveredPath !== null) {
      return {
        state: "S2",
        message: buildS2Message(input.cliDiscoveredPath),
        discoveredPath: input.cliDiscoveredPath,
      };
    }
    return { state: "S1", message: S1_MESSAGE };
  }

  // 3. `pipeline list` itself failed — plan §1: "when nothing matches,
  // show the CLI's own message verbatim." Nothing below this line can be
  // trusted once the one call everything else depends on has failed.
  if (input.pipelineList._tag === "cliError") {
    return {
      state: "S12",
      message: input.pipelineList.message,
      command: input.pipelineList.command,
    };
  }

  // 4. Liveness-uncertain window (F13): the lockfile fired, but
  // `pipeline list` — the AUTHORITATIVE liveness signal — hasn't actually
  // run this cycle. Never commit to a liveness-dependent classification
  // (S4/S6/S7a/S7b/S8) on the cheap ambient signal alone.
  const listRan = input.pipelineList._tag === "ran";
  if (input.lockfilePresent && !listRan) {
    return { state: "S4'", message: S4_PRIME_MESSAGE };
  }
  const matched = input.pipelineList._tag === "ran" ? input.pipelineList.matched : null;
  // CLI-wide, not instance-specific — see the doc comment on
  // `UnitySetupClassifierPipelineList`'s "ran" variant above.
  const latestVersion = input.pipelineList._tag === "ran" ? input.pipelineList.latestVersion : null;
  // A "match" whose own `isRunning` is false is a STALE lock the same way
  // an absent match is — F13's exact "crashed or force-quit Editor"
  // scenario. Both fold into the same "not actually live" signal below.
  const liveMatch = matched !== null && matched.isRunning ? matched : null;

  // 5. Pipeline package presence + liveness.
  if (!input.pipelinePackageInstalled) {
    // S13 wins over BOTH S4 and S5 — "we just wrote it and Unity hasn't
    // caught up" is a different world from "nobody ever added it," and
    // that's true whether or not Unity happens to be open right now (S4's
    // own "DevGame can add it to this project" offer would be actively
    // wrong here: it's already added, just not yet resolved).
    if (input.pipelinePackageDeclaredInManifest) {
      return { state: "S13", message: S13_MESSAGE };
    }
    return liveMatch !== null
      ? { state: "S4", message: S4_MESSAGE }
      : { state: "S5", message: S5_MESSAGE };
  }
  if (liveMatch === null) {
    return { state: "S6", message: S6_MESSAGE };
  }
  if (!liveMatch.isReachable) {
    return liveMatch.safeMode === true
      ? { state: "S7a", message: S7A_MESSAGE }
      : { state: "S7b", message: S7B_MESSAGE };
  }
  if (liveMatch.updateAvailable === true && latestVersion !== null) {
    return { state: "S8", message: buildS8Message(latestVersion), latestVersion };
  }
  // S8′ (update status unknown — Unity closed, or `latestVersion` null) is
  // deliberately NOT a return here: plan §2 says it "falls through to
  // whichever of S6/S11 otherwise applies," never asserted as its own
  // primary state. Continue to the selection-package checks below.

  // 6. Selection package presence + pairing.
  if (!input.selectionPackageInstalled) {
    return { state: "S9", message: S9_MESSAGE };
  }
  if (!input.selectionPublisherRegistered) {
    // S10/S10′'s own precondition (plan §2): only evaluated once THIS
    // SAME liveness signal is already confirmed green — `liveMatch` at
    // this point in the function is guaranteed non-null (every branch
    // above that could leave it null already returned), so that
    // precondition is structurally satisfied here, not re-checked.
    return input.withinPairingGraceWindow
      ? { state: "S10'", message: S10_PRIME_MESSAGE }
      : { state: "S10", message: S10_MESSAGE };
  }

  // 7. Everything checked is green.
  return { state: "S11" };
}
