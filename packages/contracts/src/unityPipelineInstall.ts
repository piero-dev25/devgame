// Contract for `POST /unity/pipeline-install` — plan §5's increment 4a,
// docs/workbench/plan-setup-integration.md. Consented `unity pipeline
// install --project-path "<path>" --json --non-interactive`, gated behind an
// explicit client-side consent click (ConnectionsSettings.tsx). §8-1's real
// experiment (2026-08-04, presence-authz) settled two things with measured
// numbers, not inference: the command succeeds with no Editor running at
// all, and with no Editor open it writes exactly one line to
// `Packages/manifest.json` and does NOT touch `Packages/packages-lock.json`
// or download the package — Unity's own resolver does that later,
// asynchronously, whenever its Editor next processes the manifest change.
// That is why §3's consent copy promises the manifest line and explicitly
// does NOT promise a computed lockfile diff.
import * as Schema from "effect/Schema";

import { ProjectId } from "./baseSchemas.ts";

/**
 * The caller supplies only an opaque, server-issued project id. The server
 * resolves the canonical workspace root from its own projection store, so
 * this disk-writing route never accepts a filesystem path from the wire.
 *
 * Honest limit of that guarantee (merge-gate F10): the stored
 * `workspace_root` was ITSELF caller-supplied once — at `project.create`/
 * `project.meta.update`, under `orchestration:operate`, validated only as
 * an existing directory. So the precise property is "the install target is
 * a registered, non-deleted project some earlier AUTHORIZED caller bound",
 * not "a path no caller ever chose". The two capabilities sit behind
 * different scopes, which is what makes the indirection meaningful.
 */
export const UnityPipelineInstallInput = Schema.Struct({ projectId: ProjectId });
export type UnityPipelineInstallInput = typeof UnityPipelineInstallInput.Type;

/** `unity pipeline install`'s own successful `data`, mirrored from
 * `UnityPipelineClient.ts`'s `UnityPipelineInstallResult` — restated here
 * (not imported) rather than crossing the apps/server -> packages/contracts
 * boundary, same convention `UnityCommandResult` (unity.ts) and
 * `UnitySetupPipelineListOutcome` (unitySetup.ts) both already follow. */
export const UnityPipelineInstallOutcome = Schema.Struct({
  packageId: Schema.String,
  version: Schema.String,
  alreadyInstalled: Schema.Boolean,
});
export type UnityPipelineInstallOutcome = typeof UnityPipelineInstallOutcome.Type;

/** Best-effort outcome of removing one stranded legacy-id directory during
 * install — `"absent"` (nothing to clean), `"removed"`, or `"failed"` (left
 * in place; the install itself still succeeds, see
 * `UnityEmbeddedSelectionPackage.ts`'s `installUnityEmbeddedSelectionPackage`). */
export const UnityLegacySelectionPackageCleanupOutcome = Schema.Struct({
  packagesDirectory: Schema.Literals(["absent", "removed", "failed"]),
  libraryDirectory: Schema.Literals(["absent", "removed", "failed"]),
});
export type UnityLegacySelectionPackageCleanupOutcome =
  typeof UnityLegacySelectionPackageCleanupOutcome.Type;

export const UnitySelectionPackageInstallOutcome = Schema.Struct({
  packageId: Schema.Literal("com.devgame.editor-presence"),
  version: Schema.String,
  operation: Schema.Literals(["installed", "alreadyInstalled", "replaced"]),
  // Optional: only present once the rename's legacy-cleanup migration runs.
  // Absent (not merely `undefined`) on any wire payload predating it, and on
  // every existing test fixture in this repo that doesn't opt in — keeps
  // this addition non-breaking for those call sites.
  legacyCleanup: Schema.optional(UnityLegacySelectionPackageCleanupOutcome),
});
export type UnitySelectionPackageInstallOutcome = typeof UnitySelectionPackageInstallOutcome.Type;

/** Per-machine, one-time handoff consumed by the embedded Unity package.
 * This file never contains the bearer token returned by redemption. */
export const UnityEditorPresencePairingFile = Schema.Struct({
  serverUrl: Schema.String,
  pairingCredential: Schema.String,
});
export type UnityEditorPresencePairingFile = typeof UnityEditorPresencePairingFile.Type;

export const UnityPipelinePairingOutcome = Schema.Union([
  Schema.TaggedStruct("minted", {}),
  Schema.TaggedStruct("alreadyPaired", {}),
  Schema.TaggedStruct("skipped", { reason: Schema.String }),
]);
export type UnityPipelinePairingOutcome = typeof UnityPipelinePairingOutcome.Type;

/** Outcome of `UnityPipelineInstallRoute.ts`'s post-copy `unity command
 * package_resolve` nudge (task #130) — forces an Auto-Refresh-OFF Editor to
 * notice and load the embedded selection package this same install just
 * replaced, rather than leaving it sat unloaded until the user happens to
 * refocus Unity (verified live, evidence/qa-round9/REPORT.md).
 * `"invoked"` means the CLI command was actually run (a live matched Unity
 * Editor was found for this project); `"skipped_no_editor"` means no live
 * Editor was found, so nothing was attempted (this route never cold-starts
 * Unity just to resolve a package); `"failed"` means a live Editor WAS
 * found but the CLI call itself did not succeed — non-fatal to the
 * install either way, see `UnityPipelineInstallRoute.ts`. */
export const UnityPackageResolveOutcome = Schema.Literals([
  "invoked",
  "skipped_no_editor",
  "failed",
]);
export type UnityPackageResolveOutcome = typeof UnityPackageResolveOutcome.Type;

/**
 * Mirrors `UnityPipelineClient.ts`'s own `UnityPipelineResult<A>` exactly —
 * same shape `UnityCommandResult` uses for the identical reason: a client
 * that only sees `{ok:false, error:string}` can't render "the CLI isn't
 * installed" and "this genuinely broke" as the different things they are.
 * `insufficientScope` is NOT one of these tags — same convention as
 * `UnitySetupProbeRoute.ts`'s `dispatchUnitySetupProbe`: a missing scope is
 * an HTTP-layer 403, not a value in this union.
 */
export const UnityPipelineInstallResult = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("ok"),
    value: UnityPipelineInstallOutcome,
    selectionPackage: UnitySelectionPackageInstallOutcome,
    pairingOutcome: UnityPipelinePairingOutcome,
    // Optional, same non-breaking posture as `legacyCleanup` above: absent
    // on any wire payload/test fixture predating task #130, not merely
    // `undefined`.
    packageResolve: Schema.optional(UnityPackageResolveOutcome),
  }),
  Schema.Struct({ _tag: Schema.Literal("notReady") }),
  Schema.Struct({ _tag: Schema.Literal("cliUnavailable") }),
  Schema.Struct({ _tag: Schema.Literal("error"), message: Schema.String }),
]);
export type UnityPipelineInstallResult = typeof UnityPipelineInstallResult.Type;

/** The route this input is posted to — kept alongside the schema so the one
 * client call site and the one server route definition both import a single
 * literal, same convention as `UNITY_SETUP_PROBE_PATH`. */
export const UNITY_PIPELINE_INSTALL_PATH = "/unity/pipeline-install";
