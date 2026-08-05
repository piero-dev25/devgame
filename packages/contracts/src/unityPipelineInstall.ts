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
  Schema.Struct({ _tag: Schema.Literal("ok"), value: UnityPipelineInstallOutcome }),
  Schema.Struct({ _tag: Schema.Literal("notReady") }),
  Schema.Struct({ _tag: Schema.Literal("cliUnavailable") }),
  Schema.Struct({ _tag: Schema.Literal("error"), message: Schema.String }),
]);
export type UnityPipelineInstallResult = typeof UnityPipelineInstallResult.Type;

/** The route this input is posted to — kept alongside the schema so the one
 * client call site and the one server route definition both import a single
 * literal, same convention as `UNITY_SETUP_PROBE_PATH`. */
export const UNITY_PIPELINE_INSTALL_PATH = "/unity/pipeline-install";
