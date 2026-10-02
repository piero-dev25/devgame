/**
 * Migration runner with an inline loader.
 *
 * Uses Migrator.make with fromRecord to define migrations inline.
 * All migrations are statically imported - no dynamic file system loading.
 *
 * `runMigrations` is called by the SQLite persistence layer at startup, so the
 * schema is always up to date before the application starts.
 */

import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

// Import all migrations statically
import Migration0001 from "./Migrations/001_OrchestrationEvents.ts";
import Migration0002 from "./Migrations/002_OrchestrationCommandReceipts.ts";
import Migration0003 from "./Migrations/003_CheckpointDiffBlobs.ts";
import Migration0004 from "./Migrations/004_ProviderSessionRuntime.ts";
import Migration0005 from "./Migrations/005_Projections.ts";
import Migration0006 from "./Migrations/006_ProjectionThreadSessionRuntimeModeColumns.ts";
import Migration0007 from "./Migrations/007_ProjectionThreadMessageAttachments.ts";
import Migration0008 from "./Migrations/008_ProjectionThreadActivitySequence.ts";
import Migration0009 from "./Migrations/009_ProviderSessionRuntimeMode.ts";
import Migration0010 from "./Migrations/010_ProjectionThreadsRuntimeMode.ts";
import Migration0011 from "./Migrations/011_OrchestrationThreadCreatedRuntimeMode.ts";
import Migration0012 from "./Migrations/012_ProjectionThreadsInteractionMode.ts";
import Migration0013 from "./Migrations/013_ProjectionThreadProposedPlans.ts";
import Migration0014 from "./Migrations/014_ProjectionThreadProposedPlanImplementation.ts";
import Migration0015 from "./Migrations/015_ProjectionTurnsSourceProposedPlan.ts";
import Migration0016 from "./Migrations/016_CanonicalizeModelSelections.ts";
import Migration0017 from "./Migrations/017_ProjectionThreadsArchivedAt.ts";
import Migration0018 from "./Migrations/018_ProjectionThreadsArchivedAtIndex.ts";
import Migration0019 from "./Migrations/019_ProjectionSnapshotLookupIndexes.ts";
import Migration0020 from "./Migrations/020_AuthAccessManagement.ts";
import Migration0021 from "./Migrations/021_AuthSessionClientMetadata.ts";
import Migration0022 from "./Migrations/022_AuthSessionLastConnectedAt.ts";
import Migration0023 from "./Migrations/023_ProjectionThreadShellSummary.ts";
import Migration0024 from "./Migrations/024_BackfillProjectionThreadShellSummary.ts";
import Migration0025 from "./Migrations/025_CleanupInvalidProjectionPendingApprovals.ts";
import Migration0026 from "./Migrations/026_CanonicalizeModelSelectionOptions.ts";
import Migration0027 from "./Migrations/027_ProviderSessionRuntimeInstanceId.ts";
import Migration0028 from "./Migrations/028_ProjectionThreadSessionInstanceId.ts";
import Migration0029 from "./Migrations/029_ProjectionThreadDetailOrderingIndexes.ts";
import Migration0030 from "./Migrations/030_ProjectionThreadShellArchiveIndexes.ts";
import Migration0031 from "./Migrations/031_AuthAuthorizationScopes.ts";
import Migration0032 from "./Migrations/032_AuthPairingProofKeyThumbprint.ts";
import Migration0033 from "./Migrations/033_ProjectionThreadsSettled.ts";
import Migration0034 from "./Migrations/034_ProjectionThreadsSnoozed.ts";
import Migration0035 from "./Migrations/035_ProjectionThreadTitleRegeneration.ts";
import Migration0036 from "./Migrations/036_ProjectionThreadsSpaceAndTaskRef.ts";
import Migration0037 from "./Migrations/037_ProjectionSpaces.ts";
// The fork's 036/037 claimed ids upstream later reused, so every upstream
// migration from upstream-036 on runs at upstream id + 2 here. Each file's
// numeric prefix is renamed to the runtime id it runs under (038-040 in the
// 2026-08-08 merge, 041-056 = upstream 039-054 in the 2026-10-02 merge); the
// id in `migrationEntries` stays authoritative. Ids already applied to fork
// databases can never be renumbered (Migrator only runs id > max(applied)),
// so new upstream migrations are appended, never inserted.
import Migration0038 from "./Migrations/038_ProjectionThreadsPinned.ts";
import Migration0039 from "./Migrations/039_ProjectionTurnsKeysetIndex.ts";
import Migration0040 from "./Migrations/040_ProjectionThreadsPinOrderKey.ts";
import Migration0041 from "./Migrations/041_ProjectionProjectsDefaultThreadEnvMode.ts";
import Migration0042 from "./Migrations/042_ProjectionProjectFaviconPath.ts";
import Migration0043 from "./Migrations/043_AuthSessionClientConnection.ts";
import Migration0044 from "./Migrations/044_ProjectionThreadLinkedPullRequest.ts";
import Migration0045 from "./Migrations/045_ProjectionThreadsUnsettledAt.ts";
import Migration0046 from "./Migrations/046_ClearAutomaticProjectModelDefaults.ts";
import Migration0047 from "./Migrations/047_ProjectionProjectsAutoPull.ts";
import Migration0048 from "./Migrations/048_RepairAutomaticSettlementTimestamps.ts";
import Migration0049 from "./Migrations/049_ProjectionProjectIcon.ts";
import Migration0050 from "./Migrations/050_ProjectionThreadBranchPullRequest.ts";
import Migration0051 from "./Migrations/051_ProjectionThreadsActiveOrderKey.ts";
import Migration0052 from "./Migrations/052_ProjectionThreadPullRequests.ts";
import Migration0053 from "./Migrations/053_ProjectionThreadMessageContext.ts";
import Migration0054 from "./Migrations/054_ProjectionThreadTitleState.ts";
import Migration0055 from "./Migrations/055_PullRequestFilesViewed.ts";
import Migration0056 from "./Migrations/056_ProjectionThreadsAutoSettleDisabledAt.ts";

