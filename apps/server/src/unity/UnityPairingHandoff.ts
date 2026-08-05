import type {
  UnityEditorPresencePairingFile as UnityEditorPresencePairingFileType,
  UnityPipelinePairingOutcome,
} from "@t3tools/contracts";
import { AuthOrchestrationOperateScope, UnityEditorPresencePairingFile } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpServer } from "effect/unstable/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { ServerConfig } from "../config.ts";
import * as EditorPresenceRegistry from "../editorPresence/EditorPresenceRegistry.ts";
import { resolveHeadlessConnectionString, resolveListeningPort } from "../startupAccess.ts";

const PAIRING_HANDOFF_DIRECTORY = ["Library", "com.ironmind.editor-presence"] as const;
const PAIRING_HANDOFF_FILE = "pairing.json";
const PAIRING_HANDOFF_TTL = Duration.hours(24);
const MAX_PAIRING_PROJECT_TITLE_LENGTH = 64;
const encodePairingFile = Schema.encodeUnknownSync(
  Schema.fromJsonString(UnityEditorPresencePairingFile),
);

export interface UnityPairingHandoffDependencies {
  readonly serverUrl: string;
  readonly isAlreadyPaired: (
    workspaceRoot: string,
  ) => Effect.Effect<boolean, UnityPairingHandoffDependencyError>;
  readonly issuePairingCredential: (
    input: EnvironmentAuth.IssuePairingCredentialInput,
  ) => Effect.Effect<{ readonly credential: string }, UnityPairingHandoffDependencyError>;
}

export class UnityPairingHandoffDependencyError extends Schema.TaggedErrorClass<UnityPairingHandoffDependencyError>()(
  "UnityPairingHandoffDependencyError",
  {
    operation: Schema.Literals(["publisherLookup", "credentialMint"]),
    cause: Schema.Defect(),
  },
) {}

function truncateProjectTitle(projectTitle: string): string {
  return projectTitle.length <= MAX_PAIRING_PROJECT_TITLE_LENGTH
    ? projectTitle
    : `${projectTitle.slice(0, MAX_PAIRING_PROJECT_TITLE_LENGTH - 1)}…`;
}

export class UnityPairingHandoff extends Context.Service<
  UnityPairingHandoff,
  {
    readonly prepare: (input: {
      readonly workspaceRoot: string;
      readonly projectTitle: string;
    }) => Effect.Effect<UnityPipelinePairingOutcome>;
  }
>()("t3/unity/UnityPairingHandoff") {}

/** Dependency-injected constructor used by the live layer and route tests. */
export const make = Effect.fn("UnityPairingHandoff.make")(function* (
  dependencies: UnityPairingHandoffDependencies,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const prepare: UnityPairingHandoff["Service"]["prepare"] = Effect.fn(
    "UnityPairingHandoff.prepare",
  )(function* (input) {
    // Deliberately no Editor-liveness gate here. The web CTA uses liveness
    // only to decide whether a missing publisher is trustworthy; the server
    // mint path must still let a setup request made with Unity closed leave a
    // handoff that works the next time the user opens the Editor.
    const registration = yield* dependencies.isAlreadyPaired(input.workspaceRoot).pipe(
      Effect.tapError((cause) =>
        Effect.logError("unity pairing handoff: publisher lookup failed", {
          cause,
          workspaceRoot: input.workspaceRoot,
        }),
      ),
      Effect.match({
        onFailure: () => ({ _tag: "error" }) as const,
        onSuccess: (registered) => ({ _tag: "ok", registered }) as const,
      }),
    );
    if (registration._tag === "error") {
      return {
        _tag: "skipped",
        reason: "Could not determine whether Unity is already paired.",
      } as const;
    }
    if (registration.registered) {
      return { _tag: "alreadyPaired" } as const;
    }

    const issued = yield* dependencies
      .issuePairingCredential({
        label: `Unity selection — ${truncateProjectTitle(input.projectTitle)}`,
        scopes: [AuthOrchestrationOperateScope],
        // This feature promises to work the next time Unity opens. Five
        // minutes broke that promise, so the handoff grant explicitly lasts
        // 24 hours; it remains single-use and revocable.
        ttl: PAIRING_HANDOFF_TTL,
      })
      .pipe(
        Effect.tapError((cause) =>
          Effect.logError("unity pairing handoff: credential mint failed", {
            cause,
            workspaceRoot: input.workspaceRoot,
          }),
        ),
        Effect.match({
          onFailure: () => ({ _tag: "error" }) as const,
          onSuccess: (credential) => ({ _tag: "ok", credential }) as const,
        }),
      );
    if (issued._tag === "error") {
      return {
        _tag: "skipped",
        reason: "Could not mint a Unity pairing credential.",
      } as const;
    }

    const pairingFile = {
      serverUrl: dependencies.serverUrl,
      pairingCredential: issued.credential.credential,
    } satisfies UnityEditorPresencePairingFileType;
    const pairingDirectory = path.join(input.workspaceRoot, ...PAIRING_HANDOFF_DIRECTORY);
    const pairingPath = path.join(pairingDirectory, PAIRING_HANDOFF_FILE);
    const writeSucceeded = yield* Effect.scoped(
      Effect.gen(function* () {
        yield* fileSystem.makeDirectory(pairingDirectory, { recursive: true, mode: 0o700 });
        // Local readers were the one real exposure identified by review F5.
        // Locking the directory to 0700 and the file to 0600 is what makes
        // the feature's longer 24-hour handoff safe.
        yield* fileSystem.chmod(pairingDirectory, 0o700);
        const tempPath = yield* fileSystem.makeTempFileScoped({
          directory: pairingDirectory,
          prefix: ".pairing-",
          suffix: ".tmp",
        });
        // A pre-existing symlink in this Library directory remains the
        // accepted F12 residual; no wire input chooses this path.
        // Only the one-time credential is serialized here; redemption's
        // bearer token is produced and stored solely inside the Unity Editor.
        yield* fileSystem.writeFileString(tempPath, `${encodePairingFile(pairingFile)}\n`, {
          mode: 0o600,
        });
        yield* fileSystem.chmod(tempPath, 0o600);
        yield* fileSystem.rename(tempPath, pairingPath);
        yield* fileSystem.chmod(pairingPath, 0o600);
      }),
    ).pipe(
      Effect.tapError((cause) =>
        Effect.logError("unity pairing handoff: file write failed", {
          cause,
          pairingPath,
        }),
      ),
      Effect.match({ onFailure: () => false, onSuccess: () => true }),
    );
    return writeSucceeded
      ? ({ _tag: "minted" } as const)
      : ({
          _tag: "skipped",
          reason: "Pairing credential was minted, but the Unity handoff file could not be written.",
        } as const);
  });

  return UnityPairingHandoff.of({
    prepare,
  });
});

export const layer = Layer.effect(
  UnityPairingHandoff,
  Effect.gen(function* () {
    const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const registry = yield* EditorPresenceRegistry.EditorPresenceRegistry;
    const config = yield* ServerConfig;
    const httpServer = yield* HttpServer.HttpServer;
    const serverUrl = resolveHeadlessConnectionString(
      config.host,
      resolveListeningPort(httpServer.address, config.port),
    );
    return yield* make({
      serverUrl,
      isAlreadyPaired: (workspaceRoot) => registry.hasPublisherForWorkspace(workspaceRoot),
      issuePairingCredential: (input) =>
        environmentAuth.issuePairingCredential(input).pipe(
          Effect.mapError(
            (cause) =>
              new UnityPairingHandoffDependencyError({
                operation: "credentialMint",
                cause,
              }),
          ),
        ),
    });
  }),
);
