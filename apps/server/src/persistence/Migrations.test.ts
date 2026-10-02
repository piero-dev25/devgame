import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "./Migrations.ts";

const withFreshDatabase = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })));

const readLedger = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly migrationId: number; readonly name: string }>`
    SELECT migration_id AS "migrationId", name FROM effect_sql_migrations ORDER BY migration_id
  `;
  return rows.map((row) => [Number(row.migrationId), row.name] as const);
});

const columnNames = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const columns = yield* sql<{ readonly name: string }>`
      SELECT name FROM pragma_table_info(${table})
    `;
    return new Set(columns.map((column) => column.name));
  });

const tableExists = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${table}
    `;
    return rows.length === 1;
  });

it.effect(
  "refuses a database whose ledger uses stock T3 numbering, without migrating or rewriting it",
  () =>
    withFreshDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // Ids 1-35 are shared with upstream. A stock build then recorded its
        // own 36-38, which DevGame runs at 38-40.
        yield* runMigrations({ toMigrationInclusive: 35 });
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name) VALUES
            (36, 'ProjectionThreadsPinned'),
            (37, 'ProjectionTurnsKeysetIndex'),
            (38, 'ProjectionThreadsPinOrderKey')
        `;
        const ledgerBefore = yield* readLedger;

        const error = yield* runMigrations().pipe(Effect.flip);

        assert.strictEqual(error._tag, "MigrationLedgerMismatchError");
        if (error._tag !== "MigrationLedgerMismatchError") return;
        assert.deepStrictEqual(error.mismatches, [
          {
            id: 36,
            recordedName: "ProjectionThreadsPinned",
            expectedName: "ProjectionThreadsSpaceAndTaskRef",
          },
          { id: 37, recordedName: "ProjectionTurnsKeysetIndex", expectedName: "ProjectionSpaces" },
          {
            id: 38,
            recordedName: "ProjectionThreadsPinOrderKey",
            expectedName: "ProjectionThreadsPinned",
          },
        ]);
        assert.include(error.message, "id 36");
        assert.include(error.message, "id 38");

        // Never silently skip, never mutate: the ledger is untouched and the
        // fork's space schema was not half-applied.
        assert.deepStrictEqual(yield* readLedger, ledgerBefore);
        assert.isFalse(yield* tableExists("projection_spaces"));
        assert.isFalse((yield* columnNames("projection_threads")).has("space_id"));
      }),
    ),
);

it.effect("migrates a fork-numbered database through upstream's shifted ids 41-56", () =>
  withFreshDatabase(
    Effect.gen(function* () {
      // A DevGame database as deployed before this merge: fork ids 36/37 plus
      // upstream 036-038 at 38-40.
      yield* runMigrations({ toMigrationInclusive: 40 });
      assert.isTrue((yield* columnNames("projection_threads")).has("space_id"));
      assert.isTrue(yield* tableExists("projection_spaces"));

      const executed = yield* runMigrations();

      assert.deepStrictEqual(
        executed.map(([id, name]) => [id, name]),
        [
          [41, "ProjectionProjectsDefaultThreadEnvMode"],
          [42, "ProjectionProjectFaviconPath"],
          [43, "AuthSessionClientConnection"],
          [44, "ProjectionThreadLinkedPullRequest"],
          [45, "ProjectionThreadsUnsettledAt"],
          [46, "ClearAutomaticProjectModelDefaults"],
          [47, "ProjectionProjectsAutoPull"],
          [48, "RepairAutomaticSettlementTimestamps"],
          [49, "ProjectionProjectIcon"],
          [50, "ProjectionThreadBranchPullRequest"],
          [51, "ProjectionThreadsActiveOrderKey"],
          [52, "ProjectionThreadPullRequests"],
          [53, "ProjectionThreadMessageContext"],
          [54, "ProjectionThreadTitleState"],
          [55, "PullRequestFilesViewed"],
          [56, "ProjectionThreadsAutoSettleDisabledAt"],
        ],
      );
      const projectColumns = yield* columnNames("projection_projects");
      assert.isTrue(projectColumns.has("default_thread_env_mode"));
      assert.isTrue(projectColumns.has("project_icon_json"));
      const threadColumns = yield* columnNames("projection_threads");
      assert.isTrue(threadColumns.has("space_id"));
      assert.isTrue(threadColumns.has("task_ref_json"));
      assert.isTrue(threadColumns.has("auto_settle_disabled_at"));
      assert.isTrue(yield* tableExists("projection_thread_pull_requests"));

      // A second boot over the fully migrated fork ledger passes the guard
      // and has nothing left to run.
      assert.deepStrictEqual(yield* runMigrations(), []);
    }),
  ),
);
