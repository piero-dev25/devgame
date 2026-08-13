// Proves `createGenerationListAtom`'s reactive wiring — same shape
// `unitySetupProbeAtom.test.ts` proves for the Unity probe atom, applied
// here: a REACTIVE `get.some(...)` wait on the prepared-connection atom
// (never a one-shot snapshot — the #106 defect class that pattern exists to
// avoid), scoped identity per `(environmentId, projectId)`, and a stated
// timeout when the connection never becomes ready.
import {
  EnvironmentId,
  GenerationJobId,
  ProjectId,
  ThreadId,
  type GenerationListSuccess,
} from "@t3tools/contracts";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createGenerationListAtom,
  GenerationListConnectionWaitTimeoutError,
} from "./generationListAtom";

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

const listResult: GenerationListSuccess = {
  entries: [
    {
      job: {
        id: GenerationJobId.make("gen_1"),
        projectId,
        threadId: ThreadId.make("thread-1"),
        modality: "model3d",
        provider: "tripo",
        providerTaskId: "provider-task-1",
        status: "running",
        progress: 40,
        prompt: "a wooden barrel",
        parameters: {},
        assetId: null,
        error: null,
        createdAt: 1_000,
        startedAt: 1_100,
        completedAt: null,
      },
      asset: null,
      previewMediaUrl: null,
    },
  ],
};

describe("createGenerationListAtom", () => {
  it("scopes atom identity and fetch input by projectId within one environment", async () => {
    const source = Atom.make(Option.some(preparedConnection));
    const fetchList = vi.fn(async () => listResult);
    const listAtom = createGenerationListAtom({ preparedConnectionAtom: () => source, fetchList });
    const projectOneRef = { environmentId, projectId: ProjectId.make("project-1") };
    const projectTwoRef = { environmentId, projectId: ProjectId.make("project-2") };
    const registry = AtomRegistry.make();
    const projectOneAtom = listAtom(projectOneRef);
    const projectTwoAtom = listAtom(projectTwoRef);
    registry.mount(projectOneAtom);
    registry.mount(projectTwoAtom);

    await vi.waitFor(() => {
      expect(AsyncResult.isSuccess(registry.get(projectOneAtom))).toBe(true);
      expect(AsyncResult.isSuccess(registry.get(projectTwoAtom))).toBe(true);
    });
    expect(fetchList).toHaveBeenCalledWith({
      environmentId,
      projectId: projectOneRef.projectId,
      httpBaseUrl: preparedConnection.httpBaseUrl,
      httpAuthorization: preparedConnection.httpAuthorization,
    });
    expect(fetchList).toHaveBeenCalledWith({
      environmentId,
      projectId: projectTwoRef.projectId,
      httpBaseUrl: preparedConnection.httpBaseUrl,
      httpAuthorization: preparedConnection.httpAuthorization,
    });

    registry.dispose();
  });

  it("fires the list fetch and decodes the resolved value once the connection becomes ready", async () => {
    // Starts at `Option.none()` — the same starting shape
    // `preparedConnectionValueAtom` has before the environment's connection-
    // prep handshake completes (see `unitySetupProbeAtom.test.ts`'s
    // identical comment on this exact transition).
    const source = Atom.make(Option.none<PreparedConnection>());
    const fetchList = vi.fn(async () => listResult);
    const listAtom = createGenerationListAtom({ preparedConnectionAtom: () => source, fetchList });

    const registry = AtomRegistry.make();
    const atom = listAtom(projectRef);
    registry.mount(atom);

    expect(AsyncResult.value(registry.get(atom))).toEqual(
      expect.objectContaining({ _tag: "None" }),
    );
    expect(fetchList).not.toHaveBeenCalled();

    registry.set(source, Option.some(preparedConnection));

    await vi.waitFor(() => {
      expect(AsyncResult.isSuccess(registry.get(atom))).toBe(true);
    });
    const result = registry.get(atom);
    expect(AsyncResult.value(result)).toEqual(
      expect.objectContaining({ _tag: "Some", value: listResult }),
    );
    expect(fetchList).toHaveBeenCalledTimes(1);

    registry.dispose();
  });

  it("surfaces a stated timeout reason — never an indefinite wait — when the connection never becomes ready", async () => {
    const source = Atom.make(Option.none<PreparedConnection>());
    const fetchList = vi.fn(async () => listResult);
    const listAtom = createGenerationListAtom({
      preparedConnectionAtom: () => source,
      fetchList,
      connectionWaitTimeoutMs: 20,
    });

    const registry = AtomRegistry.make();
    const atom = listAtom(projectRef);
    registry.mount(atom);

    await vi.waitFor(() => {
      expect(AsyncResult.isFailure(registry.get(atom))).toBe(true);
    });
    const result = registry.get(atom);
    if (!AsyncResult.isFailure(result)) throw new Error("Expected the list atom to time out.");
    expect(Cause.squash(result.cause)).toBeInstanceOf(GenerationListConnectionWaitTimeoutError);
    expect(fetchList).not.toHaveBeenCalled();

    registry.dispose();
  });
});
