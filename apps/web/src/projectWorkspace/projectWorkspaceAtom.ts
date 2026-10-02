// The reactive "this project's workspace registry" query behind the Workspace
// dock panel. Same factory shape as `generation/generationListAtom.ts`: the
// prepared-connection atom and the fetch are injected so tests can drive a
// fake pair, and the connection wait is reactive (`get.some`), never a
// one-shot snapshot.
import type {
  EnvironmentId,
  ProjectId,
  ProjectWorkspaceReadSuccess,
  ScopedProjectRef,
} from "@t3tools/contracts";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { scopedProjectKey } from "@t3tools/client-runtime/environment";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Atom } from "effect/unstable/reactivity";

import { environmentSession } from "../state/session";
import { fetchProjectWorkspace } from "./fetchProjectWorkspace";

/** Waiting for the environment's connection to be prepared; separate from the fetch's own timeout. */
const PROJECT_WORKSPACE_CONNECTION_WAIT_TIMEOUT_MS = 15_000;

/**
 * Registry files change when a person or an agent edits them, not
 * continuously, so a slow poll plus focus refresh and the panel's manual
 * refresh is enough. The signal only ticks while a panel is mounted.
 */
const PROJECT_WORKSPACE_POLL_INTERVAL_MS = 10_000;

export class ProjectWorkspaceConnectionWaitTimeoutError extends Schema.TaggedError<ProjectWorkspaceConnectionWaitTimeoutError>()(
  "ProjectWorkspaceConnectionWaitTimeoutError",
  {},
) {
  override get message(): string {
    return "Still waiting for this app's connection to be ready.";
  }
}

class ProjectWorkspaceFetchError extends Schema.TaggedError<ProjectWorkspaceFetchError>()(
  "ProjectWorkspaceFetchError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return this.cause instanceof Error && this.cause.message.trim().length > 0
      ? this.cause.message
      : "Failed to load the project workspace.";
  }
}

const projectWorkspacePollSignal: Atom.Atom<number> = Atom.readable((get) => {
  let tick = 0;
  const handle = setInterval(() => get.setSelf(++tick), PROJECT_WORKSPACE_POLL_INTERVAL_MS);
  get.addFinalizer(() => clearInterval(handle));
  return tick;
});

export function createProjectWorkspaceAtom(input: {
  readonly preparedConnectionAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<Option.Option<PreparedConnection>>;
  readonly fetchWorkspace: (input: {
    readonly projectId: ProjectId;
    readonly prepared: PreparedConnection;
  }) => Promise<ProjectWorkspaceReadSuccess>;
  readonly connectionWaitTimeoutMs?: number;
}) {
  const timeoutMs = input.connectionWaitTimeoutMs ?? PROJECT_WORKSPACE_CONNECTION_WAIT_TIMEOUT_MS;

  const environmentFamily = Atom.family((environmentId: EnvironmentId) =>
    Atom.family((projectId: ProjectId) => {
      const projectRef: ScopedProjectRef = { environmentId, projectId };
      const base = Atom.make((get) =>
        Effect.gen(function* () {
          const prepared = yield* Effect.timeoutOrElse(
            get.some(input.preparedConnectionAtom(environmentId)),
            {
              duration: Duration.millis(timeoutMs),
              orElse: () => Effect.fail(new ProjectWorkspaceConnectionWaitTimeoutError()),
            },
          );
          return yield* Effect.tryPromise({
            try: () => input.fetchWorkspace({ projectId, prepared }),
            catch: (cause) => new ProjectWorkspaceFetchError({ cause }),
          });
        }),
      ).pipe(Atom.withLabel(`project-workspace:${scopedProjectKey(projectRef)}`));

      // Focus refresh needs `window` (browser only); plain-Node tests mount
      // this factory directly, so it is added only where a window exists.
      const withPoll = Atom.makeRefreshOnSignal(projectWorkspacePollSignal)(base);
      return typeof window === "undefined" ? withPoll : Atom.refreshOnWindowFocus(withPoll);
    }),
  );

  return (projectRef: ScopedProjectRef) =>
    environmentFamily(projectRef.environmentId)(projectRef.projectId);
}

export const projectWorkspaceAtom = createProjectWorkspaceAtom({
  preparedConnectionAtom: environmentSession.preparedConnectionValueAtom,
  fetchWorkspace: fetchProjectWorkspace,
});
