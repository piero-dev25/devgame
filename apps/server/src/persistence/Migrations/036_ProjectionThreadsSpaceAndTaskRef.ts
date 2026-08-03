import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Two nullable columns, added together, and nothing else — see
// docs/workbench/spec-wave-1-step-1.md. `space_id` lands here only as a
// column: no code path reads or writes it yet, because the space aggregate
// this step deliberately does not build. `task_ref_json` is wired all the
// way through contracts / decider / projector / SQL projection / read model
// in this same step, since it's opaque and has no referential dependency.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "space_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN space_id TEXT
    `;
  }

  if (!columns.some((column) => column.name === "task_ref_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN task_ref_json TEXT
    `;
  }
});
