import { describe, expect, it } from "vite-plus/test";

import {
  classifyUnitySetup,
  type UnitySetupClassifierInput,
  type UnitySetupClassifierMatchedInstance,
  type UnitySetupClassifierPipelineList,
} from "./UnitySetupClassifier.ts";

// Every test below constructs a FULL, explicit input — no shared "base"
// object with per-test overrides. A shared base hides exactly the kind of
// bug this file exists to catch: two states reachable from inputs that
// differ in only one field a shared fixture happened to default the same
// way for both. Verbose on purpose.

const NOT_RUN = { _tag: "notRun" } as const;

function liveReachable(
  overrides: Partial<UnitySetupClassifierMatchedInstance> = {},
): UnitySetupClassifierMatchedInstance {
  return {
    isRunning: true,
    isReachable: true,
    safeMode: false,
    updateAvailable: false,
    ...overrides,
  };
}

/** `latestVersion` is CLI-wide (plan §1, corrected against the real
 * captured sample), not part of any one matched instance — see the doc
 * comment on `UnitySetupClassifierPipelineList`'s "ran" variant. This is a
 * thin wrapper for that shape, same convenience role `liveReachable` plays
 * for the matched instance itself, not a shared INPUT fixture. */
function ranList(
  matched: UnitySetupClassifierMatchedInstance | null,
  latestVersion: string | null = null,
): UnitySetupClassifierPipelineList {
  return { _tag: "ran", matched, latestVersion };
}

