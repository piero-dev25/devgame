import type { UnitySetupFacts, UnitySetupProbeResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { EditorPresenceEntry } from "../editorPresence/protocol";
import {
  isPlayEngaged,
  isUnityPlayReady,
  resolveEngineDispatchBackend,
  resolveEngineToolbarView,
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
    cliAvailable: true,
    cliDiscoveredPath: null,
    lockfilePresent: true,
    pipelinePackage: { installed: true, resolvedVersion: "0.4.0-exp.1" },
    selectionPackage: { installed: false, resolvedVersion: null },
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
    },
    selectionPublisherRegistered: false,
    withinPairingGraceWindow: false,
    ...overrides,
  };
}

/** Wraps `readyFacts` (or an explicit override) with a `primary` — the
 * `state`/`message` combination is only load-bearing for the tests that
 * check `disabledReason`; tests only asserting `availableActions`/readiness
 * can pass a placeholder that doesn't need to agree with the facts (the two
 * are deliberately independently computed — see `isUnityPlayReady`'s doc
 * comment — so a test proving readiness never depends on `primary` at all). */
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

function probeResult(
  facts: UnitySetupFacts,
  primary: UnitySetupProbeResult["primary"],
): UnitySetupProbeResult {
  return { facts, primary };
}

const S11: UnitySetupProbeResult["primary"] = { state: "S11" };

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

  it("unitySetup explicitly null (fetch failed): same disabled treatment as not-yet-fetched, never a guessed-enabled default", () => {
    const view = resolveEngineToolbarView({
      engineType: "unity",
      connectedEditor: null,
      unitySetup: null,
    });
    expect(view.availableActions).toEqual([]);
    expect(view.disabledReason).toBe("Checking Unity's status…");
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
        readyFacts({ pipelinePackage: { installed: false, resolvedVersion: null } }),
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
        readyFacts({ pipelinePackage: { installed: false, resolvedVersion: null } }),
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
        readyFacts({ pipelineList: { _tag: "ran", matched: null, latestVersion: null } }),
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
          },
        }),
      ),
    ).toBe(false);
  });

  it("ready even though selectionPackage is NOT installed — Play readiness must be independent of the selection feature entirely", () => {
    expect(
      isUnityPlayReady(
        readyFacts({ selectionPackage: { installed: false, resolvedVersion: null } }),
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
