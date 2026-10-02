// The reactive "this project's run profiles and runs" query behind the Run
// dock panel. Same factory shape as `projectWorkspace/projectWorkspaceAtom.ts`:
// the prepared-connection atom and the fetch are injected so tests can drive a
// fake pair, and the connection wait is reactive (`get.some`).
//
// Each snapshot records the connection it was read through and when the
// request went out. The panel uses both to keep what it shows honest: a
// snapshot read through an earlier connection is "last known", never live,
// and a command receipt is only layered over snapshots requested before it.
import type {
  EnvironmentId,
  ProjectId,
  RunStatusSuccess,
  ScopedProjectRef,
} from "@t3tools/contracts";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { scopedProjectKey } from "@t3tools/client-runtime/environment";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { environmentSession } from "../state/session";
import { fetchRuntimeStatus } from "./fetchRuntimeStatus";

export interface RuntimeStatusSnapshot {
  readonly status: RunStatusSuccess;
  /** The connection the status was read through. */
  readonly prepared: PreparedConnection;
  /** Epoch ms when the request was sent (the receipt's `receivedAt` uses the same clock). */
  readonly requestedAt: number;
}

/** Waiting for the environment's connection to be prepared; separate from the fetch's own timeout. */
const RUNTIME_CONNECTION_WAIT_TIMEOUT_MS = 15_000;

/**
 * Poll fast only while a run is starting or running (its log tail grows),
 * slowly when idle, and retry at a middle pace after a failure so a
 * reconnect is picked up. The timer exists only while the panel is mounted.
 */
const POLL_ACTIVE_MS = 1_500;
const POLL_IDLE_MS = 10_000;
const POLL_FAILED_MS = 5_000;

export class RuntimeConnectionWaitTimeoutError extends Schema.TaggedError<RuntimeConnectionWaitTimeoutError>()(
  "RuntimeConnectionWaitTimeoutError",
  {},
) {
  override get message(): string {
    return "Still waiting for this environment's connection to be ready.";
  }
}

class RuntimeStatusFetchError extends Schema.TaggedError<RuntimeStatusFetchError>()(
  "RuntimeStatusFetchError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return this.cause instanceof Error && this.cause.message.trim().length > 0
      ? this.cause.message
      : "Failed to load run status.";
  }
}

type RuntimeStatusResult = AsyncResult.AsyncResult<
  RuntimeStatusSnapshot,
  RuntimeConnectionWaitTimeoutError | RuntimeStatusFetchError
>;

/** Next poll delay, or null while a request is in flight (never stack requests). */
export function nextRuntimePollDelay(result: RuntimeStatusResult): number | null {
  if (result.waiting) return null;
  if (result._tag === "Failure") return POLL_FAILED_MS;
  if (result._tag === "Initial") return null;
  const active = result.value.status.runs.some(
    (run) => run.status === "starting" || run.status === "running",
  );
  return active ? POLL_ACTIVE_MS : POLL_IDLE_MS;
}

const withAdaptivePoll = (self: Atom.Atom<RuntimeStatusResult>) =>
  Atom.transform(
    self,
    (get) => {
      let handle: ReturnType<typeof setTimeout> | undefined;
      const schedule = (result: RuntimeStatusResult) => {
        clearTimeout(handle);
        const delay = nextRuntimePollDelay(result);
        handle = delay === null ? undefined : setTimeout(() => get.refresh(self), delay);
      };
      get.addFinalizer(() => clearTimeout(handle));
      get.subscribe(self, (value) => {
        schedule(value);
        get.setSelf(value);
      });
      const initial = get.once(self);
      schedule(initial);
      return initial;
    },
    { initialValueTarget: self },
  );

export function createRuntimeStatusAtom(input: {
  readonly preparedConnectionAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<Option.Option<PreparedConnection>>;
  readonly fetchStatus: (input: {
    readonly projectId: ProjectId;
    readonly prepared: PreparedConnection;
  }) => Promise<RunStatusSuccess>;
  readonly connectionWaitTimeoutMs?: number;
}) {
  const timeoutMs = input.connectionWaitTimeoutMs ?? RUNTIME_CONNECTION_WAIT_TIMEOUT_MS;

  const environmentFamily = Atom.family((environmentId: EnvironmentId) =>
    Atom.family((projectId: ProjectId) => {
      const projectRef: ScopedProjectRef = { environmentId, projectId };
      // Reads the connection atom reactively: a reconnect that swaps the
      // prepared connection re-runs the fetch against the new one.
      const base: Atom.Atom<RuntimeStatusResult> = Atom.make((get) =>
        Effect.gen(function* () {
          const prepared = yield* Effect.timeoutOrElse(
            get.some(input.preparedConnectionAtom(environmentId)),
            {
              duration: Duration.millis(timeoutMs),
              orElse: () => Effect.fail(new RuntimeConnectionWaitTimeoutError()),
            },
          );
          const requestedAt = yield* Clock.currentTimeMillis;
          const status = yield* Effect.tryPromise({
            try: () => input.fetchStatus({ projectId, prepared }),
            catch: (cause) => new RuntimeStatusFetchError({ cause }),
          });
          return { status, prepared, requestedAt };
        }),
      ).pipe(Atom.withLabel(`project-runtime-status:${scopedProjectKey(projectRef)}`));

      const polled = withAdaptivePoll(base);
      // Focus refresh needs `window`; plain-Node tests mount the factory directly.
      return typeof window === "undefined" ? polled : Atom.refreshOnWindowFocus(polled);
    }),
  );

  return (projectRef: ScopedProjectRef) =>
    environmentFamily(projectRef.environmentId)(projectRef.projectId);
}

export const runtimeStatusAtom = createRuntimeStatusAtom({
  preparedConnectionAtom: environmentSession.preparedConnectionValueAtom,
  fetchStatus: fetchRuntimeStatus,
});
