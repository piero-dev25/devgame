// A project's Mr. Mak import as the Workspace panel shows it: read from the
// project's receipt on every fetch, so it is the same after switching
// projects, reopening the app or restarting the server. Same factory shape as
// `projectWorkspace/projectWorkspaceAtom.ts`. It does not poll or refresh on
// focus: the server hashes every imported file per read, so it refreshes only
// on mount, the panel's refresh and after an import.
import type {
  EnvironmentId,
  MrMakImportStatusSuccess,
  ProjectId,
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
import { fetchImportStatus } from "./fetchMrMakImport";

const IMPORT_STATUS_CONNECTION_WAIT_TIMEOUT_MS = 15_000;

class ImportStatusConnectionWaitTimeoutError extends Schema.TaggedError<ImportStatusConnectionWaitTimeoutError>()(
  "ImportStatusConnectionWaitTimeoutError",
  {},
) {
  override get message(): string {
    return "Still waiting for this app's connection to be ready.";
  }
}

class ImportStatusFetchError extends Schema.TaggedError<ImportStatusFetchError>()(
  "ImportStatusFetchError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return this.cause instanceof Error && this.cause.message.trim().length > 0
      ? this.cause.message
      : "Failed to read this project's import.";
  }
}

function createImportStatusAtom(input: {
  readonly preparedConnectionAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<Option.Option<PreparedConnection>>;
  readonly fetchStatus: (input: {
    readonly projectId: ProjectId;
    readonly prepared: PreparedConnection;
  }) => Promise<MrMakImportStatusSuccess>;
}) {
  const environmentFamily = Atom.family((environmentId: EnvironmentId) =>
    Atom.family((projectId: ProjectId) => {
      const projectRef: ScopedProjectRef = { environmentId, projectId };
      return Atom.make((get) =>
        Effect.gen(function* () {
          const prepared = yield* Effect.timeoutOrElse(
            get.some(input.preparedConnectionAtom(environmentId)),
            {
              duration: Duration.millis(IMPORT_STATUS_CONNECTION_WAIT_TIMEOUT_MS),
              orElse: () => Effect.fail(new ImportStatusConnectionWaitTimeoutError()),
            },
          );
          return yield* Effect.tryPromise({
            try: () => input.fetchStatus({ projectId, prepared }),
            catch: (cause) => new ImportStatusFetchError({ cause }),
          });
        }),
      ).pipe(Atom.withLabel(`mrmak-import-status:${scopedProjectKey(projectRef)}`));
    }),
  );

  return (projectRef: ScopedProjectRef) =>
    environmentFamily(projectRef.environmentId)(projectRef.projectId);
}

export const importStatusAtom = createImportStatusAtom({
  preparedConnectionAtom: environmentSession.preparedConnectionValueAtom,
  fetchStatus: fetchImportStatus,
});
