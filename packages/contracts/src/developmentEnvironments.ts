import * as Schema from "effect/Schema";

import { CommandId, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  OrchestrationV2DevelopmentEnvironmentUsage,
  OrchestrationV2ThreadDevelopmentEnvironment,
} from "./orchestrationV2.ts";
import { XwingEnvironmentId, XwingListError } from "./xwingEnvironments.ts";

/** One Xwing environment's checkout of a project, as the server resolved it on its own machine. */
export const DevelopmentEnvironmentCheckoutChoice = Schema.Struct({
  xwingEnvironmentId: XwingEnvironmentId,
  number: Schema.optional(Schema.Number),
  name: Schema.String,
  ticket: Schema.optional(Schema.String),
  repositoryName: Schema.String,
  branch: Schema.String,
  /** The project's folder inside the environment's checkout. */
  checkoutPath: Schema.String,
});
export type DevelopmentEnvironmentCheckoutChoice = typeof DevelopmentEnvironmentCheckoutChoice.Type;

export const DevelopmentEnvironmentListCheckoutsInput = Schema.Struct({
  projectId: ProjectId,
});
export type DevelopmentEnvironmentListCheckoutsInput =
  typeof DevelopmentEnvironmentListCheckoutsInput.Type;

export const DevelopmentEnvironmentListUsageInput = Schema.Struct({
  xwingEnvironmentId: Schema.optional(XwingEnvironmentId),
  threadId: Schema.optional(ThreadId),
  includeDescendants: Schema.optional(Schema.Boolean),
});
export type DevelopmentEnvironmentListUsageInput = typeof DevelopmentEnvironmentListUsageInput.Type;

export const DevelopmentEnvironmentUsageList = Schema.Array(
  OrchestrationV2DevelopmentEnvironmentUsage,
);

/**
 * Moves a stopped thread into an Xwing environment's checkout of its project. Rejected unless the
 * thread still works in `expected`, so a client acting on a stale view changes nothing.
 */
export const DevelopmentEnvironmentSelectCheckoutInput = Schema.Struct({
  threadId: ThreadId,
  /** Reusing an id replays the first selection instead of selecting again. */
  commandId: CommandId,
  expected: Schema.Struct({
    worktreePath: Schema.NullOr(TrimmedNonEmptyString),
    xwingEnvironmentId: Schema.NullOr(TrimmedNonEmptyString),
  }),
  xwingEnvironmentId: XwingEnvironmentId,
});
export type DevelopmentEnvironmentSelectCheckoutInput =
  typeof DevelopmentEnvironmentSelectCheckoutInput.Type;

/**
 * When `changed`, idle terminals and provider sessions of the previous checkout were closed;
 * clients drop launch state kept for it.
 */
export const DevelopmentEnvironmentSelectCheckoutResult = Schema.Struct({
  changed: Schema.Boolean,
  sequence: Schema.Number,
  worktreePath: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  developmentEnvironment: Schema.NullOr(
    OrchestrationV2ThreadDevelopmentEnvironment.mapFields((environment) => ({
      ...environment,
      selectedAt: Schema.DateTimeUtcFromString,
      releasedAt: Schema.optional(Schema.DateTimeUtcFromString),
    })),
  ),
});
export type DevelopmentEnvironmentSelectCheckoutResult =
  typeof DevelopmentEnvironmentSelectCheckoutResult.Type;

export class DevelopmentEnvironmentSelectionRejectedError extends Schema.TaggedError<DevelopmentEnvironmentSelectionRejectedError>()(
  "DevelopmentEnvironmentSelectionRejectedError",
  {
    threadId: ThreadId,
    reason: Schema.Literals([
      "thread-not-found",
      "provider-native-subagent",
      "deleted",
      "project-missing",
      "workspace-changed",
      "work-in-progress",
    ]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "provider-native-subagent":
        return "A provider-native subagent uses its parent conversation's folder. Change folder on the parent thread instead.";
      case "thread-not-found":
        return "This thread does not exist.";
      case "deleted":
        return "This thread was deleted.";
      case "project-missing":
        return "This thread's project no longer exists.";
      case "workspace-changed":
        return "This thread's checkout changed. Review the current checkout and try again.";
      case "work-in-progress":
        return "This thread still has work in progress: a turn, a request, a rollback, background agents, or a terminal command. Stop it or let it finish before changing checkout.";
    }
  }
}

