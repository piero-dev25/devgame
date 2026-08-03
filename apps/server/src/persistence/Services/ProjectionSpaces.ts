/**
 * ProjectionSpaceRepository - Projection repository interface for spaces.
 *
 * Owns persistence operations for space rows (the `space` aggregate — a
 * context SCOPE, not a container; see docs/workbench/spec-wave-1-step-2.md)
 * in the orchestration projection read model.
 *
 * @module ProjectionSpaceRepository
 */
import { IsoDateTime, ProjectId, SpaceId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionSpace = Schema.Struct({
  spaceId: SpaceId,
  projectId: ProjectId,
  title: Schema.String,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectionSpace = typeof ProjectionSpace.Type;

export const GetProjectionSpaceInput = Schema.Struct({
  spaceId: SpaceId,
});
export type GetProjectionSpaceInput = typeof GetProjectionSpaceInput.Type;

export const DeleteProjectionSpaceInput = Schema.Struct({
  spaceId: SpaceId,
});
export type DeleteProjectionSpaceInput = typeof DeleteProjectionSpaceInput.Type;

/**
 * ProjectionSpaceRepositoryShape - Service API for projected space records.
 */
export interface ProjectionSpaceRepositoryShape {
  /**
   * Insert or replace a projected space row.
   *
   * Upserts by `spaceId`. Space deletion is projected through this method
   * (setting `deletedAt`), the same soft-delete pattern projects use —
   * never a cascade into `projection_threads`.
   */
  readonly upsert: (row: ProjectionSpace) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Read a projected space row by id.
   */
  readonly getById: (
    input: GetProjectionSpaceInput,
  ) => Effect.Effect<Option.Option<ProjectionSpace>, ProjectionRepositoryError>;

  /**
   * List all projected space rows.
   *
   * Returned in deterministic creation order.
   */
  readonly listAll: () => Effect.Effect<ReadonlyArray<ProjectionSpace>, ProjectionRepositoryError>;

  /**
   * Hard-delete a projected space row by id. Not used by the space.deleted
   * projection (which soft-deletes via upsert); kept for parity with
   * ProjectionProjectRepository's shape.
   */
  readonly deleteById: (
    input: DeleteProjectionSpaceInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

/**
 * ProjectionSpaceRepository - Service tag for space projection persistence.
 */
export class ProjectionSpaceRepository extends Context.Service<
  ProjectionSpaceRepository,
  ProjectionSpaceRepositoryShape
>()("t3/persistence/Services/ProjectionSpaces/ProjectionSpaceRepository") {}
