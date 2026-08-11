import type {
  UnityLegacySelectionPackageCleanupOutcome,
  UnitySelectionPackageInstallOutcome,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export const UNITY_SELECTION_PACKAGE_ID = "com.devgame.editor-presence";

/** Pre-2026-08-11 package id. Kept only so the install flow can find and
 * remove stranded artifacts a project picked up before the rename — see
 * `removeLegacySelectionPackageArtifacts` below. Not used for anything else;
 * do not resurrect this as a source-resolution or destination candidate. */
export const LEGACY_UNITY_SELECTION_PACKAGE_ID = "com.ironmind.editor-presence";

export class UnitySelectionPackageSourceMissingError extends Schema.TaggedErrorClass<UnitySelectionPackageSourceMissingError>()(
  "UnitySelectionPackageSourceMissingError",
  { packageId: Schema.Literal(UNITY_SELECTION_PACKAGE_ID) },
) {
  override get message(): string {
    return `Bundled Unity package ${this.packageId} was not found.`;
  }
}

const UnitySelectionPackageManifest = Schema.fromJsonString(
  Schema.Struct({
    name: Schema.Literal(UNITY_SELECTION_PACKAGE_ID),
    version: Schema.String,
  }),
);
const decodeUnitySelectionPackageManifest = Schema.decodeUnknownEffect(
  UnitySelectionPackageManifest,
);

/**
 * Packaged servers run from
 * `<resources>/app.asar/apps/server/dist/bin.mjs` (or the unpacked sibling
 * on WSL), so four parent traversals land on Electron's resources directory.
 * Source and dist repo layouts are the later dev-only candidates.
 */
export const unitySelectionPackageSourceCandidates = Effect.fn(
  "UnityEmbeddedSelectionPackage.sourceCandidates",
)(function* (input: { readonly moduleUrl: string; readonly cwd: string }) {
  const path = yield* Path.Path;
  const modulePath = yield* path.fromFileUrl(new URL(input.moduleUrl));
  const moduleDirectory = path.dirname(modulePath);
  return [
    path.resolve(moduleDirectory, "../../../..", "unity-packages", UNITY_SELECTION_PACKAGE_ID),
    path.resolve(moduleDirectory, "../../../..", "unity", UNITY_SELECTION_PACKAGE_ID),
    path.resolve(moduleDirectory, "../../..", "unity", UNITY_SELECTION_PACKAGE_ID),
    path.resolve(input.cwd, "unity", UNITY_SELECTION_PACKAGE_ID),
  ].filter((candidate, index, candidates) => candidates.indexOf(candidate) === index);
});

const readPackageManifest = Effect.fn("UnityEmbeddedSelectionPackage.readPackageManifest")(
  function* (packageRoot: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const raw = yield* fileSystem.readFileString(path.join(packageRoot, "package.json"));
    return yield* decodeUnitySelectionPackageManifest(raw);
  },
);

const resolveSourcePackage = Effect.fn("UnityEmbeddedSelectionPackage.resolveSourcePackage")(
  function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const candidates = yield* unitySelectionPackageSourceCandidates({
      moduleUrl: import.meta.url,
      cwd: process.cwd(),
    });
    for (const candidate of candidates) {
      if (yield* fileSystem.exists(path.join(candidate, "package.json"))) {
        return candidate;
      }
    }
    return yield* new UnitySelectionPackageSourceMissingError({
      packageId: UNITY_SELECTION_PACKAGE_ID,
    });
  },
);

/**
 * Best-effort removal of ONE legacy-id directory. `"absent"` is not a
 * failure — most projects installing post-rename never had the old id.
 * A delete failure (permissions, a locked handle, whatever) is swallowed
 * into `"failed"` rather than propagated: this is cleanup riding along on
 * an install, not the install itself, and per the rename's owner ruling a
 * stranded legacy directory must never block getting the new package in.
 *
 * Merge-gate R1 (blocker): the `exists` PROBE itself can fail with a
 * non-"NotFound" `PlatformError` — EACCES -> `PermissionDenied`, ENOTDIR/
 * ELOOP -> `BadResource`, EBUSY -> `Busy`, confirmed live against the real
 * NodeFileSystem — and effect's own `FileSystem.exists` only converts
 * `NotFound` to `false`; every other reason re-`Effect.fail`s. Since this
 * runs BEFORE the new package is copied, an unwrapped probe failure used to
 * fail the WHOLE install, not just this cleanup. Everything below —
 * including the probe — is wrapped so NO filesystem error, from either
 * step, can escape this function; the worst case is `"failed"`.
 */
