/**
 * ProjectionThreadRepository - Projection repository interface for threads.
 *
 * Owns persistence operations for projected thread records in the
 * orchestration read model.
 *
 * @module ProjectionThreadRepository
 */
import {
  CommandId,
  IsoDateTime,
  ModelSelection,
  NonNegativeInt,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadLinkedPullRequest,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

/**
 * SQLite has no boolean type; boolean columns round-trip as INTEGER 0/1. This
 * codec decodes the stored integer to a boolean and encodes back, so the
 * decoded row Type stays boolean (matching the wire contract) while the DB
 * column stays an integer. The DbRow overrides in the Layers reuse this so a
 * spread of a decoded row back into an upsert row still type-checks.
 */
export const BooleanFromSqliteInt = Schema.Int.pipe(
  Schema.decodeTo(
    Schema.Boolean,
    SchemaTransformation.transform<boolean, number>({
      decode: (value) => value === 1,
      encode: (value) => (value ? 1 : 0),
    }),
  ),
);

export const ProjectionThread = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  linkedPullRequest: Schema.optional(Schema.NullOr(ThreadLinkedPullRequest)),
  branchPullRequest: Schema.optional(Schema.NullOr(ThreadLinkedPullRequest)),
  latestTurnId: Schema.NullOr(TurnId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
  settledOverride: Schema.NullOr(Schema.Literals(["settled", "active"])),
  settledAt: Schema.NullOr(IsoDateTime),
  unsettledAt: Schema.NullOr(IsoDateTime),
  snoozedUntil: Schema.NullOr(IsoDateTime),
  snoozedAt: Schema.NullOr(IsoDateTime),
  pinnedAt: Schema.NullOr(IsoDateTime),
  pinOrderKey: Schema.optional(Schema.NullOr(Schema.String)),
  // Fork-local classification metadata. Unconstrained non-empty strings today
  // (the wire contract rejects empty/whitespace); a runtime-config taxonomy to
  // constrain the allowed values is planned but does not exist yet. This
  // read-side schema stays permissive. Optional so rows written before the
  // columns existed still decode.
  workType: Schema.optional(Schema.NullOr(Schema.String)),
  stage: Schema.optional(Schema.NullOr(Schema.String)),
  // Whether the user pinned the stage manually (locking out auto re-assessment).
  // Stored as INTEGER 0/1 in SQLite, decoded to boolean. Optional so rows written
  // before the column existed still decode.
  stageManual: Schema.optional(Schema.NullOr(BooleanFromSqliteInt)),
  activeOrderKey: Schema.optional(Schema.NullOr(Schema.String)),
  titleRegenerationRequestId: Schema.optional(Schema.NullOr(CommandId)),
  titleRegenerationStartedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  latestUserMessageAt: Schema.NullOr(IsoDateTime),
  pendingApprovalCount: NonNegativeInt,
  pendingUserInputCount: NonNegativeInt,
  hasActionableProposedPlan: NonNegativeInt,
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectionThread = typeof ProjectionThread.Type;

export const GetProjectionThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type GetProjectionThreadInput = typeof GetProjectionThreadInput.Type;

export const DeleteProjectionThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionThreadInput = typeof DeleteProjectionThreadInput.Type;

export const ListProjectionThreadsByProjectInput = Schema.Struct({
  projectId: ProjectId,
});
export type ListProjectionThreadsByProjectInput = typeof ListProjectionThreadsByProjectInput.Type;

/**
 * ProjectionThreadRepositoryShape - Service API for projected thread records.
 */
export interface ProjectionThreadRepositoryShape {
  /**
   * Insert or replace a projected thread row.
   *
   * Upserts by `threadId`.
   */
  readonly upsert: (thread: ProjectionThread) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Read a projected thread row by id.
   */
  readonly getById: (
    input: GetProjectionThreadInput,
  ) => Effect.Effect<Option.Option<ProjectionThread>, ProjectionRepositoryError>;

  /**
   * List projected threads for a project.
   *
   * Returned in deterministic creation order.
   */
  readonly listByProjectId: (
    input: ListProjectionThreadsByProjectInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThread>, ProjectionRepositoryError>;

  /**
   * Soft-delete a projected thread row by id.
   */
  readonly deleteById: (
    input: DeleteProjectionThreadInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

/**
 * ProjectionThreadRepository - Service tag for thread projection persistence.
 */
export class ProjectionThreadRepository extends Context.Service<
  ProjectionThreadRepository,
  ProjectionThreadRepositoryShape
>()("t3/persistence/Services/ProjectionThreads/ProjectionThreadRepository") {}
