import type { UnitySetupFacts, UnitySetupProbeSuccess } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { EditorPresenceEntry } from "../editorPresence/protocol";
import {
  isPlayEngaged,
  isUnityPlayReady,
  resolveEngineDispatchBackend,
  resolveEngineToolbarView,
  resolveUnityPlayToggleAction,
  shouldOfferUnityPipelineInstall,
} from "./EngineToolbar.logic";

function editor(overrides: Partial<EditorPresenceEntry> = {}): EditorPresenceEntry {
  return {
    editor: { id: "godot-1", name: "Godot", version: "4.7.1" },
    session: { id: "session-1" },
    workspace: { root: "/repo" },
    connected: true,
    lastSeenAt: "2026-08-03T00:00:00.000Z",
    selection: null,
    capabilities: [],
    playState: null,
    ...overrides,
  };
}

// `isUnityPlayReady`/`resolveEngineToolbarView`'s unity-cli tests below use
// ONE full explicit `UnitySetupFacts` object per test case, same discipline
// as `UnitySetupClassifier.test.ts` (server-side): a shared base fixture is
// exactly how a branch that flips readiness silently stops being covered.
// `readyFacts` and `readyProbeResult` below are convenience CONSTRUCTORS for
// that explicit object, not a shared instance reused across tests.
function readyFacts(overrides: Partial<UnitySetupFacts> = {}): UnitySetupFacts {
  return {
    // Play-readiness is independent of this field (see
    // EngineToolbar.logic.ts's isUnityPlayReady doc comment) — true here
    // simply because these fixtures otherwise describe an actual Unity
    // project.
    isUnityProject: true,
    cliAvailable: true,
    cliDiscoveredPath: null,
    lockfilePresent: true,
    pipelinePackage: { installed: true, resolvedVersion: "0.4.0-exp.1", declaredInManifest: true },
    selectionPackage: { installed: false, resolvedVersion: null, declaredInManifest: false },
    pipelineList: {
      _tag: "ran",
      matched: {
        projectPath: "/repo",
        pid: 111,
        isRunning: true,
        hasPipelinePackage: true,
        isReachable: true,
        pipelineVersion: "0.4.0-exp.1",
        updateAvailable: false,
        safeMode: false,
      },
      latestVersion: null,
      unparseableInstanceCount: 0,
    },
    selectionPublisherRegistered: false,
    withinPairingGraceWindow: false,
    ...overrides,
  };
}

/** `readyFacts()` minus the `pipelineList` key entirely — represents
 * "hasn't run this cycle" (S4′'s window). `exactOptionalPropertyTypes`
 * rejects `pipelineList: undefined` as an override value for an optional
 * key (the key must be OMITTED, not set to `undefined`), so this
 * constructs the omission directly rather than trying to override it away. */
function factsWithNoListRun(
  overrides: Partial<Omit<UnitySetupFacts, "pipelineList">> = {},
): UnitySetupFacts {
  const { pipelineList: _pipelineList, ...base } = readyFacts();
  return { ...base, ...overrides };
}

/** Wraps `readyFacts` (or an explicit override) with a `primary` — the
 * `state`/`message` combination is only load-bearing for the tests that
 * check `disabledReason`; tests only asserting `availableActions`/readiness
 * can pass a placeholder that doesn't need to agree with the facts (the two
 * are deliberately independently computed — see `isUnityPlayReady`'s doc
 * comment — so a test proving readiness never depends on `primary` at all). */
function probeResult(
  facts: UnitySetupFacts,
  primary: UnitySetupProbeSuccess["primary"],
): UnitySetupProbeSuccess {
  return { facts, primary };
}

const S11: UnitySetupProbeSuccess["primary"] = { state: "S11" };

describe("resolveEngineDispatchBackend", () => {
  it("routes Godot and Unreal to editor-presence", () => {
    expect(resolveEngineDispatchBackend("godot")).toBe("editor-presence");
    expect(resolveEngineDispatchBackend("unreal")).toBe("editor-presence");
  });
  it("routes Unity to the CLI backend, not editor-presence", () => {
    expect(resolveEngineDispatchBackend("unity")).toBe("unity-cli");
  });
  it("routes three.js to the script backend", () => {
    expect(resolveEngineDispatchBackend("threejs")).toBe("threejs-script");
  });
});