/**
 * Migration loader with all migrations defined inline.
 *
 * Key format: "{id}_{name}" where:
 * - id: numeric migration ID (determines execution order)
 * - name: descriptive name for the migration
 *
 * Uses Migrator.fromRecord which parses the key format and
 * returns migrations sorted by ID.
 */
const migrationEntries = [
  [1, "OrchestrationEvents", Migration0001],
  [2, "OrchestrationCommandReceipts", Migration0002],
  [3, "CheckpointDiffBlobs", Migration0003],
  [4, "ProviderSessionRuntime", Migration0004],
  [5, "Projections", Migration0005],
  [6, "ProjectionThreadSessionRuntimeModeColumns", Migration0006],
  [7, "ProjectionThreadMessageAttachments", Migration0007],
  [8, "ProjectionThreadActivitySequence", Migration0008],
  [9, "ProviderSessionRuntimeMode", Migration0009],
  [10, "ProjectionThreadsRuntimeMode", Migration0010],
  [11, "OrchestrationThreadCreatedRuntimeMode", Migration0011],
  [12, "ProjectionThreadsInteractionMode", Migration0012],
  [13, "ProjectionThreadProposedPlans", Migration0013],
  [14, "ProjectionThreadProposedPlanImplementation", Migration0014],
  [15, "ProjectionTurnsSourceProposedPlan", Migration0015],
  [16, "CanonicalizeModelSelections", Migration0016],
  [17, "ProjectionThreadsArchivedAt", Migration0017],
  [18, "ProjectionThreadsArchivedAtIndex", Migration0018],
  [19, "ProjectionSnapshotLookupIndexes", Migration0019],
  [20, "AuthAccessManagement", Migration0020],
  [21, "AuthSessionClientMetadata", Migration0021],
  [22, "AuthSessionLastConnectedAt", Migration0022],
  [23, "ProjectionThreadShellSummary", Migration0023],
  [24, "BackfillProjectionThreadShellSummary", Migration0024],
  [25, "CleanupInvalidProjectionPendingApprovals", Migration0025],
  [26, "CanonicalizeModelSelectionOptions", Migration0026],
  [27, "ProviderSessionRuntimeInstanceId", Migration0027],
  [28, "ProjectionThreadSessionInstanceId", Migration0028],
  [29, "ProjectionThreadDetailOrderingIndexes", Migration0029],
  [30, "ProjectionThreadShellArchiveIndexes", Migration0030],
  [31, "AuthAuthorizationScopes", Migration0031],
  [32, "AuthPairingProofKeyThumbprint", Migration0032],
  [33, "ProjectionThreadsSettled", Migration0033],
  [34, "ProjectionThreadsSnoozed", Migration0034],
  [35, "ProjectionThreadTitleRegeneration", Migration0035],
  // ID-SPACE RULING (2026-08-08 upstream merge, extended 2026-10-02): the
  // fork and upstream both minted ids 36-38 independently. The fork's ids
  // stay where every actually-deployed DevGame database already recorded them
  // (36/37 spaces), and every upstream migration from upstream-036 on runs at
  // upstream id + 2 (upstream 036-038 -> 38-40, upstream 039-054 -> 41-56).
  // A database migrated by STOCK T3 Code records different names under the
  // same ids; `runMigrations` refuses such a ledger up front
  // (MigrationLedgerMismatchError) instead of silently skipping migrations.
  [36, "ProjectionThreadsSpaceAndTaskRef", Migration0036],
  [37, "ProjectionSpaces", Migration0037],
  [38, "ProjectionThreadsPinned", Migration0038],
  [39, "ProjectionTurnsKeysetIndex", Migration0039],
  [40, "ProjectionThreadsPinOrderKey", Migration0040],
  [41, "ProjectionProjectsDefaultThreadEnvMode", Migration0041],
  [42, "ProjectionProjectFaviconPath", Migration0042],
  [43, "AuthSessionClientConnection", Migration0043],
  [44, "ProjectionThreadLinkedPullRequest", Migration0044],
  [45, "ProjectionThreadsUnsettledAt", Migration0045],
  [46, "ClearAutomaticProjectModelDefaults", Migration0046],
  [47, "ProjectionProjectsAutoPull", Migration0047],
  [48, "RepairAutomaticSettlementTimestamps", Migration0048],
  [49, "ProjectionProjectIcon", Migration0049],
  [50, "ProjectionThreadBranchPullRequest", Migration0050],
  [51, "ProjectionThreadsActiveOrderKey", Migration0051],
  [52, "ProjectionThreadPullRequests", Migration0052],
  [53, "ProjectionThreadMessageContext", Migration0053],
  [54, "ProjectionThreadTitleState", Migration0054],
  [55, "PullRequestFilesViewed", Migration0055],
  [56, "ProjectionThreadsAutoSettleDisabledAt", Migration0056],
] as const;

