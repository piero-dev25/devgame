import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionSpaceInput,
  GetProjectionSpaceInput,
  ProjectionSpace,
  ProjectionSpaceRepository,
  type ProjectionSpaceRepositoryShape,
} from "../Services/ProjectionSpaces.ts";

const makeProjectionSpaceRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionSpaceRow = SqlSchema.void({
    Request: ProjectionSpace,
    execute: (row) =>
      sql`
        INSERT INTO projection_spaces (
          space_id,
          project_id,
          title,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          ${row.spaceId},
          ${row.projectId},
          ${row.title},
          ${row.createdAt},
          ${row.updatedAt},
          ${row.deletedAt}
        )
        ON CONFLICT (space_id)
        DO UPDATE SET
          project_id = excluded.project_id,
          title = excluded.title,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          deleted_at = excluded.deleted_at
      `,
  });

  const getProjectionSpaceRow = SqlSchema.findOneOption({
    Request: GetProjectionSpaceInput,
    Result: ProjectionSpace,
    execute: ({ spaceId }) =>
      sql`
        SELECT
          space_id AS "spaceId",
          project_id AS "projectId",
          title,
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_spaces
        WHERE space_id = ${spaceId}
      `,
  });

  const listProjectionSpaceRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionSpace,
    execute: () =>
      sql`
        SELECT
          space_id AS "spaceId",
          project_id AS "projectId",
          title,
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_spaces
        ORDER BY created_at ASC, space_id ASC
      `,
  });

  const deleteProjectionSpaceRow = SqlSchema.void({
    Request: DeleteProjectionSpaceInput,
    execute: ({ spaceId }) =>
      sql`
        DELETE FROM projection_spaces
        WHERE space_id = ${spaceId}
      `,
  });

  const upsert: ProjectionSpaceRepositoryShape["upsert"] = (row) =>
    upsertProjectionSpaceRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionSpaceRepository.upsert:query")),
    );

  const getById: ProjectionSpaceRepositoryShape["getById"] = (input) =>
    getProjectionSpaceRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionSpaceRepository.getById:query")),
    );

  const listAll: ProjectionSpaceRepositoryShape["listAll"] = () =>
    listProjectionSpaceRows().pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionSpaceRepository.listAll:query")),
    );

  const deleteById: ProjectionSpaceRepositoryShape["deleteById"] = (input) =>
    deleteProjectionSpaceRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionSpaceRepository.deleteById:query")),
    );

  return {
    upsert,
    getById,
    listAll,
    deleteById,
  } satisfies ProjectionSpaceRepositoryShape;
});

export const ProjectionSpaceRepositoryLive = Layer.effect(
  ProjectionSpaceRepository,
  makeProjectionSpaceRepository,
);
