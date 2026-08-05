// Contract for `UnitySetupProbe` — the read-only "what's missing to make
// Unity work" check. See docs/workbench/plan-setup-integration.md, §1 "New
// route and auth scope (F6)" and §2 "Every distinguishable state and its
// exact sentence" — this file is that table given a wire shape. State tags
// (`S0`..`S13`, plus the primed variants `S2'`/`S4'`/`S8'`/`S10'`) are named
// identically to the plan's own table so a reader can go from a state on
// the wire straight back to the row that explains it, with no renaming
// layer to translate through.
//
// Phase 1 ONLY (increments 0-3 of the plan's §5 work order): this contract
// covers DETECTION, never installation. There is no "install" action
// anywhere in this file — every state below is read-only, and the probe
// this contract describes writes nothing to any project, ever. Phase 2's
// install actions (§5, increments 4a-4c) are a deliberately separate,
// later contract.
import * as Schema from "effect/Schema";

import { ProjectId } from "./baseSchemas.ts";

/**
 * `packages-lock.json`'s (or the equivalent embedded-package check's) own
 * verdict for ONE package id — shared shape for both Pipeline
 * (`com.unity.pipeline`) and the selection package
 * (`com.ironmind.editor-presence`). Plan §1, F1: `packages-lock.json` is
 * the authoritative resolved-package source, not `manifest.json` — a
 * package embedded or vendored (present in the lock, absent from
 * `manifest.json`) is still genuinely installed. For the selection package,
 * `installed` also becomes true as soon as its embedded package.json exists
 * under `Packages/`, before Unity catches the lockfile up. The version fields
 * are reporting-only and are not used by classification.
 */
export const UnitySetupPackageLockState = Schema.Struct({
  installed: Schema.Boolean,
  /** The version string from `packages-lock.json`'s own entry, when
   * resolved — `null` when not resolved yet, including a freshly copied
   * embedded selection package that Unity has not put in the lockfile. */
  resolvedVersion: Schema.NullOr(Schema.String),
  /** Whether `Packages/manifest.json` names this package directly —
   * DECLARED intent (`UnityPackageLock.ts`'s `readManifestDependencyIds`),
   * never a substitute for `installed`. Added 2026-08-04 (team-lead +
   * presence-authz) once a real gap surfaced: with no Unity Editor
   * running, a successful `unity pipeline install` writes ONLY the
   * manifest line — the lock stays untouched until Unity resolves it — so
   * `installed` alone can't distinguish "never added" from "added, Unity
   * hasn't caught up yet." See `UnitySetupClassifier.ts`'s S13 state,
   * which is exactly this distinction. */
  declaredInManifest: Schema.Boolean,
});
export type UnitySetupPackageLockState = typeof UnitySetupPackageLockState.Type;

/**
 * One instance's worth of `unity pipeline list --json` data, for the ONE
 * instance (if any) whose `projectPath` matches this project's own root —
 * see plan §1's F14 path-matching note. `null` at the CALLER (not here)
 * means "no instance matched," which is a distinct, meaningful signal
 * (S5/S6), never conflated with "pipeline list itself failed" (S12) or
 * "hasn't been asked yet" (S4′'s window) — those are represented at the
 * `UnitySetupPipelineListOutcome` level below, not by this struct being
 * absent.
 */
export const UnitySetupPipelineInstance = Schema.Struct({
  projectPath: Schema.String,
  pid: Schema.NullOr(Schema.Number),
  isRunning: Schema.Boolean,
  hasPipelinePackage: Schema.Boolean,
  isReachable: Schema.Boolean,
  pipelineVersion: Schema.NullOr(Schema.String),
  /** `true`/`false` is a real answer; `null` means the registry lookup
   * failed or Unity is offline — plan §2's F10 fix: `null` must never be
   * read as "no update available." */
  updateAvailable: Schema.NullOr(Schema.Boolean),
  /** `null` observed live alongside `updateAvailable` being unresolvable
   * (plan §2's critique citation) — not every instance report carries a
   * definite answer. */
  safeMode: Schema.NullOr(Schema.Boolean),
});
export type UnitySetupPipelineInstance = typeof UnitySetupPipelineInstance.Type;