export const migrationManifest = migrationEntries.map(([id, name]) => [id, name] as const);

const makeMigrationLoader = (throughId?: number) =>
  Migrator.fromRecord(
    Object.fromEntries(
      migrationEntries
        .filter(([id]) => throughId === undefined || id <= throughId)
        .map(([id, name, migration]) => [`${id}_${name}`, migration]),
    ),
  );

/**
 * Migrator run function - no schema dumping needed
 * Uses the base Migrator.make without platform dependencies
 */
const run = Migrator.make({});

const MIGRATIONS_TABLE = "effect_sql_migrations";

const MigrationLedgerMismatch = Schema.Struct({
  id: Schema.Number,
  recordedName: Schema.String,
  expectedName: Schema.String,
});
type MigrationLedgerMismatch = typeof MigrationLedgerMismatch.Type;

/**
 * The database's migration ledger records a different migration under an id
 * this build's manifest uses. Migrator only runs ids above the highest
 * recorded one, so continuing would silently skip this build's migrations at
 * those ids — the typical cause is a database last migrated by stock T3 Code,
 * whose ids 36+ name different migrations than DevGame's (see the ID-SPACE
 * RULING above). Nothing is migrated or rewritten when this fails.
 */
export class MigrationLedgerMismatchError extends Schema.TaggedError<MigrationLedgerMismatchError>()(
  "MigrationLedgerMismatchError",
  {
    mismatches: Schema.Array(MigrationLedgerMismatch),
  },
) {
  override get message(): string {
    const details = this.mismatches
      .map(
        (mismatch) =>
          `id ${mismatch.id}: database recorded "${mismatch.recordedName}", this build expects "${mismatch.expectedName}"`,
      )
      .join("; ");
    return `Refusing to migrate: the database's migration ledger does not match this build (${details}). It was likely migrated by a stock upstream build; point DevGame at its own data directory.`;
  }
}

/** Pure comparison of recorded ledger rows against the manifest. Ids the
 * manifest does not know are not compared: there is no expected name. */
export const findMigrationLedgerMismatches = (
  recorded: ReadonlyArray<{ readonly id: number; readonly name: string }>,
): ReadonlyArray<MigrationLedgerMismatch> => {
  const expectedById = new Map<number, string>(migrationManifest);
  return recorded.flatMap(({ id, name }) => {
    const expectedName = expectedById.get(id);
    return expectedName !== undefined && expectedName !== name
      ? [{ id, recordedName: name, expectedName }]
      : [];
  });
};

/** Read-only check of an existing ledger; a fresh database has no table. */
const assertMigrationLedgerMatchesManifest = Effect.fn("assertMigrationLedgerMatchesManifest")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const ledgerTables = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${MIGRATIONS_TABLE}
    `;
    if (ledgerTables.length === 0) {
      return;
    }
    const recorded = yield* sql<{ readonly migrationId: number; readonly name: string }>`
      SELECT migration_id AS "migrationId", name FROM effect_sql_migrations ORDER BY migration_id
    `;
    const mismatches = findMigrationLedgerMismatches(
      recorded.map((row) => ({ id: Number(row.migrationId), name: row.name })),
    );
    if (mismatches.length > 0) {
      return yield* new MigrationLedgerMismatchError({ mismatches });
    }
  },
);

export interface RunMigrationsOptions {
  readonly toMigrationInclusive?: number | undefined;
}

/**
 * Run all pending migrations.
 *
 * First verifies that every migration already recorded in the tracking table
 * (effect_sql_migrations) carries the name this build expects for its id, and
 * fails with `MigrationLedgerMismatchError` otherwise. Then creates the
 * tracking table if it doesn't exist and runs any migrations with ID greater
 * than the latest recorded migration.
 *
 * Returns array of [id, name] tuples for migrations that were run.
 *
 * @returns Effect containing array of executed migrations
 */
export const runMigrations = Effect.fn("runMigrations")(function* ({
  toMigrationInclusive,
}: RunMigrationsOptions = {}) {
  yield* assertMigrationLedgerMatchesManifest();
  const executedMigrations = yield* run({ loader: makeMigrationLoader(toMigrationInclusive) });
  const migrations = executedMigrations.map(([id, name]) => `${id}_${name}`);
  yield* migrations.length === 0
    ? Effect.logDebug("Database schema is current")
    : Effect.log("Migrations ran successfully").pipe(Effect.annotateLogs({ migrations }));
  return executedMigrations;
});
