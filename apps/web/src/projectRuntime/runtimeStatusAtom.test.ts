// The Run panel's status query is scoped per (environment, project), waits on
// the connection reactively, reads again through the new connection after a
// reconnect, and polls fast only while a run is live.
import {
  EnvironmentId,
  ProjectId,
  type RunState,
  type RunStatusSuccess,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { primaryPreparedConnection } from "../lib/preparedConnectionFixture";
import {
  createRuntimeStatusAtom,
  nextRuntimePollDelay,
  RuntimeConnectionWaitTimeoutError,
  type RuntimeStatusSnapshot,
} from "./runtimeStatusAtom";

const environmentId = EnvironmentId.make("env-1");
const prepared = primaryPreparedConnection({ environmentId });
const projectA: ScopedProjectRef = { environmentId, projectId: ProjectId.make("project-a") };
const projectB: ScopedProjectRef = { environmentId, projectId: ProjectId.make("project-b") };

const runWith = (status: RunState["status"]): RunState => ({
  runId: "run-1",
  profileId: "arena",
  threadId: null,
  status,
  pid: 5,
  exitCode: null,
  signal: null,
  error: null,
  startedAt: "2026-10-03T10:00:00.000Z",
  endedAt: null,
  logTail: "",
});

const statusNamed = (name: string, runs: RunState[] = []): RunStatusSuccess => ({
  profiles: [{ id: name, name, valid: true, issues: [] }],
  profilesError: null,
  runs,
});

const value = (result: AsyncResult.AsyncResult<RuntimeStatusSnapshot, unknown>) =>
  Option.getOrNull(AsyncResult.value(result));

describe("createRuntimeStatusAtom", () => {
  it("reads each project's own status when switching from A to B", async () => {
    const source = Atom.make(Option.some(prepared));
    const fetchStatus = vi.fn(async ({ projectId }: { projectId: ProjectId }) =>
      statusNamed(projectId === projectA.projectId ? "alpha" : "beta"),
    );
    const statusAtom = createRuntimeStatusAtom({
      preparedConnectionAtom: () => source,
      fetchStatus,
    });
    const registry = AtomRegistry.make();

    const atomA = statusAtom(projectA);
    registry.mount(atomA);
    await vi.waitFor(() => expect(AsyncResult.isSuccess(registry.get(atomA))).toBe(true));
    const atomB = statusAtom(projectB);
    expect(atomB).not.toBe(atomA);
    registry.mount(atomB);
    await vi.waitFor(() => expect(AsyncResult.isSuccess(registry.get(atomB))).toBe(true));

    expect(value(registry.get(atomA))?.status.profiles[0]?.id).toBe("alpha");
    expect(value(registry.get(atomB))?.status.profiles[0]?.id).toBe("beta");
    registry.dispose();
  });

  it("reads again through the new connection after a reconnect", async () => {
    const source = Atom.make(Option.some(prepared));
    const fetchStatus = vi.fn(async () => statusNamed("arena", [runWith("running")]));
    const statusAtom = createRuntimeStatusAtom({
      preparedConnectionAtom: () => source,
      fetchStatus,
    });
    const registry = AtomRegistry.make();
    const atom = statusAtom(projectA);
    registry.mount(atom);
    await vi.waitFor(() => expect(value(registry.get(atom))?.prepared).toBe(prepared));

    // Drop the connection, then come back on a new one whose server lost the run.
    registry.set(source, Option.none());
    const reconnected = primaryPreparedConnection({ environmentId });
    fetchStatus.mockImplementation(async () => statusNamed("arena"));
    registry.set(source, Option.some(reconnected));

    await vi.waitFor(() => expect(value(registry.get(atom))?.prepared).toBe(reconnected));
    expect(fetchStatus).toHaveBeenLastCalledWith({
      projectId: projectA.projectId,
      prepared: reconnected,
    });
    expect(value(registry.get(atom))?.status.runs).toEqual([]);
    registry.dispose();
  });

  it("fails with a tagged timeout when the connection never becomes ready", async () => {
    const source = Atom.make(Option.none<PreparedConnection>());
    const fetchStatus = vi.fn(async () => statusNamed("arena"));
    const statusAtom = createRuntimeStatusAtom({
      preparedConnectionAtom: () => source,
      fetchStatus,
      connectionWaitTimeoutMs: 20,
    });
    const registry = AtomRegistry.make();
    const atom = statusAtom(projectA);
    registry.mount(atom);

    await vi.waitFor(() => expect(AsyncResult.isFailure(registry.get(atom))).toBe(true));
    const result = registry.get(atom);
    if (!AsyncResult.isFailure(result)) throw new Error("Expected a timeout failure.");
    expect(Cause.squash(result.cause)).toBeInstanceOf(RuntimeConnectionWaitTimeoutError);
    expect(fetchStatus).not.toHaveBeenCalled();
    registry.dispose();
  });
});

describe("nextRuntimePollDelay", () => {
  const snapshot = (runs: RunState[]): RuntimeStatusSnapshot => ({
    status: statusNamed("arena", runs),
    prepared,
    requestedAt: 0,
  });

  it("polls fast while a run is starting or running and slowly otherwise", () => {
    const running = nextRuntimePollDelay(AsyncResult.success(snapshot([runWith("running")])));
    const starting = nextRuntimePollDelay(AsyncResult.success(snapshot([runWith("starting")])));
    const idle = nextRuntimePollDelay(AsyncResult.success(snapshot([runWith("exited")])));
    expect(running).toBe(starting);
    expect(running).not.toBeNull();
    expect(idle).not.toBeNull();
    expect(running!).toBeLessThan(idle!);
  });

  it("never stacks a poll on a request in flight, and retries after a failure", () => {
    expect(
      nextRuntimePollDelay(AsyncResult.success(snapshot([runWith("running")]), { waiting: true })),
    ).toBeNull();
    expect(
      nextRuntimePollDelay(
        AsyncResult.failure(Cause.fail(new RuntimeConnectionWaitTimeoutError())),
      ),
    ).not.toBeNull();
  });
});