describe("resolveEngineToolbarView — no engine known", () => {
  it("renders no backend and no controls when the project has no engine at all", () => {
    const view = resolveEngineToolbarView({ engineType: null, connectedEditor: null });
    expect(view.backend).toBeNull();
    expect(view.requiresPresenceCommandScope).toBe(false);
    expect(view.availableActions).toEqual([]);
  });
});

describe("resolveEngineToolbarView — threejs-script backend", () => {
  it("needs no presence scope and has no control cluster, regardless of a connected editor", () => {
    const view = resolveEngineToolbarView({
      engineType: "threejs",
      connectedEditor: editor({ capabilities: ["play", "stop"] }),
    });
    expect(view.backend).toBe("threejs-script");
    expect(view.requiresPresenceCommandScope).toBe(false);
    expect(view.hasConnectedEditor).toBe(false);
    expect(view.availableActions).toEqual([]);
  });
});

describe("resolveEngineToolbarView — unity-cli backend", () => {
  it("needs presence:command too — same risk class as editor-presence (may make the editor execute code), different transport", () => {
    const view = resolveEngineToolbarView({ engineType: "unity", connectedEditor: null });
    expect(view.backend).toBe("unity-cli");
    expect(view.requiresPresenceCommandScope).toBe(true);
  });

  it("no unitySetup supplied yet: disabled, not enabled — #92's actual fix. The old default was UNITY_CLI_ACTIONS unconditionally; the only way a user learned Unity was unreachable was clicking Play and getting a generic toast", () => {
    const view = resolveEngineToolbarView({ engineType: "unity", connectedEditor: null });
    expect(view.availableActions).toEqual([]);
    expect(view.disabledReason).toBe("Checking Unity's status…");
  });

  it("unitySetup explicitly null, no error known: same disabled treatment as not-yet-fetched, never a guessed-enabled default", () => {
    const view = resolveEngineToolbarView({
      engineType: "unity",
      connectedEditor: null,
      unitySetup: null,
    });
    expect(view.availableActions).toEqual([]);
    expect(view.disabledReason).toBe("Checking Unity's status…");
  });

  it("unitySetup null AND unitySetupError set: shows the real failure, not an indefinite 'Checking…' — found live 2026-08-04, a rejected fetch used to leave this stuck forever", () => {
    const view = resolveEngineToolbarView({
      engineType: "unity",
      connectedEditor: null,
      unitySetup: null,
      unitySetupError: "Request timed out",
    });
    expect(view.availableActions).toEqual([]);
    expect(view.disabledReason).toBe("Couldn't check Unity's status — Request timed out");
  });

  it("unitySetupError is ignored once unitySetup itself resolves — a stale error from an earlier failed attempt never survives a later success", () => {
    const view = resolveEngineToolbarView({
      engineType: "unity",
      connectedEditor: null,
      unitySetup: probeResult(readyFacts(), S11),
      unitySetupError: "stale error from a previous attempt",
    });
    expect(view.disabledReason).toBeNull();
  });

  describe("unitySetupCheckFailed — #106's retry affordance gate", () => {
    it("false while still loading (no unitySetup, no error yet) — a failed CHECK is a different thing from a check in flight", () => {
      const view = resolveEngineToolbarView({
        engineType: "unity",
        connectedEditor: null,
        unitySetup: null,
      });
      expect(view.unitySetupCheckFailed).toBe(false);
    });

    it("true when the check itself failed (no unitySetup, a real error) — this is what unlocks the toolbar's Retry control", () => {
      const view = resolveEngineToolbarView({
        engineType: "unity",
        connectedEditor: null,
        unitySetup: null,
        unitySetupError: "Request timed out",
      });
      expect(view.unitySetupCheckFailed).toBe(true);
    });

    it("false once a real classified state has arrived, even one that keeps Play disabled (S4, Pipeline package missing) — retrying a confirmed 'not set up yet' answer wouldn't change it", () => {
      const view = resolveEngineToolbarView({
        engineType: "unity",
        connectedEditor: null,
        unitySetup: probeResult(
          readyFacts({
            pipelinePackage: { installed: false, resolvedVersion: null, declaredInManifest: false },
          }),
          {
            state: "S4",
            message:
              "Unity is open, but this project doesn't have Unity's Pipeline package — that's why Play doesn't work here. DevGame can add it to this project.",
          },
        ),
      });
      expect(view.disabledReason).not.toBeNull();
      expect(view.unitySetupCheckFailed).toBe(false);
    });

    it("false once a real classified state has arrived, even with a STALE error still hanging around from an earlier failed attempt", () => {
      const view = resolveEngineToolbarView({
        engineType: "unity",
        connectedEditor: null,
        unitySetup: probeResult(readyFacts(), S11),
        unitySetupError: "stale error from a previous attempt",
      });
      expect(view.unitySetupCheckFailed).toBe(false);
    });

    it("false when Play is fully ready (S11)", () => {
      const view = resolveEngineToolbarView({
        engineType: "unity",
        connectedEditor: null,
        unitySetup: probeResult(readyFacts(), S11),
      });
      expect(view.unitySetupCheckFailed).toBe(false);
    });

    it("always false for non-unity-cli backends — editor-presence has no probe to fail", () => {
      const view = resolveEngineToolbarView({
        engineType: "godot",
        connectedEditor: null,
      });
      expect(view.unitySetupCheckFailed).toBe(false);
    });

    it("always false when no engine is resolved at all", () => {
      const view = resolveEngineToolbarView({ engineType: null, connectedEditor: null });
      expect(view.unitySetupCheckFailed).toBe(false);
    });
  });

  // Task: F13 (merge-gate review, low) — `unitySetupPending` threads
  // `unitySetupQuery.isPending` straight through with no re-derivation
  // (this function only ever sees SETTLED inputs, so it has no other way
  // to know a fetch is in flight). One explicit case per posture, same
  // discipline the rest of this suite uses.
  describe("unitySetupPending — F13's threaded-through 'still checking' signal", () => {
    it("true when the caller says a fetch is in flight", () => {
      const view = resolveEngineToolbarView({
        engineType: "unity",
        connectedEditor: null,
        unitySetupPending: true,
      });
      expect(view.unitySetupPending).toBe(true);
    });

    it("false when the caller says nothing is in flight", () => {
      const view = resolveEngineToolbarView({
        engineType: "unity",
        connectedEditor: null,
        unitySetupPending: false,
      });
      expect(view.unitySetupPending).toBe(false);
    });

    it("defaults to false when the caller omits it entirely — never a guessed-pending default", () => {
      const view = resolveEngineToolbarView({ engineType: "unity", connectedEditor: null });
      expect(view.unitySetupPending).toBe(false);
    });

    it("stays true even once a classified result has ALSO arrived — a refresh can be in flight over already-resolved data (e.g. Retry, or the post-install refresh)", () => {
      const view = resolveEngineToolbarView({
        engineType: "unity",
        connectedEditor: null,
        unitySetup: probeResult(readyFacts(), S11),
        unitySetupPending: true,
      });
      expect(view.unitySetupPending).toBe(true);
    });

    it("always false for non-unity-cli backends, even if a caller passes true — editor-presence has no probe to be pending on", () => {
      const view = resolveEngineToolbarView({
        engineType: "godot",
        connectedEditor: null,
        unitySetupPending: true,
      });
      expect(view.unitySetupPending).toBe(false);
    });

    it("always false when no engine is resolved at all, even if a caller passes true", () => {
      const view = resolveEngineToolbarView({
        engineType: null,
        connectedEditor: null,
        unitySetupPending: true,
      });
      expect(view.unitySetupPending).toBe(false);
    });
  });

  it("facts fully ready: play/pause/stop enabled, no disabledReason — no step, Pipeline has no scriptable frame step", () => {
    const view = resolveEngineToolbarView({
      engineType: "unity",
      connectedEditor: null,
      unitySetup: probeResult(readyFacts(), S11),
    });
    expect(view.availableActions).toEqual(["play", "pause", "stop"]);
    expect(view.disabledReason).toBeNull();
  });

  it("ready EVEN WHEN primary is S9 (selection package missing) — the defect team-lead's ruling exists to prevent: readiness must come from the Pipeline facts, never from primary.state's position in the taxonomy", () => {
    const view = resolveEngineToolbarView({
      engineType: "unity",
      connectedEditor: null,
      unitySetup: probeResult(readyFacts(), {
        state: "S9",
        message:
          "Unity selection chips are off — this project doesn't have DevGame's selection package.",
      }),
    });
    expect(view.availableActions).toEqual(["play", "pause", "stop"]);
    expect(view.disabledReason).toBeNull();
  });

  it("cliAvailable false: disabled, shows primary's S1 message verbatim", () => {
    const view = resolveEngineToolbarView({
      engineType: "unity",
      connectedEditor: null,
      unitySetup: probeResult(readyFacts({ cliAvailable: false }), {
        state: "S1",
        message:
          "Unity's command-line tool isn't installed on this machine. DevGame needs it to talk to the Editor.",
      }),
    });
    expect(view.availableActions).toEqual([]);
    expect(view.disabledReason).toBe(
      "Unity's command-line tool isn't installed on this machine. DevGame needs it to talk to the Editor.",
    );
  });

  it("Pipeline package not installed: disabled, shows primary's S4 message verbatim — the owner's exact scenario", () => {
    const view = resolveEngineToolbarView({
      engineType: "unity",
      connectedEditor: null,
      unitySetup: probeResult(
        readyFacts({
          pipelinePackage: { installed: false, resolvedVersion: null, declaredInManifest: false },
        }),
        {
          state: "S4",
          message:
            "Unity is open, but this project doesn't have Unity's Pipeline package — that's why Play doesn't work here. DevGame can add it to this project.",
        },
      ),
    });
    expect(view.availableActions).toEqual([]);
    expect(view.disabledReason).toContain("doesn't have Unity's Pipeline package");
  });

  it("non-Unity S0: withholds the install CTA and surfaces the classifier message as the exact disabled reason", () => {
    const message =
      "This project doesn't look like a Unity project — no ProjectSettings/ProjectVersion.txt was found.";
    const view = resolveEngineToolbarView({
      engineType: "unity",
      connectedEditor: null,
      unitySetup: probeResult(
        readyFacts({
          isUnityProject: false,
          pipelinePackage: { installed: false, resolvedVersion: null, declaredInManifest: false },
          pipelineList: {
            _tag: "ran",
            matched: null,
            latestVersion: null,
            unparseableInstanceCount: 0,
          },
        }),
        { state: "S0", message },
      ),
    });

    expect(view.availableActions).toEqual([]);
    expect(view.unityInstallOffered).toBe(false);
    expect(view.disabledReason).toBe(message);
  });

  it("pipelineList never ran (S4' checking window): disabled, not a guessed-enabled state", () => {
    const view = resolveEngineToolbarView({
      engineType: "unity",
      connectedEditor: null,
      unitySetup: probeResult(factsWithNoListRun(), {
        state: "S4'",
        message: "Checking Unity's status…",
      }),
    });
    expect(view.availableActions).toEqual([]);
  });

  it("matched instance found but NOT running (stale lock, F13): disabled — a match alone is not liveness", () => {
    const view = resolveEngineToolbarView({
      engineType: "unity",
      connectedEditor: null,
      unitySetup: probeResult(
        readyFacts({
          pipelineList: {
            _tag: "ran",
            matched: {
              projectPath: "/repo",
              pid: null,
              isRunning: false,
              hasPipelinePackage: true,
              isReachable: false,
              pipelineVersion: "0.4.0-exp.1",
              updateAvailable: false,
              safeMode: null,
            },
            latestVersion: null,
            unparseableInstanceCount: 0,
          },
        }),
        {
          state: "S6",
          message:
            "Unity isn't open for this project. Open it in the Unity Editor, then try again.",
        },
      ),
    });
    expect(view.availableActions).toEqual([]);
  });

  it("matched instance running but NOT reachable (mid domain-reload / Safe Mode): disabled", () => {
    const view = resolveEngineToolbarView({
      engineType: "unity",
      connectedEditor: null,
      unitySetup: probeResult(
        readyFacts({
          pipelineList: {
            _tag: "ran",
            matched: {
              projectPath: "/repo",
              pid: 111,
              isRunning: true,
              hasPipelinePackage: true,
              isReachable: false,
              pipelineVersion: "0.4.0-exp.1",
              updateAvailable: false,
              safeMode: null,
            },
            latestVersion: null,
            unparseableInstanceCount: 0,
          },
        }),
        { state: "S7b", message: "Waiting for Unity to respond…" },
      ),
    });
    expect(view.availableActions).toEqual([]);
  });

  it("pipeline list failed (S12): disabled, shows the CLI's own message verbatim, unedited", () => {
    const view = resolveEngineToolbarView({
      engineType: "unity",
      connectedEditor: null,
      unitySetup: probeResult(
        readyFacts({ pipelineList: { _tag: "cliError", message: "boom, exact CLI wording" } }),
        {
          state: "S12",
          message: "boom, exact CLI wording",
          command: "unity pipeline list --json",
        },
      ),
    });
    expect(view.availableActions).toEqual([]);
    expect(view.disabledReason).toBe("boom, exact CLI wording");
  });

  it("ignores any connectedEditor passed in — Unity never appears in the presence feed", () => {
    const view = resolveEngineToolbarView({
      engineType: "unity",
      connectedEditor: editor({ editor: { id: "unity-1", name: "Unity", version: "6000.3" } }),
      unitySetup: probeResult(readyFacts(), S11),
    });
    expect(view.hasConnectedEditor).toBe(false);
    expect(view.availableActions).toEqual(["play", "pause", "stop"]);
  });

  it("defaults playState to null when no status has been supplied", () => {
    const view = resolveEngineToolbarView({ engineType: "unity", connectedEditor: null });
    expect(view.playState).toBeNull();
  });

  it("passes an explicitly supplied unityPlayState through, independent of readiness", () => {
    const view = resolveEngineToolbarView({
      engineType: "unity",
      connectedEditor: null,
      unityPlayState: "playing",
    });
    expect(view.playState).toBe("playing");
  });

  describe("unityInstallOffered — the Setup CTA's own gate, wired end-to-end through resolveEngineToolbarView (not just shouldOfferUnityPipelineInstall in isolation)", () => {
    it("true when the resolved view is not-ready for exactly the package-missing reason", () => {
      const view = resolveEngineToolbarView({
        engineType: "unity",
        connectedEditor: null,
        unitySetup: probeResult(
          readyFacts({
            pipelinePackage: { installed: false, resolvedVersion: null, declaredInManifest: false },
          }),
          { state: "S4", message: "placeholder" },
        ),
      });
      expect(view.availableActions).toEqual([]);
      expect(view.unityInstallOffered).toBe(true);
    });

    it("false while still loading — no probe result yet is never a default-to-offered guess, same posture unitySetupCheckFailed's own suite proves for the retry control", () => {
      const view = resolveEngineToolbarView({ engineType: "unity", connectedEditor: null });
      expect(view.unityInstallOffered).toBe(false);
    });

    it("false once FULLY ready (selection installed too) — nothing left to install and nothing to offer installing", () => {
      const view = resolveEngineToolbarView({
        engineType: "unity",
        connectedEditor: null,
        // #129: the default fixture's selection package is MISSING, which
        // is now itself an installation opportunity (the click installs
        // both packages) — pin it installed so this case isolates "truly
        // nothing left".
        unitySetup: probeResult(
          readyFacts({
            selectionPackage: {
              installed: true,
              resolvedVersion: "0.1.0",
              declaredInManifest: false,
            },
            selectionPublisherRegistered: true,
          }),
          S11,
        ),
      });
      expect(view.availableActions).toEqual(["play", "pause", "stop"]);
      expect(view.unityInstallOffered).toBe(false);
    });

    it("S9 (#129): STILL offered while play-ready when only the selection package is missing — Play works, chips are off, and the click fixes it", () => {
      const view = resolveEngineToolbarView({
        engineType: "unity",
        connectedEditor: null,
        // readyFacts() default: pipeline installed, selection missing.
        unitySetup: probeResult(readyFacts(), S11),
      });
      // Ready AND offered — the two are no longer mutually exclusive.
      expect(view.availableActions).toEqual(["play", "pause", "stop"]);
      expect(view.unityInstallOffered).toBe(true);
    });

    it("true for S5 (Unity not open, package missing) — corrected from this suite's own earlier version: install needs no live Editor, so S5 is offered identically to S4", () => {
      const view = resolveEngineToolbarView({
        engineType: "unity",
        connectedEditor: null,
        unitySetup: probeResult(
          readyFacts({
            pipelinePackage: { installed: false, resolvedVersion: null, declaredInManifest: false },
            pipelineList: {
              _tag: "ran",
              matched: null,
              latestVersion: null,
              unparseableInstanceCount: 0,
            },
          }),
          { state: "S5", message: "placeholder" },
        ),
      });
      expect(view.availableActions).toEqual([]);
      expect(view.unityInstallOffered).toBe(true);
    });
  });
});