/**
 * The outcome of actually RUNNING `unity pipeline list --json` this probe
 * cycle — distinct from "haven't run it yet," which is represented by this
 * field being entirely ABSENT from `UnitySetupFacts.pipelineList`
 * (plan §2's F13: the lockfile is only ever the cheap ambient pre-check
 * that decides whether this ~400ms call is worth paying for at all).
 */
export const UnitySetupPipelineListOutcome = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("ran"),
    /** The path-matched instance (plan §1's F14 normalizer), or `null` if
     * `pipeline list` ran successfully but found no instance for this
     * project's root — a real, meaningful "not running here" answer, not
     * a failure. */
    matched: Schema.NullOr(UnitySetupPipelineInstance),
    /** `unity pipeline list --json`'s own `data.latestVersion` — a
     * CLI-WIDE fact ("the newest Pipeline version this CLI knows how to
     * install"), not a per-instance one. Confirmed against a real captured
     * sample (2026-08-04, `Mafia Game`): `data.latestVersion` sits
     * alongside `data.instances`, not inside any one instance object —
     * this field lives here, sibling to `matched`, for that reason, not on
     * `UnitySetupPipelineInstance` (where an earlier, reconstructed-not-
     * captured version of this contract wrongly put it). */
    latestVersion: Schema.NullOr(Schema.String),
    /** How many entries of `data.instances` the server DROPPED because
     * they didn't match the shape this contract recognizes — 0 on the
     * common path. Found live (2026-08-04, presence-authz): `pipeline
     * list` is machine-wide, and a single stray/malformed peer instance
     * (observed: a phantom self-referential entry with no `pid` at all,
     * reported for whatever directory invoked the CLI) used to take the
     * ENTIRE list down under an all-or-nothing parse — discarding a
     * perfectly healthy `matched` entry along with it. The parser is now
     * resilient (see `UnityPipelineClient.ts`'s `parsePipelineListResult`),
     * but resilience that hides its own trade-off is a worse failure mode
     * than the one it replaces — this field is what keeps a partial parse
     * honest instead of silent, on the wire, not just in server logs. */
    unparseableInstanceCount: Schema.Number,
  }),
  /** `unity pipeline list --json` exited non-zero, or its output didn't
   * parse into the shape this module recognizes. Carries the CLI's own
   * message VERBATIM (plan §1: "when nothing matches, show the CLI's own
   * message verbatim — never map an unrecognized CLI string onto a
   * friendly sentence") — this is the S12 source. */
  Schema.Struct({ _tag: Schema.Literal("cliError"), message: Schema.String }),
]);
export type UnitySetupPipelineListOutcome = typeof UnitySetupPipelineListOutcome.Type;

/**
 * Every raw fact this probe gathers, independent of how they combine into
 * ONE primary state below. Increment 3's "Set Up Integration" settings
 * panel (per-item status, plan §5) reads THIS, not `primary` — a project
 * can simultaneously be missing the selection package (S9-worthy) AND have
 * Unity closed (S6-worthy), and a per-item panel needs to say both, not
 * pick the single sentence a toolbar would.
 */
export const UnitySetupFacts = Schema.Struct({
  /** Whether the resolved project root contains
   * `ProjectSettings/ProjectVersion.txt`. This server-side filesystem fact
   * is the classifier's first gate: setup/package state is irrelevant when
   * the requested project is not a Unity project. */
  isUnityProject: Schema.Boolean,
  cliAvailable: Schema.Boolean,
  /** Populated only when `cliAvailable` is `false` and a candidate binary
   * was found off-PATH (plan §7's F11 fix) — `null` otherwise, including
   * when the CLI IS on PATH. */
  cliDiscoveredPath: Schema.NullOr(Schema.String),
  lockfilePresent: Schema.Boolean,
  pipelinePackage: UnitySetupPackageLockState,
  selectionPackage: UnitySetupPackageLockState,
  pipelineList: Schema.optionalKey(UnitySetupPipelineListOutcome),
  /** Whether `EditorPresenceRegistry` currently has a publisher registered
   * for this project's workspace root — the input S10/S10′ need (plan
   * §2's F3). Always `false` when `selectionPackage.installed` is
   * `false`, since nothing can be paired without the package first. */
  selectionPublisherRegistered: Schema.Boolean,
  /** Whether this probe ran inside the grace window after server start
   * (plan §2's F3, default 15s) — the window S10′ exists for. */
  withinPairingGraceWindow: Schema.Boolean,
});
export type UnitySetupFacts = typeof UnitySetupFacts.Type;

