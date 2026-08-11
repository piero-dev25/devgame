// Proves the #106 fix at the level that actually changed: the ATOM, not a
// mounted component. `useEnvironmentQuery` (state/query.ts), the React
// consumption layer both call sites use, is pre-existing, already-trusted
// infrastructure (already used elsewhere in ChatView.tsx for
// `activeEnvironmentShell`/`gitStatusQuery`) — every line of NEW logic this
// fix introduces lives in `createUnitySetupProbeAtom`, and that is exactly
// what this file drives, the same way `desktopNetworkAccess.test.ts` drives
// `createDesktopNetworkAccessStateAtom` without mounting any component or
// DOM. `apps/web` ships zero jsdom/testing-library infrastructure today
// (confirmed: `TerminalDockPanel.test.tsx`'s own doc comment) — a real
// DOM-mounted test of `ChatView.tsx` or `ConnectionsSettings.tsx` was ruled
// out as disproportionate to this fix (6260 and 2600+ lines respectively,
// dozens of unrelated hooks each) and out of scope for a surgical Phase 0
// fix; flagged to team-lead rather than silently skipped.
//
// The first case below is not incidental — it is the exact shape team-lead
// specified as the proof bar: "mount with the connection atom at
// `Option.none()`, transition it to `Some`, and assert the probe fires and
// the UI leaves the Checking state." Confirmed empirically (not assumed)
// that this test is discriminating, not vacuous: temporarily replacing the
// implementation's `get.some(...)` wait with a `get.once(...)` snapshot +
// manual `Option.isNone` check — i.e., literally `readPreparedConnection`'s
// own mechanism (`Option.getOrNull(appAtomRegistry.get(atom))`,
// `state/session.ts:24-28`), reproduced inside the atom instead of a
// `useEffect` — makes exactly this first test fail red (the `vi.waitFor`
// for `AsyncResult.isSuccess` times out, because a `get.once` snapshot
// never re-observes `source` changing to `Some` after the fact — the same
// "nothing in the dependency array ever changes again" defect #106 traced
// to `readPreparedConnection`). Reverted after confirming; `get.some`
// restores both tests to green. The second test (timeout) is intentionally
// NOT discriminating on its own — asserting a stated failure exists proves
// nothing about reactivity, which is exactly why team-lead's note calls out
// that "asserting `readPreparedConnection` was called proves nothing." Only
// the first test's None→Some transition does that job.
import { EnvironmentId, ProjectId, type UnitySetupProbeSuccess } from "@t3tools/contracts";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createUnitySetupProbeAtom,
  UnitySetupConnectionWaitTimeoutError,
} from "./unitySetupProbeAtom";

const environmentId = EnvironmentId.make("env-1");
const projectId = ProjectId.make("project-1");
const projectRef = { environmentId, projectId };

const preparedConnection: PreparedConnection = {
  environmentId,
  label: "Test environment",
  httpBaseUrl: "http://localhost:9999",
  socketUrl: "ws://localhost:9999",
  httpAuthorization: { _tag: "Bearer", token: "test-token" },
  target: {
    _tag: "RelayConnectionTarget",
    environmentId,
    label: "Test environment",
  } as PreparedConnection["target"],
};

const probeResult: UnitySetupProbeSuccess = {
  facts: {
    isUnityProject: true,
    cliAvailable: true,
    cliDiscoveredPath: null,
    lockfilePresent: true,
    pipelinePackage: { installed: true, resolvedVersion: "0.4.0-exp.1", declaredInManifest: true },
    selectionPackage: { installed: false, resolvedVersion: null, declaredInManifest: false },
    selectionPublisherRegistered: false,
    withinPairingGraceWindow: false,
  },
  primary: { state: "S11" },
};

