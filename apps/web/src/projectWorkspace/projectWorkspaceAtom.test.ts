// The Workspace panel's query is scoped per (environment, project): switching
// projects reads the other project's registry, never the previous one, and a
// connection that never becomes ready ends in a stated timeout.
import {
  EnvironmentId,
  ProjectId,
  type ProjectWorkspaceReadSuccess,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { primaryPreparedConnection } from "../lib/preparedConnectionFixture";
import {
  createProjectWorkspaceAtom,
  ProjectWorkspaceConnectionWaitTimeoutError,
} from "./projectWorkspaceAtom";

const environmentId = EnvironmentId.make("env-1");
const prepared: PreparedConnection = primaryPreparedConnection({ environmentId });
const projectA: ScopedProjectRef = { environmentId, projectId: ProjectId.make("project-a") };
const projectB: ScopedProjectRef = { environmentId, projectId: ProjectId.make("project-b") };

const registryFor = (title: string): ProjectWorkspaceReadSuccess => ({
  manifest: {
    entities: [{ id: title.toLowerCase(), title, folder: title.toLowerCase(), steps: [] }],
    issues: [],
  },
});

const successValue = (result: AsyncResult.AsyncResult<ProjectWorkspaceReadSuccess, unknown>) =>
  Option.getOrNull(AsyncResult.value(result));

describe("createProjectWorkspaceAtom", () => {
  it("reads each project's own registry when the panel switches from A to B", async () => {
    const source = Atom.make(Option.some(prepared));
    const fetchWorkspace = vi.fn(async ({ projectId }: { projectId: ProjectId }) =>
      registryFor(projectId === projectA.projectId ? "Alpha" : "Beta"),
    );
    const workspaceAtom = createProjectWorkspaceAtom({
      preparedConnectionAtom: () => source,
      fetchWorkspace,
    });
    const registry = AtomRegistry.make();

    const atomA = workspaceAtom(projectA);
    const unmountA = registry.mount(atomA);
    await vi.waitFor(() => expect(AsyncResult.isSuccess(registry.get(atomA))).toBe(true));
    expect(successValue(registry.get(atomA))?.manifest?.entities[0]?.title).toBe("Alpha");
    unmountA();

    const atomB = workspaceAtom(projectB);
    expect(atomB).not.toBe(atomA);
    expect(workspaceAtom(projectA)).toBe(atomA);
    registry.mount(atomB);
    await vi.waitFor(() => expect(AsyncResult.isSuccess(registry.get(atomB))).toBe(true));
    expect(successValue(registry.get(atomB))?.manifest?.entities[0]?.title).toBe("Beta");
    expect(fetchWorkspace).toHaveBeenLastCalledWith({
      projectId: projectB.projectId,
      prepared,
    });

    registry.dispose();
  });

  it("waits for the connection to become ready, then fetches once", async () => {
    const source = Atom.make(Option.none<PreparedConnection>());
    const fetchWorkspace = vi.fn(async () => registryFor("Alpha"));
    const workspaceAtom = createProjectWorkspaceAtom({
      preparedConnectionAtom: () => source,
      fetchWorkspace,
    });
    const registry = AtomRegistry.make();
    const atom = workspaceAtom(projectA);
    registry.mount(atom);
    expect(fetchWorkspace).not.toHaveBeenCalled();

    registry.set(source, Option.some(prepared));

    await vi.waitFor(() => expect(AsyncResult.isSuccess(registry.get(atom))).toBe(true));
    expect(fetchWorkspace).toHaveBeenCalledTimes(1);
    registry.dispose();
  });

  it("fails with a stated timeout when the connection never becomes ready", async () => {
    const source = Atom.make(Option.none<PreparedConnection>());
    const fetchWorkspace = vi.fn(async () => registryFor("Alpha"));
    const workspaceAtom = createProjectWorkspaceAtom({
      preparedConnectionAtom: () => source,
      fetchWorkspace,
      connectionWaitTimeoutMs: 20,
    });
    const registry = AtomRegistry.make();
    const atom = workspaceAtom(projectA);
    registry.mount(atom);

    await vi.waitFor(() => expect(AsyncResult.isFailure(registry.get(atom))).toBe(true));
    const result = registry.get(atom);
    if (!AsyncResult.isFailure(result)) throw new Error("Expected a timeout failure.");
    expect(Cause.squash(result.cause)).toBeInstanceOf(ProjectWorkspaceConnectionWaitTimeoutError);
    expect(fetchWorkspace).not.toHaveBeenCalled();
    registry.dispose();
  });

  it("surfaces the server's refusal message rather than a generic failure", async () => {
    const source = Atom.make(Option.some(prepared));
    const fetchWorkspace = vi.fn(async () => {
      throw new Error("workspace/workspace.json is not valid JSON.");
    });
    const workspaceAtom = createProjectWorkspaceAtom({
      preparedConnectionAtom: () => source,
      fetchWorkspace,
    });
    const registry = AtomRegistry.make();
    const atom = workspaceAtom(projectA);
    registry.mount(atom);

    await vi.waitFor(() => expect(AsyncResult.isFailure(registry.get(atom))).toBe(true));
    const result = registry.get(atom);
    if (!AsyncResult.isFailure(result)) throw new Error("Expected a fetch failure.");
    expect((Cause.squash(result.cause) as Error).message).toBe(
      "workspace/workspace.json is not valid JSON.",
    );
    registry.dispose();
  });
});