export class DevelopmentEnvironmentCheckoutUnavailableError extends Schema.TaggedError<DevelopmentEnvironmentCheckoutUnavailableError>()(
  "DevelopmentEnvironmentCheckoutUnavailableError",
  {
    xwingEnvironmentId: Schema.String,
    reason: Schema.Literals([
      "environment-missing",
      "repository-missing",
      "checkout-missing",
      "xwing-unavailable",
      "hold-unavailable",
    ]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "environment-missing":
        return "Xwing has no such development environment; it may have been archived or removed.";
      case "repository-missing":
        return "This development environment has no checkout of the thread's project repository.";
      case "checkout-missing":
        return "This development environment's checkout is missing on disk. Repair it with Xwing.";
      case "xwing-unavailable":
        return "Xwing could not be reached to resolve the development environment.";
      case "hold-unavailable":
        return "Xwing could not record that this thread uses the environment, so the thread was not bound to it. Update Xwing to a version with environment holds and try again.";
    }
  }
}

export class DevelopmentEnvironmentProjectNotFoundError extends Schema.TaggedError<DevelopmentEnvironmentProjectNotFoundError>()(
  "DevelopmentEnvironmentProjectNotFoundError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return "This project no longer exists.";
  }
}

export class DevelopmentEnvironmentPersistenceError extends Schema.TaggedError<DevelopmentEnvironmentPersistenceError>()(
  "DevelopmentEnvironmentPersistenceError",
  {
    operation: Schema.Literals(["read-thread", "select-workspace", "list-usage", "unlink"]),
  },
) {
  override get message(): string {
    return `Development environment ${this.operation.replaceAll("-", " ")} failed.`;
  }
}

export const DevelopmentEnvironmentSelectError = Schema.Union([
  DevelopmentEnvironmentSelectionRejectedError,
  DevelopmentEnvironmentCheckoutUnavailableError,
  DevelopmentEnvironmentPersistenceError,
]);
export type DevelopmentEnvironmentSelectError = typeof DevelopmentEnvironmentSelectError.Type;

export const DevelopmentEnvironmentListCheckoutsError = Schema.Union([
  ...XwingListError.members,
  DevelopmentEnvironmentProjectNotFoundError,
]);
export type DevelopmentEnvironmentListCheckoutsError =
  typeof DevelopmentEnvironmentListCheckoutsError.Type;

/** Changes an idle thread's next working folder, retaining its conversation. */
export const ThreadChangeFolderInput = Schema.Struct({
  threadId: ThreadId,
  commandId: CommandId,
  expected: Schema.Struct({
    ...DevelopmentEnvironmentSelectCheckoutInput.fields.expected.fields,
    projectId: Schema.optional(ProjectId),
  }),
  folder: TrimmedNonEmptyString,
  xwingEnvironmentId: Schema.optional(XwingEnvironmentId),
});
export type ThreadChangeFolderInput = typeof ThreadChangeFolderInput.Type;

export class ThreadFolderUnavailableError extends Schema.TaggedError<ThreadFolderUnavailableError>()(
  "ThreadFolderUnavailableError",
  { folder: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return "Choose an existing folder on this machine.";
  }
}

export const ThreadChangeFolderError = Schema.Union([
  ...DevelopmentEnvironmentSelectError.members,
  ThreadFolderUnavailableError,
]);
export type ThreadChangeFolderError = typeof ThreadChangeFolderError.Type;

export const DevelopmentEnvironmentUnlinkInput = Schema.Struct({
  commandId: CommandId,
  threadId: ThreadId,
  xwingEnvironmentId: XwingEnvironmentId,
});
export type DevelopmentEnvironmentUnlinkInput = typeof DevelopmentEnvironmentUnlinkInput.Type;
