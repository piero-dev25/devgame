import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("038_ProjectionThreadsPinned", (it) => {
  it.effect("adds pinning after the fork's space migrations without reusing an applied id", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 37 });
      yield* runMigrations({ toMigrationInclusive: 38 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      const names = new Set(columns.map((column) => column.name));
      assert.ok(names.has("space_id"));
      assert.ok(names.has("task_ref_json"));
      assert.ok(names.has("pinned_at"));

      const spacesTable = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projection_spaces'
      `;
      assert.lengthOf(spacesTable, 1);
    }),
  );
});