describe("isUnityPlayReady — mutation-proof per fact, one explicit object per case", () => {
  it("ready: every fact green", () => {
    expect(isUnityPlayReady(readyFacts())).toBe(true);
  });

  it("NOT ready: cliAvailable false", () => {
    expect(isUnityPlayReady(readyFacts({ cliAvailable: false }))).toBe(false);
  });

  it("NOT ready: pipelinePackage not installed", () => {
    expect(
      isUnityPlayReady(
        readyFacts({
          pipelinePackage: { installed: false, resolvedVersion: null, declaredInManifest: false },
        }),
      ),
    ).toBe(false);
  });

  it("NOT ready: pipelineList absent (never ran this cycle)", () => {
    expect(isUnityPlayReady(factsWithNoListRun())).toBe(false);
  });

  it("NOT ready: pipelineList is a cliError, not a ran outcome", () => {
    expect(
      isUnityPlayReady(readyFacts({ pipelineList: { _tag: "cliError", message: "boom" } })),
    ).toBe(false);
  });

  it("NOT ready: pipelineList ran but matched is null (no live instance for this project)", () => {
    expect(
      isUnityPlayReady(
        readyFacts({
          pipelineList: {
            _tag: "ran",
            matched: null,
            latestVersion: null,
            unparseableInstanceCount: 0,
          },
        }),
      ),
    ).toBe(false);
  });

  it("NOT ready: matched instance found but isRunning false — F13's stale-lock case", () => {
    expect(
      isUnityPlayReady(
        readyFacts({
          pipelineList: {
            _tag: "ran",
            matched: {
              projectPath: "/repo",
              pid: null,
              isRunning: false,
              hasPipelinePackage: true,
              isReachable: true,
              pipelineVersion: "0.4.0-exp.1",
              updateAvailable: false,
              safeMode: null,
            },
            latestVersion: null,
            unparseableInstanceCount: 0,
          },
        }),
      ),
    ).toBe(false);
  });

  it("NOT ready: matched instance isRunning true but isReachable false — domain reload / Safe Mode", () => {
    expect(
      isUnityPlayReady(
        readyFacts({
          pipelineList: {
            _tag: "ran",
            matched: {
              projectPath: "/repo",
              pid: 111,
              isRunning: true,
              hasPipelinePackage: true,
              isReachable: false,
              pipelineVersion: "0.4.0-exp.1",
              updateAvailable: false,
              safeMode: null,
            },
            latestVersion: null,
            unparseableInstanceCount: 0,
          },
        }),
      ),
    ).toBe(false);
  });

  it("ready even though selectionPackage is NOT installed — Play readiness must be independent of the selection feature entirely", () => {
    expect(
      isUnityPlayReady(
        readyFacts({
          selectionPackage: { installed: false, resolvedVersion: null, declaredInManifest: false },
        }),
      ),
    ).toBe(true);
  });

  it("ready even though selectionPublisherRegistered is false and withinPairingGraceWindow is true — same independence, S9/S10/S10' territory", () => {
    expect(
      isUnityPlayReady(
        readyFacts({ selectionPublisherRegistered: false, withinPairingGraceWindow: true }),
      ),
    ).toBe(true);
  });

  it("ready regardless of cliDiscoveredPath or lockfilePresent — neither is part of the readiness contract", () => {
    expect(
      isUnityPlayReady(
        readyFacts({ cliDiscoveredPath: "/opt/homebrew/bin/unity", lockfilePresent: false }),
      ),
    ).toBe(true);
  });
});

