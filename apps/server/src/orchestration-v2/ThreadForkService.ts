import {
  ContextTransferId,
  OrchestrationV2Actor,
  OrchestrationV2AppThread,
  OrchestrationV2ContextSourcePoint,
  OrchestrationV2ContextTransfer,
  OrchestrationV2CreationSource,
  OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  OrchestrationV2ProviderTurnTokenUsage,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
  type SideChatAnchor,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export interface ThreadForkPlanV2 {
  readonly targetThread: OrchestrationV2AppThread;
  readonly transfer: OrchestrationV2ContextTransfer;
}

export class ThreadForkPlanError extends Schema.TaggedError<ThreadForkPlanError>()(
  "ThreadForkPlanError",
  {
    sourceThreadId: ThreadId,
    targetThreadId: ThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/** waiting means provider-finished with checkpoint capture pending. */
export function isForkableSourceRunStatus(status: OrchestrationV2Run["status"]): boolean {
  return (
    status === "completed" ||
    status === "waiting" ||
    status === "failed" ||
    status === "interrupted" ||
    status === "cancelled"
  );
}

export function forkableSourceRunStatusError(
  run: Pick<OrchestrationV2Run, "id" | "status">,
): string {
  return `Fork source run ${run.id} is ${run.status}; in-progress and rolled-back runs cannot be forked.`;
}

/** Codex can atomically fork through a completed turn while a later turn is active. */
export function canForkFromBusySource(
  thread: OrchestrationV2ProviderThread | undefined,
  turn: OrchestrationV2ProviderTurn | undefined,
): boolean {
  return (
    thread?.driver === "codex" &&
    turn?.providerThreadId === thread.id &&
    turn.status === "completed" &&
    turn.nativeTurnRef?.strength === "strong"
  );
}

/** A pending fork transfer; the target thread's next turn resolves it natively or portably. */
export function forkContextTransfer(input: {
  readonly transferId: ContextTransferId;
  readonly sourceThreadId: ThreadId;
  readonly targetThreadId: ThreadId;
  readonly sourceRun: OrchestrationV2Run | null;
  readonly sourceProviderThread: OrchestrationV2ProviderThread | undefined;
  readonly sourceProviderInstanceId: OrchestrationV2ContextTransfer["sourceProviderInstanceId"];
  readonly sourceTokenUsage?: OrchestrationV2ProviderTurnTokenUsage | undefined;
  readonly canonicalSourcePoint: OrchestrationV2ContextSourcePoint;
  readonly createdBy: OrchestrationV2Actor;
  readonly createdAt: DateTime.Utc;
}): OrchestrationV2ContextTransfer {
  const strongNativeSource = input.sourceProviderThread?.nativeThreadRef?.strength === "strong";
  return {
    id: input.transferId,
    type: "fork",
    sourceThreadId: input.sourceThreadId,
    targetThreadId: input.targetThreadId,
    sourcePoint: input.canonicalSourcePoint,
    basePoint: null,
    sourceProviderInstanceId: input.sourceProviderInstanceId,
    // Only native forks retain this context; portable handoffs rebuild it.
    sourceTokenUsage:
      (input.sourceRun?.status === "completed" || input.sourceRun?.status === "waiting") &&
      strongNativeSource
        ? input.sourceTokenUsage
        : undefined,
    targetProviderInstanceId: null,
    targetRunId: null,
    status: "pending",
    resolution: null,
    createdBy: input.createdBy,
    error: strongNativeSource
      ? null
      : "Source provider thread does not expose a strong native thread ref.",
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    consumedAt: null,
  };
}

export interface ThreadForkServiceV2Shape {
  readonly plan: (input: {
    readonly sourceProjection: Pick<OrchestrationV2ThreadProjection, "thread">;
    /** Null only for a side chat whose parent has no stable run yet. */
    readonly sourceRun: OrchestrationV2Run | null;
    readonly sourceProviderThread: OrchestrationV2ProviderThread | undefined;
    readonly sourceTokenUsage?: OrchestrationV2ProviderTurnTokenUsage | undefined;
    readonly canonicalSourcePoint: OrchestrationV2ContextSourcePoint;
    readonly transferId: ContextTransferId;
    readonly targetThreadId: ThreadId;
    readonly title?: string;
    readonly sideChat?: boolean;
    readonly contextArchive?: OrchestrationV2AppThread["lineage"]["contextArchive"];
    readonly sideChatAnchor?: SideChatAnchor;
    readonly createdBy: OrchestrationV2Actor;
    readonly creationSource: OrchestrationV2CreationSource;
    readonly createdAt: DateTime.Utc;
  }) => Effect.Effect<ThreadForkPlanV2, ThreadForkPlanError>;
}

export class ThreadForkServiceV2 extends Context.Service<
  ThreadForkServiceV2,
  ThreadForkServiceV2Shape
>()("t3/orchestration-v2/ThreadForkService/ThreadForkServiceV2") {}

export const layer: Layer.Layer<ThreadForkServiceV2> = Layer.succeed(
  ThreadForkServiceV2,
  ThreadForkServiceV2.of({
    plan: Effect.fn("ThreadForkService.plan")(function* (input) {
      const { sourceRun } = input;
      const sourceLineage = input.sourceProjection.thread.lineage;
      if (
        input.sideChat &&
        sourceLineage.sideChat &&
        input.sideChatAnchor === undefined &&
        input.contextArchive === undefined
      ) {
        return yield* new ThreadForkPlanError({
          sourceThreadId: input.sourceProjection.thread.id,
          targetThreadId: input.targetThreadId,
          cause: "A side chat cannot start another side chat.",
        });
      }
      // A task a linked environment delegated here is a subagent of a remote thread.
      if (
        input.sideChat &&
        (sourceLineage.relationshipToParent === "subagent" ||
          input.sourceProjection.thread.delegatedFrom !== undefined)
      ) {
        return yield* new ThreadForkPlanError({
          sourceThreadId: input.sourceProjection.thread.id,
          targetThreadId: input.targetThreadId,
          cause: "A subagent cannot start a side chat.",
        });
      }
      if (sourceRun !== null && !isForkableSourceRunStatus(sourceRun.status)) {
        return yield* new ThreadForkPlanError({
          sourceThreadId: input.sourceProjection.thread.id,
          targetThreadId: input.targetThreadId,
          cause: forkableSourceRunStatusError(sourceRun),
        });
      }
      // The remote parent delegated the source thread, not its forks.
      const {
        delegatedFrom: _delegatedFrom,
        contextRewind: _contextRewind,
        ...inherited
      } = input.sourceProjection.thread;
      const targetThread: OrchestrationV2AppThread = {
        ...inherited,
        ...(inherited.developmentEnvironment == null
          ? {}
          : {
              developmentEnvironment: {
                ...inherited.developmentEnvironment,
                selectedAt: input.createdAt,
              },
            }),
        // PR context follows the conversation; watching remains the source thread's responsibility.
        pullRequests: input.sourceProjection.thread.pullRequests?.map(
          ({ watch: _watch, ...link }) => link,
        ),
        createdBy: input.createdBy,
        creationSource: input.creationSource,
        id: input.targetThreadId,
        title: input.title ?? `${input.sourceProjection.thread.title} fork`,
        // The source's title job completes only on the source thread.
        titleRegeneration: null,
        activeProviderThreadId: null,
        lineage: {
          parentThreadId: input.sourceProjection.thread.id,
          relationshipToParent: "fork",
          rootThreadId: input.sourceProjection.thread.lineage.rootThreadId,
          ...(input.sideChat ? { sideChat: true } : {}),
          ...(input.contextArchive === undefined ? {} : { contextArchive: input.contextArchive }),
          ...(input.sideChatAnchor === undefined ? {} : { sideChatAnchor: input.sideChatAnchor }),
        },
        forkedFrom:
          sourceRun === null
            ? null
            : { type: "run", threadId: input.sourceProjection.thread.id, runId: sourceRun.id },
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        lastSnoozeWakeAt: null,
        pinnedAt: null,
        pinOrderKey: null,
        activeOrderKey: null,
        autoSettleDisabledAt: null,
        // A guest link belongs to the thread it was made for.
        guestShare: null,
        lastVisitedAt: null,
        // A fork is a new thread; it does not inherit how often the source was opened.
        opens: null,
        deletedAt: null,
      };
      const transfer = forkContextTransfer({
        ...input,
        sourceThreadId: input.sourceProjection.thread.id,
        sourceProviderInstanceId:
          sourceRun?.providerInstanceId ?? input.sourceProjection.thread.providerInstanceId,
      });
      return { targetThread, transfer };
    }),
  }),
);