describe("createUnitySetupProbeAtom", () => {
  it("scopes atom identity and fetch input by projectId within one environment", async () => {
    const source = Atom.make(Option.some(preparedConnection));
    const fetchProbe = vi.fn(async () => probeResult);
    const probeAtom = createUnitySetupProbeAtom({
      preparedConnectionAtom: () => source,
      fetchProbe,
    });
    const projectOneRef = {
      environmentId,
      projectId: ProjectId.make("project-1"),
    };
    const projectTwoRef = {
      environmentId,
      projectId: ProjectId.make("project-2"),
    };
    const registry = AtomRegistry.make();
    const projectOneAtom = probeAtom(projectOneRef);
    const projectTwoAtom = probeAtom(projectTwoRef);
    registry.mount(projectOneAtom);
    registry.mount(projectTwoAtom);

    await vi.waitFor(() => {
      expect(AsyncResult.isSuccess(registry.get(projectOneAtom))).toBe(true);
      expect(AsyncResult.isSuccess(registry.get(projectTwoAtom))).toBe(true);
    });
    expect(fetchProbe).toHaveBeenCalledTimes(2);
    expect(fetchProbe).toHaveBeenCalledWith({
      environmentId,
      projectId: projectOneRef.projectId,
      httpBaseUrl: preparedConnection.httpBaseUrl,
      httpAuthorization: preparedConnection.httpAuthorization,
    });
    expect(fetchProbe).toHaveBeenCalledWith({
      environmentId,
      projectId: projectTwoRef.projectId,
      httpBaseUrl: preparedConnection.httpBaseUrl,
      httpAuthorization: preparedConnection.httpAuthorization,
    });

    registry.dispose();
  });

  it("fires the probe fetch and leaves the Checking state once the connection becomes ready", async () => {
    // Starts at `Option.none()` — the SAME starting state
    // `preparedConnectionValueAtom` is documented to have
    // (`initialValue: Option.none()`, packages/client-runtime/src/state/session.ts:77)
    // before the environment's connection-prep handshake completes.
    const source = Atom.make(Option.none<PreparedConnection>());
    const fetchProbe = vi.fn(async () => probeResult);
    const probeAtom = createUnitySetupProbeAtom({
      preparedConnectionAtom: () => source,
      fetchProbe,
    });

    const registry = AtomRegistry.make();
    const atom = probeAtom(projectRef);
    registry.mount(atom);

    // Still "Checking…" — the connection hasn't resolved, so the fetch must
    // not have fired yet.
    expect(AsyncResult.value(registry.get(atom))).toEqual(
      expect.objectContaining({ _tag: "None" }),
    );
    expect(fetchProbe).not.toHaveBeenCalled();

    // The async handshake completes — this is the exact transition
    // `readPreparedConnection`'s one-shot snapshot could never observe,
    // because it was never subscribed to `source` in the first place.
    registry.set(source, Option.some(preparedConnection));

    await vi.waitFor(() => {
      expect(AsyncResult.isSuccess(registry.get(atom))).toBe(true);
    });
    const result = registry.get(atom);
    expect(AsyncResult.value(result)).toEqual(
      expect.objectContaining({ _tag: "Some", value: probeResult }),
    );
    expect(fetchProbe).toHaveBeenCalledTimes(1);
    expect(fetchProbe).toHaveBeenCalledWith({
      environmentId,
      projectId,
      httpBaseUrl: preparedConnection.httpBaseUrl,
      httpAuthorization: preparedConnection.httpAuthorization,
    });

    registry.dispose();
  });

  it("surfaces a stated timeout reason — never an indefinite wait — when the connection never becomes ready", async () => {
    const source = Atom.make(Option.none<PreparedConnection>());
    const fetchProbe = vi.fn(async () => probeResult);
    const probeAtom = createUnitySetupProbeAtom({
      preparedConnectionAtom: () => source,
      fetchProbe,
      // Real callers use 15s (`UNITY_SETUP_CONNECTION_WAIT_TIMEOUT_MS`); a
      // short bound here keeps the test fast without changing the
      // mechanism being proved.
      connectionWaitTimeoutMs: 20,
    });

    const registry = AtomRegistry.make();
    const atom = probeAtom(projectRef);
    registry.mount(atom);

    // `source` is deliberately left at `Option.none()` for the whole test —
    // this is the exact "connection never becomes ready" case that used to
    // leave both `unitySetup`/`result` AND `unitySetupError`/`fetchError`
    // at `null` forever (#106). This atom must NOT do that: it must resolve
    // to a stated failure.
    await vi.waitFor(() => {
      expect(AsyncResult.isFailure(registry.get(atom))).toBe(true);
    });
    const result = registry.get(atom);
    if (!AsyncResult.isFailure(result)) throw new Error("Expected the probe atom to time out.");
    expect(Cause.squash(result.cause)).toBeInstanceOf(UnitySetupConnectionWaitTimeoutError);
    expect(fetchProbe).not.toHaveBeenCalled();

    registry.dispose();
  });
});