// Task: the "Setup Unity Integrations" CTA performs the install directly
// (owner ruling, mid-build revision) — this is what gates whether it's even
// offered. One full explicit `UnitySetupFacts` object per case, same
// discipline `isUnityPlayReady`'s own suite above uses — `readyFacts()` is
// ALREADY "package installed, CLI available, Unity open+reachable"; each
// case below overrides exactly the ONE thing that state is supposed to
// change, so a case that silently stops testing what its name says would
// show up as an unrelated field drifting instead of disappearing quietly.
// Corrected from this suite's own earlier version, which required Unity to
// be open+reachable (i.e. read `pipelineList`) before offering the install.
// Team-lead's ruling: the install itself needs nothing but a working CLI —
// it writes the manifest line and succeeds with no Editor running at all
// (`postPipelineInstall.ts`'s own doc comment is the proof) — so liveness
// has NO bearing on whether this gate should be `true`. Every case below
// that varies `pipelineList` while holding `pipelinePackage.installed:
// false` is here to prove exactly that: the answer doesn't move.
describe("shouldOfferUnityPipelineInstall — offered for missing packages without liveness, or live pairing recovery", () => {
  it("offers the install when the ONLY problem is a missing Pipeline package (S4: Unity open and reachable)", () => {
    expect(
      shouldOfferUnityPipelineInstall(
        readyFacts({
          pipelinePackage: { installed: false, resolvedVersion: null, declaredInManifest: false },
        }),
      ),
    ).toBe(true);
  });

  it("offers even when Unity isn't open for this project (S5) — install works with no Editor running; S4 and S5 are identical to this function", () => {
    expect(
      shouldOfferUnityPipelineInstall(
        readyFacts({
          pipelinePackage: { installed: false, resolvedVersion: null, declaredInManifest: false },
          pipelineList: {
            _tag: "ran",
            matched: null,
            latestVersion: null,
            unparseableInstanceCount: 0,
          },
        }),
      ),
    ).toBe(true);
  });

  it("offers even when the matched instance isn't actually running (a stale lock, F13's exact scenario) — liveness of a matched instance is not part of this gate", () => {
    expect(
      shouldOfferUnityPipelineInstall(
        readyFacts({
          pipelinePackage: { installed: false, resolvedVersion: null, declaredInManifest: false },
          pipelineList: {
            _tag: "ran",
            matched: {
              projectPath: "/repo",
              pid: null,
              isRunning: false,
              hasPipelinePackage: false,
              isReachable: false,
              pipelineVersion: null,
              updateAvailable: null,
              safeMode: null,
            },
            latestVersion: null,
            unparseableInstanceCount: 0,
          },
        }),
      ),
    ).toBe(true);
  });

  it("offers even in Safe Mode — Unity running but not reachable, same reasoning: reachability was never part of the install's own requirements", () => {
    expect(
      shouldOfferUnityPipelineInstall(
        readyFacts({
          pipelinePackage: { installed: false, resolvedVersion: null, declaredInManifest: false },
          pipelineList: {
            _tag: "ran",
            matched: {
              projectPath: "/repo",
              pid: 111,
              isRunning: true,
              hasPipelinePackage: false,
              isReachable: false,
              pipelineVersion: null,
              updateAvailable: null,
              safeMode: true,
            },
            latestVersion: null,
            unparseableInstanceCount: 0,
          },
        }),
      ),
    ).toBe(true);
  });

  it("offers even when pipeline list hasn't run this cycle (S4' liveness-uncertain window) — the function never reads pipelineList at all, so an absent one changes nothing", () => {
    expect(
      shouldOfferUnityPipelineInstall(
        factsWithNoListRun({
          pipelinePackage: { installed: false, resolvedVersion: null, declaredInManifest: false },
        }),
      ),
    ).toBe(true);
  });
});