/**
 * The ONE state a toolbar (increment 2) reads directly — computed from
 * `UnitySetupFacts` in the priority order plan §2's table implies (CLI,
 * then Pipeline package/liveness, then selection package/pairing), by the
 * PURE classifier in `apps/server/src/unity/UnitySetupClassifier.ts`. Every
 * variant's `message` is the exact sentence from plan §2's table — this
 * contract is deliberately not responsible for the copy staying in sync by
 * convention; the classifier's own tests pin the literal strings.
 *
 * S3 (not signed in) and S8′ (update status unknown) are deliberately
 * ABSENT from this union — see plan §8, item 2 ("Until settled, S3 gates
 * installs only") and §2's S8′ row ("not shown at all — falls through to
 * whichever of S6/S11 otherwise applies"). Neither is a state Phase 1 ever
 * surfaces as the primary toolbar message; `updateAvailable`/`safeMode`
 * being unresolvable still reaches `UnitySetupFacts.pipelineList` for
 * increment 3's per-item reporting, just never becomes `primary`.
 */
export const UnitySetupPrimaryState = Schema.Union([
  Schema.Struct({ state: Schema.Literal("S0"), message: Schema.String }),
  Schema.Struct({ state: Schema.Literal("S1"), message: Schema.String }),
  Schema.Struct({
    state: Schema.Literal("S2"),
    message: Schema.String,
    discoveredPath: Schema.String,
  }),
  Schema.Struct({ state: Schema.Literal("S2'"), message: Schema.String }),
  Schema.Struct({ state: Schema.Literal("S4"), message: Schema.String }),
  Schema.Struct({ state: Schema.Literal("S4'"), message: Schema.String }),
  Schema.Struct({ state: Schema.Literal("S5"), message: Schema.String }),
  Schema.Struct({ state: Schema.Literal("S6"), message: Schema.String }),
  Schema.Struct({ state: Schema.Literal("S7a"), message: Schema.String }),
  Schema.Struct({ state: Schema.Literal("S7b"), message: Schema.String }),
  Schema.Struct({
    state: Schema.Literal("S8"),
    message: Schema.String,
    latestVersion: Schema.String,
  }),
  Schema.Struct({ state: Schema.Literal("S9"), message: Schema.String }),
  Schema.Struct({ state: Schema.Literal("S10"), message: Schema.String }),
  Schema.Struct({ state: Schema.Literal("S10'"), message: Schema.String }),
  Schema.Struct({ state: Schema.Literal("S11") }),
  Schema.Struct({ state: Schema.Literal("S12"), message: Schema.String, command: Schema.String }),
  /** Added 2026-08-04 (team-lead + presence-authz), not in plan §2's
   * original table — see `UnitySetupClassifier.ts`'s own doc comment on
   * this state for why it exists and why it wins over both S4 and S5. */
  Schema.Struct({ state: Schema.Literal("S13"), message: Schema.String }),
]);
export type UnitySetupPrimaryState = typeof UnitySetupPrimaryState.Type;

export const UnitySetupProbeSuccess = Schema.Struct({
  facts: UnitySetupFacts,
  primary: UnitySetupPrimaryState,
});
export type UnitySetupProbeSuccess = typeof UnitySetupProbeSuccess.Type;

/** A successful classification, or an honest typed failure to resolve the
 * opaque project id. Successful payloads intentionally keep their existing
 * wire shape; only the error variant is tagged. */
export const UnitySetupProbeResult = Schema.Union([
  UnitySetupProbeSuccess,
  Schema.TaggedStruct("error", { message: Schema.String }),
]);
export type UnitySetupProbeResult = typeof UnitySetupProbeResult.Type;

/**
 * The client supplies only the opaque, server-issued project id it already
 * holds. The server resolves the canonical workspace root from its own
 * projection store; no filesystem path crosses this wire boundary.
 */
export const UnitySetupProbeInput = Schema.Struct({ projectId: ProjectId });
export type UnitySetupProbeInput = typeof UnitySetupProbeInput.Type;

/** Kept alongside the schema so the one client call site and the one
 * server route definition both import a single literal, same convention as
 * `UNITY_COMMAND_PATH`. */
export const UNITY_SETUP_PROBE_PATH = "/unity/setup-probe";
