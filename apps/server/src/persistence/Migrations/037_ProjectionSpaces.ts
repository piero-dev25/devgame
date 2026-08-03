import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

// New table for a new aggregate — the `space` aggregate itself. See
// docs/workbench/spec-wave-1-step-2.md. `orchestration_events` needs no
// migration (it is keyed generically on aggregate_kind/stream_id/
// stream_version — Migrations/001_OrchestrationEvents.ts), which is exactly
// what makes a third aggregate additive here.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_spaces (
      space_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_spaces_project_id
    ON projection_spaces(project_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_spaces_updated_at
    ON projection_spaces(updated_at)
  `;
});