describe("shouldOfferUnityPipelineInstall — withheld (only for reasons an install genuinely can't fix)", () => {
  it("withholds at S11 when both packages are installed and selection is already paired", () => {
    expect(
      shouldOfferUnityPipelineInstall(
        readyFacts({
          selectionPackage: {
            installed: true,
            resolvedVersion: "0.1.0",
            declaredInManifest: false,
          },
          selectionPublisherRegistered: true,
        }),
      ),
    ).toBe(false);
  });

  it("offers at S9 (#129): pipeline installed but the selection package missing — the click installs it", () => {
    // readyFacts() default IS S9's package state (selection missing).
    expect(shouldOfferUnityPipelineInstall(readyFacts())).toBe(true);
  });

  it("withholds at S10 when both packages are installed, Unity is closed, and pairing status is unknowable", () => {
    expect(
      shouldOfferUnityPipelineInstall(
        readyFacts({
          selectionPackage: {
            installed: true,
            resolvedVersion: "0.1.0",
            declaredInManifest: false,
          },
          selectionPublisherRegistered: false,
          pipelineList: {
            _tag: "ran",
            matched: null,
            latestVersion: null,
            unparseableInstanceCount: 0,
          },
        }),
      ),
    ).toBe(false);
  });

  it("offers at S10 when both packages are installed and the live Editor is genuinely unpaired", () => {
    expect(
      shouldOfferUnityPipelineInstall(
        readyFacts({
          selectionPackage: {
            installed: true,
            resolvedVersion: "0.1.0",
            declaredInManifest: false,
          },
          selectionPublisherRegistered: false,
        }),
      ),
    ).toBe(true);
  });

  it("withholds when the CLI isn't available — install can't run at all", () => {
    expect(
      shouldOfferUnityPipelineInstall(
        readyFacts({
          cliAvailable: false,
          pipelinePackage: { installed: false, resolvedVersion: null, declaredInManifest: false },
        }),
      ),
    ).toBe(false);
  });

  it("withholds when the pipeline package is declared in the manifest (S13) AND selection is installed — re-installing has nothing left to do", () => {
    expect(
      shouldOfferUnityPipelineInstall(
        readyFacts({
          pipelinePackage: { installed: false, resolvedVersion: null, declaredInManifest: true },
          selectionPackage: {
            installed: true,
            resolvedVersion: "0.1.0",
            declaredInManifest: false,
          },
          selectionPublisherRegistered: true,
        }),
      ),
    ).toBe(false);
  });
});

