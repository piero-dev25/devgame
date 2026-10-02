// `createImportStatusAtom`: one result per (environment, project), the fetch
// waiting reactively on the prepared connection, and a refresh reading the
// receipt again. Same shape as `generation/generationListAtom.test.ts`.
import {
  EnvironmentId,
  ProjectId,
  type MrMakImportStatusSuccess,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { createImportStatusAtom } from "./importStatusAtom";

const environmentId = EnvironmentId.make("env-1");
const comparison: ScopedProjectRef = {
  environmentId,
  projectId: ProjectId.make("project-comparison"),
};
const game: ScopedProjectRef = { environmentId, projectId: ProjectId.make("project-game") };

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

const imported: MrMakImportStatusSuccess = {
  import: {
    receipt: {
      importId: "import-1",
      previousImportId: null,
      source: { repositoryPath: "/projects/mr-mak", revision: "6248c9ec01", branch: "main" },
      completedAt: "2026-10-03T10:00:00.000Z",
      outcomes: { written: 1, identical: 0, updated: 0, replaced: 0, "kept-local": 0, conflict: 0 },
      conflicts: [],
      changes: { added: 0, modified: 0, removed: 0 },
      exclusions: 0,
      transforms: [],
      skills: null,
    },
    files: [{ path: "docs/readme.md", origin: "original" }],
  },
};

const valueOf = (registry: AtomRegistry.AtomRegistry, atom: Atom.Atom<unknown>) =>
  Option.getOrNull(AsyncResult.value(registry.get(atom) as AsyncResult.AsyncResult<unknown>));

describe("createImportStatusAtom", () => {
  it("keeps each project's import apart and reads it again on refresh", async () => {
    const source = Atom.make(Option.some(preparedConnection));
    const fetchStatus = vi.fn(
      async (input: { readonly projectId: ProjectId }): Promise<MrMakImportStatusSuccess> =>
        input.projectId === comparison.projectId ? imported : { import: null },
    );
    const statusAtom = createImportStatusAtom({ preparedConnectionAtom: () => source, fetchStatus });
    const registry = AtomRegistry.make();
    const comparisonAtom = statusAtom(comparison);
    const gameAtom = statusAtom(game);
    registry.mount(comparisonAtom);
    registry.mount(gameAtom);

    await vi.waitFor(() => {
      expect(AsyncResult.isSuccess(registry.get(comparisonAtom))).toBe(true);
      expect(AsyncResult.isSuccess(registry.get(gameAtom))).toBe(true);
    });
    expect([valueOf(registry, comparisonAtom), valueOf(registry, gameAtom)]).toEqual([
      imported,
      { import: null },
    ]);
    // The same project from a fresh ref is the same atom; another environment's is not.
    expect(statusAtom({ ...comparison })).toBe(comparisonAtom);
    expect(statusAtom({ ...comparison, environmentId: EnvironmentId.make("env-2") })).not.toBe(
      comparisonAtom,
    );
    expect(fetchStatus).toHaveBeenCalledTimes(2);

    registry.refresh(comparisonAtom);
    await vi.waitFor(() => expect(fetchStatus).toHaveBeenCalledTimes(3));
    expect(fetchStatus).toHaveBeenLastCalledWith({
      projectId: comparison.projectId,
      prepared: preparedConnection,
    });

    registry.dispose();
  });

  it("waits for the connection before reading the receipt", async () => {
    const source = Atom.make(Option.none<PreparedConnection>());
    const fetchStatus = vi.fn(async (): Promise<MrMakImportStatusSuccess> => imported);
    const statusAtom = createImportStatusAtom({ preparedConnectionAtom: () => source, fetchStatus });
    const registry = AtomRegistry.make();
    const atom = statusAtom(comparison);
    registry.mount(atom);
    expect(fetchStatus).not.toHaveBeenCalled();

    registry.set(source, Option.some(preparedConnection));
    await vi.waitFor(() => expect(AsyncResult.isSuccess(registry.get(atom))).toBe(true));
    expect(valueOf(registry, atom)).toEqual(imported);

    registry.dispose();
  });
});
