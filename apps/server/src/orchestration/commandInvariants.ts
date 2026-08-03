import type {
  OrchestrationCommand,
  OrchestrationProject,
  OrchestrationReadModel,
  OrchestrationSpace,
  OrchestrationThread,
  ProjectId,
  SpaceId,
  ThreadId,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Effect from "effect/Effect";

import { OrchestrationCommandInvariantError } from "./Errors.ts";

function invariantError(commandType: string, detail: string): OrchestrationCommandInvariantError {
  return new OrchestrationCommandInvariantError({
    commandType,
    detail,
  });
}

export function findThreadById(
  readModel: OrchestrationReadModel,
  threadId: ThreadId,
): OrchestrationThread | undefined {
  return readModel.threads.find((thread) => thread.id === threadId);
}

export function findProjectById(
  readModel: OrchestrationReadModel,
  projectId: ProjectId,
): OrchestrationProject | undefined {
  return readModel.projects.find((project) => project.id === projectId);
}

export function listThreadsByProjectId(
  readModel: OrchestrationReadModel,
  projectId: ProjectId,
): ReadonlyArray<OrchestrationThread> {
  return readModel.threads.filter((thread) => thread.projectId === projectId);
}

export function requireProject(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly projectId: ProjectId;
}): Effect.Effect<OrchestrationProject, OrchestrationCommandInvariantError> {
  const project = findProjectById(input.readModel, input.projectId);
  if (project) {
    return Effect.succeed(project);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Project '${input.projectId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

export function requireProjectAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly projectId: ProjectId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (!findProjectById(input.readModel, input.projectId)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Project '${input.projectId}' already exists and cannot be created twice.`,
    ),
  );
}

export function requireActiveProjectWorkspaceRootAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly workspaceRoot: string;
  readonly exceptProjectId?: ProjectId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  const normalizedWorkspaceRoot = normalizeProjectPathForComparison(input.workspaceRoot);
  const existingProject = input.readModel.projects.find(
    (project) =>
      project.deletedAt === null &&
      normalizeProjectPathForComparison(project.workspaceRoot) === normalizedWorkspaceRoot &&
      project.id !== input.exceptProjectId,
  );
  if (existingProject === undefined) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Active project '${existingProject.id}' already exists for workspace root '${normalizedWorkspaceRoot}'.`,
    ),
  );
}

// NOT to be confused with requireActiveProjectWorkspaceRootAbsent above: that
// one concerns a PROJECT's filesystem root (a `workspace_root` column) and is
// unrelated. This one concerns the `space` aggregate — a context SCOPE, not
// a filesystem thing. Sharing the "workspace" word between these two
// concepts in this repo is a naming collision, not a relationship.
export function findSpaceById(
  readModel: OrchestrationReadModel,
  spaceId: SpaceId,
): OrchestrationSpace | undefined {
  return (readModel.spaces ?? []).find((space) => space.id === spaceId);
}

export function requireSpaceAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly spaceId: SpaceId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (!findSpaceById(input.readModel, input.spaceId)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Space '${input.spaceId}' already exists and cannot be created twice.`,
    ),
  );
}

/**
 * The one genuinely new invariant this step adds: a non-null `space_id` on a
 * thread command must reference a space that exists. A soft-deleted space
 * (deletedAt !== null) does not count as existing here — the same
 * "deletedAt means gone" convention used everywhere else in this codebase's
 * active-listing queries. Deliberately NOT checked: that the space belongs
 * to the thread's project (cross-project references are legal by design).
 */
export function requireActiveSpaceForReference(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly spaceId: SpaceId;
}): Effect.Effect<OrchestrationSpace, OrchestrationCommandInvariantError> {
  const space = findSpaceById(input.readModel, input.spaceId);
  if (space && space.deletedAt === null) {
    return Effect.succeed(space);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Space '${input.spaceId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

/**
 * Existence check for space.delete. Deliberately does NOT cascade or even
 * look at threads: deleting a space must never delete or reject based on the
 * threads that reference it (see spec-wave-1-step-2.md). Threads referencing
 * a deleted space are unscoped (space_id -> null) by the projector as a
 * read-model side effect of the space.deleted event, never by a compensating
 * command/event of their own.
 */
export function requireSpace(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly spaceId: SpaceId;
}): Effect.Effect<OrchestrationSpace, OrchestrationCommandInvariantError> {
  const space = findSpaceById(input.readModel, input.spaceId);
  if (space) {
    return Effect.succeed(space);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Space '${input.spaceId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

export function requireThread(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  const thread = findThreadById(input.readModel, input.threadId);
  if (thread) {
    return Effect.succeed(thread);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Thread '${input.threadId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

export function requireThreadArchived(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  return requireThread(input).pipe(
    Effect.flatMap((thread) =>
      thread.archivedAt !== null
        ? Effect.succeed(thread)
        : Effect.fail(
            invariantError(
              input.command.type,
              `Thread '${input.threadId}' is not archived for command '${input.command.type}'.`,
            ),
          ),
    ),
  );
}

export function requireThreadNotArchived(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  return requireThread(input).pipe(
    Effect.flatMap((thread) =>
      thread.archivedAt === null
        ? Effect.succeed(thread)
        : Effect.fail(
            invariantError(
              input.command.type,
              `Thread '${input.threadId}' is already archived and cannot handle command '${input.command.type}'.`,
            ),
          ),
    ),
  );
}

export function requireThreadAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (!findThreadById(input.readModel, input.threadId)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Thread '${input.threadId}' already exists and cannot be created twice.`,
    ),
  );
}

export function requireNonNegativeInteger(input: {
  readonly commandType: OrchestrationCommand["type"];
  readonly field: string;
  readonly value: number;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (Number.isInteger(input.value) && input.value >= 0) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.commandType,
      `${input.field} must be an integer greater than or equal to 0.`,
    ),
  );
}