describe("resolveEngineToolbarView — editor-presence backend (Godot today)", () => {
  it("requires the presence scope with nothing connected", () => {
    const view = resolveEngineToolbarView({ engineType: "godot", connectedEditor: null });
    expect(view.backend).toBe("editor-presence");
    expect(view.requiresPresenceCommandScope).toBe(true);
  });

  it("requires the presence scope even once an editor is connected", () => {
    const view = resolveEngineToolbarView({
      engineType: "godot",
      connectedEditor: editor({ capabilities: ["play"] }),
    });
    expect(view.requiresPresenceCommandScope).toBe(true);
  });

  it("reports no connected editor and an empty action list when nothing is connected", () => {
    const view = resolveEngineToolbarView({ engineType: "godot", connectedEditor: null });
    expect(view.hasConnectedEditor).toBe(false);
    expect(view.availableActions).toEqual([]);
    expect(view.playState).toBeNull();
  });

  it("shows only what the connected editor actually advertised, e.g. Godot's real play+stop", () => {
    const view = resolveEngineToolbarView({
      engineType: "godot",
      connectedEditor: editor({ capabilities: ["play", "stop"] }),
    });
    expect(view.hasConnectedEditor).toBe(true);
    expect(view.availableActions).toEqual(["play", "stop"]);
  });

  it("shows a full set in the fixed Play/Pause/Stop/Step order regardless of wire order", () => {
    const view = resolveEngineToolbarView({
      engineType: "godot",
      connectedEditor: editor({ capabilities: ["step", "stop", "play", "pause"] }),
    });
    expect(view.availableActions).toEqual(["play", "pause", "stop", "step"]);
  });

  it("never fabricates an action the editor did not advertise", () => {
    const view = resolveEngineToolbarView({
      engineType: "godot",
      connectedEditor: editor({ capabilities: ["play"] }),
    });
    expect(view.availableActions).toEqual(["play"]);
  });

  it("passes the connected editor's playState through untouched", () => {
    const view = resolveEngineToolbarView({
      engineType: "godot",
      connectedEditor: editor({ capabilities: ["play"], playState: "playing" }),
    });
    expect(view.playState).toBe("playing");
  });
});