const removeLegacyDirectoryBestEffort = Effect.fn(
  "UnityEmbeddedSelectionPackage.removeLegacyDirectoryBestEffort",
)(function* (directory: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* Effect.gen(function* () {
    // A failed probe is treated the same as "couldn't confirm present" —
    // this function's whole contract is that cleanup never blocks install.
    const probablyExists = yield* fileSystem
      .exists(directory)
      .pipe(Effect.orElseSucceed(() => false));
    if (!probablyExists) {
      // Merge-gate R2: still attempt a best-effort remove even though the
      // probe said (or couldn't confirm) nothing is there. `exists` follows
      // symlinks (`access` semantics), so a DANGLING legacy symlink resolves
      // ENOENT on its missing target -> `false`, even though the link
      // itself is a real, removable directory entry. `remove` no-ops
      // harmlessly on a genuinely absent path either way, and any error it
      // raises here is discarded — we already can't trust what's there.
      // Known TOCTOU, accepted (this outcome is reporting-only, not a
      // correctness guarantee): if something else removes or replaces the
      // path between the probe and this call, the reported "absent" only
      // reflects what THIS call observed and attempted, not a race-free
      // fact about the filesystem.
      yield* fileSystem.remove(directory, { recursive: true, force: true }).pipe(Effect.ignore);
      return "absent" as const;
    }
    return yield* fileSystem.remove(directory, { recursive: true, force: true }).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("unity embedded selection package: legacy cleanup failed", {
          cause,
          directory,
        }),
      ),
      Effect.match({ onFailure: () => "failed" as const, onSuccess: () => "removed" as const }),
    );
  }).pipe(
    // Belt-and-suspenders: every branch above already resolves without
    // failing, but this final catch-all is what makes the "no filesystem
    // error anywhere in this path can ever fail the install" contract true
    // by construction rather than by the current shape of the branches.
    Effect.tapError((cause) =>
      Effect.logWarning("unity embedded selection package: legacy cleanup failed unexpectedly", {
        cause,
        directory,
      }),
    ),
    Effect.orElseSucceed(() => "failed" as const),
  );
});

/** Removes `Packages/<legacy id>/` and the stranded `Library/<legacy id>/`
 * pairing handoff directory left by any pre-rename install — see
 * `UnityPairingHandoff.ts`'s (current-id) `PAIRING_HANDOFF_DIRECTORY` for
 * the write side this mirrors. Runs on every install call, not just fresh
 * ones, so a legacy leftover gets swept the next time this project's user
 * clicks "Set Up Integrations," however long after the rename that is. */
const removeLegacySelectionPackageArtifacts = Effect.fn(
  "UnityEmbeddedSelectionPackage.removeLegacySelectionPackageArtifacts",
)(function* (workspaceRoot: string) {
  const path = yield* Path.Path;
  const packagesDirectory = yield* removeLegacyDirectoryBestEffort(
    path.join(workspaceRoot, "Packages", LEGACY_UNITY_SELECTION_PACKAGE_ID),
  );
  const libraryDirectory = yield* removeLegacyDirectoryBestEffort(
    path.join(workspaceRoot, "Library", LEGACY_UNITY_SELECTION_PACKAGE_ID),
  );
  return {
    packagesDirectory,
    libraryDirectory,
  } satisfies UnityLegacySelectionPackageCleanupOutcome;
});

/** Copies the server-owned package into Unity's embedded-package location,
 * and best-effort sweeps any stranded pre-rename (`com.ironmind.*`)
 * artifacts from the same project — see `removeLegacySelectionPackageArtifacts`. */
export const installUnityEmbeddedSelectionPackage = Effect.fn(
  "UnityEmbeddedSelectionPackage.install",
)(function* (workspaceRoot: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const source = yield* resolveSourcePackage();
  const sourceManifest = yield* readPackageManifest(source);
  const destination = path.join(workspaceRoot, "Packages", UNITY_SELECTION_PACKAGE_ID);
  const destinationExists = yield* fileSystem.exists(destination);
  const destinationManifest = destinationExists
    ? yield* readPackageManifest(destination).pipe(Effect.option)
    : Option.none();
  const legacyCleanup = yield* removeLegacySelectionPackageArtifacts(workspaceRoot);

  if (
    Option.isSome(destinationManifest) &&
    destinationManifest.value.version === sourceManifest.version
  ) {
    return {
      packageId: UNITY_SELECTION_PACKAGE_ID,
      version: sourceManifest.version,
      operation: "alreadyInstalled",
      legacyCleanup,
    } satisfies UnitySelectionPackageInstallOutcome;
  }

  if (destinationExists) {
    yield* fileSystem.remove(destination, { recursive: true, force: true });
  }
  yield* fileSystem.makeDirectory(path.dirname(destination), { recursive: true });
  yield* fileSystem.copy(source, destination);

  return {
    packageId: UNITY_SELECTION_PACKAGE_ID,
    version: sourceManifest.version,
    operation: destinationExists ? "replaced" : "installed",
    legacyCleanup,
  } satisfies UnitySelectionPackageInstallOutcome;
});