describe("classifyUnitySetup", () => {
  it("S0: a non-Unity root reports that fact before the missing Pipeline package fallback", () => {
    const input: UnitySetupClassifierInput & { readonly isUnityProject: boolean } = {
      isUnityProject: false,
      cliAvailable: true,
      cliDiscoveredPath: null,
      justInstalledThisSession: false,
      lockfilePresent: false,
      pipelinePackageInstalled: false,
      pipelinePackageDeclaredInManifest: false,
      selectionPackageInstalled: false,
      pipelineList: ranList(null),
      selectionPublisherRegistered: false,
      withinPairingGraceWindow: false,
    };

    expect(classifyUnitySetup(input)).toEqual({
      state: "S0",
      message:
        "This project doesn't look like a Unity project — no ProjectSettings/ProjectVersion.txt was found.",
    });
  });

  it("S1: CLI unavailable, no candidate found off-PATH", () => {
    const input: UnitySetupClassifierInput = {
      isUnityProject: true,
      cliAvailable: false,
      cliDiscoveredPath: null,
      justInstalledThisSession: false,
      lockfilePresent: false,
      pipelinePackageInstalled: false,
      pipelinePackageDeclaredInManifest: false,
      selectionPackageInstalled: false,
      pipelineList: NOT_RUN,
      selectionPublisherRegistered: false,
      withinPairingGraceWindow: false,
    };
    expect(classifyUnitySetup(input)).toEqual({
      state: "S1",
      message:
        "Unity's command-line tool isn't installed on this machine. DevGame needs it to talk to the Editor.",
    });
  });

  it("S2: CLI unavailable, a candidate WAS found off-PATH — names the discovered path", () => {
    const input: UnitySetupClassifierInput = {
      isUnityProject: true,
      cliAvailable: false,
      cliDiscoveredPath: "/opt/homebrew/bin/unity",
      justInstalledThisSession: false,
      lockfilePresent: false,
      pipelinePackageInstalled: false,
      pipelinePackageDeclaredInManifest: false,
      selectionPackageInstalled: false,
      pipelineList: NOT_RUN,
      selectionPublisherRegistered: false,
      withinPairingGraceWindow: false,
    };
    const result = classifyUnitySetup(input);
    expect(result.state).toBe("S2");
    if (result.state !== "S2") return;
    expect(result.discoveredPath).toBe("/opt/homebrew/bin/unity");
    expect(result.message).toContain("/opt/homebrew/bin/unity");
    expect(result.message).toContain("this is a DevGame bug, not a Unity one");
  });

  it("S2': justInstalledThisSession WINS over a discovered path — never shown alongside S2's 'DevGame bug' copy", () => {
    const input: UnitySetupClassifierInput = {
      isUnityProject: true,
      cliAvailable: false,
      cliDiscoveredPath: "/opt/homebrew/bin/unity",
      justInstalledThisSession: true,
      lockfilePresent: false,
      pipelinePackageInstalled: false,
      pipelinePackageDeclaredInManifest: false,
      selectionPackageInstalled: false,
      pipelineList: NOT_RUN,
      selectionPublisherRegistered: false,
      withinPairingGraceWindow: false,
    };
    const result = classifyUnitySetup(input);
    expect(result.state).toBe("S2'");
    if (result.state !== "S2'") return;
    expect(result.message).not.toContain("DevGame bug");
  });

  it("CLI unavailable OUTRANKS every other fact — a project that's otherwise fully green still reports S1", () => {
    const input: UnitySetupClassifierInput = {
      isUnityProject: true,
      cliAvailable: false,
      cliDiscoveredPath: null,
      justInstalledThisSession: false,
      lockfilePresent: true,
      pipelinePackageInstalled: true,
      pipelinePackageDeclaredInManifest: false,
      selectionPackageInstalled: true,
      pipelineList: ranList(liveReachable()),
      selectionPublisherRegistered: true,
      withinPairingGraceWindow: false,
    };
    expect(classifyUnitySetup(input).state).toBe("S1");
  });

  it("S12: pipeline list itself failed — the CLI's own message and command pass through VERBATIM", () => {
    const input: UnitySetupClassifierInput = {
      isUnityProject: true,
      cliAvailable: true,
      cliDiscoveredPath: null,
      justInstalledThisSession: false,
      lockfilePresent: true,
      pipelinePackageInstalled: true,
      pipelinePackageDeclaredInManifest: false,
      selectionPackageInstalled: true,
      pipelineList: {
        _tag: "cliError",
        message: "Some brand-new CLI wording nobody has seen before",
        command: "unity pipeline list --json",
      },
      selectionPublisherRegistered: true,
      withinPairingGraceWindow: false,
    };
    expect(classifyUnitySetup(input)).toEqual({
      state: "S12",
      message: "Some brand-new CLI wording nobody has seen before",
      command: "unity pipeline list --json",
    });
  });

  it("S12 outranks the lockfile/package checks — a failed pipeline list is reported even when the lockfile looks fine", () => {
    const input: UnitySetupClassifierInput = {
      isUnityProject: true,
      cliAvailable: true,
      cliDiscoveredPath: null,
      justInstalledThisSession: false,
      lockfilePresent: false,
      pipelinePackageInstalled: true,
      pipelinePackageDeclaredInManifest: false,
      selectionPackageInstalled: true,
      pipelineList: { _tag: "cliError", message: "boom", command: "unity pipeline list --json" },
      selectionPublisherRegistered: true,
      withinPairingGraceWindow: false,
    };
    expect(classifyUnitySetup(input).state).toBe("S12");
  });

  it("S4': lockfile present but pipeline list hasn't run this cycle — never commits to S4 or S6", () => {
    const input: UnitySetupClassifierInput = {
      isUnityProject: true,
      cliAvailable: true,
      cliDiscoveredPath: null,
      justInstalledThisSession: false,
      lockfilePresent: true,
      pipelinePackageInstalled: false,
      pipelinePackageDeclaredInManifest: false,
      selectionPackageInstalled: false,
      pipelineList: NOT_RUN,
      selectionPublisherRegistered: false,
      withinPairingGraceWindow: false,
    };
    expect(classifyUnitySetup(input)).toEqual({
      state: "S4'",
      message: "Checking Unity's status…",
    });
  });

  it("S4' also fires when the package IS installed — the checking window applies regardless of package state", () => {
    const input: UnitySetupClassifierInput = {
      isUnityProject: true,
      cliAvailable: true,
      cliDiscoveredPath: null,
      justInstalledThisSession: false,
      lockfilePresent: true,
      pipelinePackageInstalled: true,
      pipelinePackageDeclaredInManifest: false,
      selectionPackageInstalled: true,
      pipelineList: NOT_RUN,
      selectionPublisherRegistered: true,
      withinPairingGraceWindow: false,
    };
    expect(classifyUnitySetup(input).state).toBe("S4'");
  });

  it("S4: package missing, lockfile absent but pipeline list confirms a live matched instance — THE defect", () => {
    const input: UnitySetupClassifierInput = {
      isUnityProject: true,
      cliAvailable: true,
      cliDiscoveredPath: null,
      justInstalledThisSession: false,
      lockfilePresent: false,
      pipelinePackageInstalled: false,
      pipelinePackageDeclaredInManifest: false,
      selectionPackageInstalled: false,
      pipelineList: ranList(liveReachable()),
      selectionPublisherRegistered: false,
      withinPairingGraceWindow: false,
    };
    expect(classifyUnitySetup(input)).toEqual({
      state: "S4",
      message:
        "Unity is open, but this project doesn't have Unity's Pipeline package — that's why Play doesn't work here. DevGame can add it to this project.",
    });
  });

  it("S5: package missing, lockfile absent, pipeline list ran and found no match at all", () => {
    const input: UnitySetupClassifierInput = {
      isUnityProject: true,
      cliAvailable: true,
      cliDiscoveredPath: null,
      justInstalledThisSession: false,
      lockfilePresent: false,
      pipelinePackageInstalled: false,
      pipelinePackageDeclaredInManifest: false,
      selectionPackageInstalled: false,
      pipelineList: ranList(null),
      selectionPublisherRegistered: false,
      withinPairingGraceWindow: false,
    };
    expect(classifyUnitySetup(input).state).toBe("S5");
  });

  it("S5, not S4: package missing, a match WAS found but its own isRunning is false (stale lock, F13)", () => {
    const input: UnitySetupClassifierInput = {
      isUnityProject: true,
      cliAvailable: true,
      cliDiscoveredPath: null,
      justInstalledThisSession: false,
      lockfilePresent: false,
      pipelinePackageInstalled: false,
      pipelinePackageDeclaredInManifest: false,
      selectionPackageInstalled: false,
      pipelineList: ranList(liveReachable({ isRunning: false })),
      selectionPublisherRegistered: false,
      withinPairingGraceWindow: false,
    };
    expect(classifyUnitySetup(input).state).toBe("S5");
  });

  it("S13: package declared in manifest but not yet in the lock, Unity NOT live — wins over S5", () => {
    const input: UnitySetupClassifierInput = {
      isUnityProject: true,
      cliAvailable: true,
      cliDiscoveredPath: null,
      justInstalledThisSession: false,
      lockfilePresent: false,
      pipelinePackageInstalled: false,
      pipelinePackageDeclaredInManifest: true,
      selectionPackageInstalled: false,
      pipelineList: ranList(null),
      selectionPublisherRegistered: false,
      withinPairingGraceWindow: false,
    };
    expect(classifyUnitySetup(input)).toEqual({
      state: "S13",
      message:
        "Pipeline is added to this project — Unity resolves it automatically, either right away if the project is already open, or the next time you open it.",
    });
  });

  it("S13, not S4: package declared in manifest but not yet in the lock, Unity IS live — still wins, never offers 'add it' again", () => {
    const input: UnitySetupClassifierInput = {
      isUnityProject: true,
      cliAvailable: true,
      cliDiscoveredPath: null,
      justInstalledThisSession: false,
      lockfilePresent: false,
      pipelinePackageInstalled: false,
      pipelinePackageDeclaredInManifest: true,
      selectionPackageInstalled: false,
      pipelineList: ranList(liveReachable()),
      selectionPublisherRegistered: false,
      withinPairingGraceWindow: false,
    };
    expect(classifyUnitySetup(input).state).toBe("S13");
  });

  it("S6: package installed, lockfile absent (never called pipeline list at all)", () => {
    const input: UnitySetupClassifierInput = {
      isUnityProject: true,
      cliAvailable: true,
      cliDiscoveredPath: null,
      justInstalledThisSession: false,
      lockfilePresent: false,
      pipelinePackageInstalled: true,
      pipelinePackageDeclaredInManifest: false,
      selectionPackageInstalled: false,
      pipelineList: NOT_RUN,
      selectionPublisherRegistered: false,
      withinPairingGraceWindow: false,
    };
    expect(classifyUnitySetup(input)).toEqual({
      state: "S6",
      message: "Unity isn't open for this project. Open it in the Unity Editor, then try again.",
    });
  });

  it("S6, not S4: package installed, pipeline list ran and found no LIVE matching instance (stale lock)", () => {
    const input: UnitySetupClassifierInput = {
      isUnityProject: true,
      cliAvailable: true,
      cliDiscoveredPath: null,
      justInstalledThisSession: false,
      lockfilePresent: true,
      pipelinePackageInstalled: true,
      pipelinePackageDeclaredInManifest: false,
      selectionPackageInstalled: false,
      pipelineList: ranList(liveReachable({ isRunning: false })),
      selectionPublisherRegistered: false,
      withinPairingGraceWindow: false,
    };
    expect(classifyUnitySetup(input).state).toBe("S6");
  });

  it("S7a: installed, live, unreachable, safeMode TRUE — the distinct non-auto-clearing message (F2)", () => {
    const input: UnitySetupClassifierInput = {
      isUnityProject: true,
      cliAvailable: true,
      cliDiscoveredPath: null,
      justInstalledThisSession: false,
      lockfilePresent: true,
      pipelinePackageInstalled: true,
      pipelinePackageDeclaredInManifest: false,
      selectionPackageInstalled: false,
      pipelineList: ranList(liveReachable({ isReachable: false, safeMode: true })),
      selectionPublisherRegistered: false,
      withinPairingGraceWindow: false,
    };
    const result = classifyUnitySetup(input);
    expect(result.state).toBe("S7a");
    if (result.state !== "S7a") return;
    expect(result.message).toContain("Safe Mode");
    expect(result.message).not.toContain("reload");
  });

  it("S7b: installed, live, unreachable, safeMode FALSE — the bounded-retry 'waiting' message, not S7a's", () => {
    const input: UnitySetupClassifierInput = {
      isUnityProject: true,
      cliAvailable: true,
      cliDiscoveredPath: null,
      justInstalledThisSession: false,
      lockfilePresent: true,
      pipelinePackageInstalled: true,
      pipelinePackageDeclaredInManifest: false,
      selectionPackageInstalled: false,
      pipelineList: ranList(liveReachable({ isReachable: false, safeMode: false })),
      selectionPublisherRegistered: false,
      withinPairingGraceWindow: false,
    };
    expect(classifyUnitySetup(input)).toEqual({
      state: "S7b",
      message: "Waiting for Unity to respond…",
    });
  });

  it("S7b, not S7a: safeMode NULL (unresolvable) is treated the same as false, never as true", () => {
    const input: UnitySetupClassifierInput = {
      isUnityProject: true,
      cliAvailable: true,
      cliDiscoveredPath: null,
      justInstalledThisSession: false,
      lockfilePresent: true,
      pipelinePackageInstalled: true,
      pipelinePackageDeclaredInManifest: false,
      selectionPackageInstalled: false,
      pipelineList: ranList(liveReachable({ isReachable: false, safeMode: null })),
      selectionPublisherRegistered: false,
      withinPairingGraceWindow: false,
    };
    expect(classifyUnitySetup(input).state).toBe("S7b");
  });

  it("S8: installed, live, reachable, updateAvailable true AND a real latestVersion — names the version", () => {
    const input: UnitySetupClassifierInput = {
      isUnityProject: true,
      cliAvailable: true,
      cliDiscoveredPath: null,
      justInstalledThisSession: false,
      lockfilePresent: true,
      pipelinePackageInstalled: true,
      pipelinePackageDeclaredInManifest: false,
      selectionPackageInstalled: false,
      pipelineList: ranList(liveReachable({ updateAvailable: true }), "1.2.3"),
      selectionPublisherRegistered: false,
      withinPairingGraceWindow: false,
    };
    const result = classifyUnitySetup(input);
    expect(result.state).toBe("S8");
    if (result.state !== "S8") return;
    expect(result.latestVersion).toBe("1.2.3");
    expect(result.message).toContain("1.2.3");
  });

  it("S8′ fix (F10): updateAvailable true but latestVersion NULL never reports S8 — falls through instead", () => {
    const input: UnitySetupClassifierInput = {
      isUnityProject: true,
      cliAvailable: true,
      cliDiscoveredPath: null,
      justInstalledThisSession: false,
      lockfilePresent: true,
      pipelinePackageInstalled: true,
      pipelinePackageDeclaredInManifest: false,
      selectionPackageInstalled: false,
      pipelineList: ranList(liveReachable({ updateAvailable: true })),
      selectionPublisherRegistered: false,
      withinPairingGraceWindow: false,
    };
    // Falls all the way through to S9 here (selection package missing) —
    // proving it did NOT stop at a phantom S8, not merely that it isn't S8.
    expect(classifyUnitySetup(input).state).toBe("S9");
  });

  it("S8′ fix (F10): updateAvailable false with latestVersion null is NEVER read as 'up to date' — same fall-through, not S11", () => {
    const input: UnitySetupClassifierInput = {
      isUnityProject: true,
      cliAvailable: true,
      cliDiscoveredPath: null,
      justInstalledThisSession: false,
      lockfilePresent: true,
      pipelinePackageInstalled: true,
      pipelinePackageDeclaredInManifest: false,
      selectionPackageInstalled: false,
      pipelineList: ranList(liveReachable({ updateAvailable: false })),
      selectionPublisherRegistered: false,
      withinPairingGraceWindow: false,
    };
    expect(classifyUnitySetup(input).state).toBe("S9");
  });

  it("S9: everything Pipeline-related is green, but the selection package is missing", () => {
    const input: UnitySetupClassifierInput = {
      isUnityProject: true,
      cliAvailable: true,
      cliDiscoveredPath: null,
      justInstalledThisSession: false,
      lockfilePresent: true,
      pipelinePackageInstalled: true,
      pipelinePackageDeclaredInManifest: false,
      selectionPackageInstalled: false,
      pipelineList: ranList(liveReachable()),
      selectionPublisherRegistered: false,
      withinPairingGraceWindow: false,
    };
    expect(classifyUnitySetup(input)).toEqual({
      state: "S9",
      message:
        "Unity selection chips are off — this project doesn't have DevGame's selection package.",
    });
  });

  it("S10: selection package present, no publisher registered, OUTSIDE the grace window", () => {
    const input: UnitySetupClassifierInput = {
      isUnityProject: true,
      cliAvailable: true,
      cliDiscoveredPath: null,
      justInstalledThisSession: false,
      lockfilePresent: true,
      pipelinePackageInstalled: true,
      pipelinePackageDeclaredInManifest: false,
      selectionPackageInstalled: true,
      pipelineList: ranList(liveReachable()),
      selectionPublisherRegistered: false,
      withinPairingGraceWindow: false,
    };
    expect(classifyUnitySetup(input)).toEqual({
      state: "S10",
      message:
        "Unity's automatic pairing didn't complete. Click Setup Unity Integrations again to retry.",
    });
  });

  it("S10': the SAME facts as S10, but INSIDE the grace window — a 'checking', not 'pair it' yet (F3)", () => {
    const input: UnitySetupClassifierInput = {
      isUnityProject: true,
      cliAvailable: true,
      cliDiscoveredPath: null,
      justInstalledThisSession: false,
      lockfilePresent: true,
      pipelinePackageInstalled: true,
      pipelinePackageDeclaredInManifest: false,
      selectionPackageInstalled: true,
      pipelineList: ranList(liveReachable()),
      selectionPublisherRegistered: false,
      withinPairingGraceWindow: true,
    };
    expect(classifyUnitySetup(input)).toEqual({
      state: "S10'",
      message: "Checking Unity's connection…",
    });
  });

  it("S11: every check green, publisher registered — no message, controls enabled", () => {
    const input: UnitySetupClassifierInput = {
      isUnityProject: true,
      cliAvailable: true,
      cliDiscoveredPath: null,
      justInstalledThisSession: false,
      lockfilePresent: true,
      pipelinePackageInstalled: true,
      pipelinePackageDeclaredInManifest: false,
      selectionPackageInstalled: true,
      pipelineList: ranList(liveReachable()),
      selectionPublisherRegistered: true,
      withinPairingGraceWindow: false,
    };
    expect(classifyUnitySetup(input)).toEqual({ state: "S11" });
  });

  it("S11 even inside the grace window, once a publisher IS actually registered — the window only matters while absence is ambiguous", () => {
    const input: UnitySetupClassifierInput = {
      isUnityProject: true,
      cliAvailable: true,
      cliDiscoveredPath: null,
      justInstalledThisSession: false,
      lockfilePresent: true,
      pipelinePackageInstalled: true,
      pipelinePackageDeclaredInManifest: false,
      selectionPackageInstalled: true,
      pipelineList: ranList(liveReachable()),
      selectionPublisherRegistered: true,
      withinPairingGraceWindow: true,
    };
    expect(classifyUnitySetup(input).state).toBe("S11");
  });

  it("selection checks are unreachable while Pipeline itself is unhealthy — S6 wins even with selection fully ready", () => {
    // Pipeline package IS installed but Unity isn't open — S6. Selection
    // package present AND paired should not somehow surface instead: the
    // toolbar's real priority is Play/Stop readiness first.
    const input: UnitySetupClassifierInput = {
      isUnityProject: true,
      cliAvailable: true,
      cliDiscoveredPath: null,
      justInstalledThisSession: false,
      lockfilePresent: false,
      pipelinePackageInstalled: true,
      pipelinePackageDeclaredInManifest: false,
      selectionPackageInstalled: true,
      pipelineList: NOT_RUN,
      selectionPublisherRegistered: true,
      withinPairingGraceWindow: false,
    };
    expect(classifyUnitySetup(input).state).toBe("S6");
  });
});
