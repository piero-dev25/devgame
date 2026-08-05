import type { UnitySelectionPackageInstallOutcome } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export const UNITY_SELECTION_PACKAGE_ID = "com.ironmind.editor-presence";

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

/** Copies the server-owned package into Unity's embedded-package location. */
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

  if (
    Option.isSome(destinationManifest) &&
    destinationManifest.value.version === sourceManifest.version
  ) {
    return {
      packageId: UNITY_SELECTION_PACKAGE_ID,
      version: sourceManifest.version,
      operation: "alreadyInstalled",
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
  } satisfies UnitySelectionPackageInstallOutcome;
});