// Task: Unity's ready-state Play/Pause toggle collapses into ONE button —
// owner ruling, 2026-08-05. Every `EditorPresencePlayState` value gets its
// own case, same one-explicit-case-per-value discipline the rest of this
// file uses, so a state that silently stops mapping correctly shows up as
// a specific failing case rather than an unrelated one drifting quietly.
describe("resolveUnityPlayToggleAction", () => {
  it('returns "pause" while playing — clicking the toggle should pause a running session', () => {
    expect(resolveUnityPlayToggleAction("playing")).toBe("pause");
  });

  it('returns "play" while stopped — clicking the toggle should start a stopped session', () => {
    expect(resolveUnityPlayToggleAction("stopped")).toBe("play");
  });

  it('returns "play" while paused — resuming from paused is the SAME wire action as starting from stopped (no separate "resume" verb), so paused shares stopped\'s face rather than getting its own', () => {
    expect(resolveUnityPlayToggleAction("paused")).toBe("play");
  });

  it('returns "play" when playState is null (no status read yet) — unknown must never claim a playing session exists', () => {
    expect(resolveUnityPlayToggleAction(null)).toBe("play");
  });
});

describe("isPlayEngaged", () => {
  it("is engaged while playing", () => {
    expect(isPlayEngaged("playing")).toBe(true);
  });
  it("is engaged while paused", () => {
    expect(isPlayEngaged("paused")).toBe(true);
  });
  it("is not engaged while stopped", () => {
    expect(isPlayEngaged("stopped")).toBe(false);
  });
  it("is not engaged when unknown", () => {
    expect(isPlayEngaged(null)).toBe(false);
  });
});
