import * as Schema from "effect/Schema";
import { ProviderInstanceId } from "./providerInstance.ts";
import {
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ProjectId,
  RunId,
  ThreadId,
  TurnItemId,
} from "./baseSchemas.ts";
import { ProviderInteractionMode } from "./providerPolicy.ts";
import { OrchestrationV2RunStatus } from "./orchestrationV2.ts";

export const InstructionFootprintPart = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  category: Schema.Literals(["t3", "app-context", "custom"]),
  bytes: NonNegativeInt,
  estimatedTokens: NonNegativeInt,
});
export type InstructionFootprintPart = typeof InstructionFootprintPart.Type;
export const InstructionFootprint = Schema.Struct({
  threadId: ThreadId,
  runId: RunId,
  providerInstanceId: ProviderInstanceId,
  driver: Schema.String,
  model: Schema.String,
  capturedAt: IsoDateTime,
  providerTurnOrdinal: Schema.optional(NonNegativeInt),
  attemptId: Schema.optional(Schema.String),
  source: Schema.String,
  parts: Schema.Array(InstructionFootprintPart),
  injectedTools: Schema.optional(Schema.Array(Schema.String)),
  injectedToolCount: Schema.optional(NonNegativeInt),
  truncated: Schema.optional(Schema.Boolean),
  instructionSources: Schema.optional(
    Schema.Array(
      Schema.Struct({
        path: Schema.String,
        bytes: Schema.NullOr(NonNegativeInt),
      }),
    ),
  ),
});
export type InstructionFootprint = typeof InstructionFootprint.Type;

export const ThreadLoadEvent = Schema.Struct({
  itemId: TurnItemId,
  runId: Schema.NullOr(RunId),
  at: IsoDateTime,
  kind: Schema.Literals(["file", "skill", "instructions", "search", "resource", "knowledge"]),
  label: Schema.String,
  paths: Schema.Array(Schema.String),
  toolName: Schema.String,
  evidence: Schema.Literals(["reported", "inferred"]),
  status: Schema.String,
  outputBytes: Schema.NullOr(NonNegativeInt),
  estimatedOutputTokens: Schema.NullOr(NonNegativeInt),
});
export type ThreadLoadEvent = typeof ThreadLoadEvent.Type;
export const ThreadUsagePoint = Schema.Struct({
  runId: Schema.NullOr(RunId),
  turnId: Schema.String,
  ordinal: NonNegativeInt,
  providerInstanceId: Schema.NullOr(ProviderInstanceId),
  at: IsoDateTime,
  status: Schema.Literals(["complete", "partial", "unavailable"]),
  inputTokens: Schema.NullOr(NonNegativeInt),
  outputTokens: Schema.NullOr(NonNegativeInt),
  cachedInputTokens: Schema.NullOr(NonNegativeInt),
  cacheCreationTokens: Schema.NullOr(NonNegativeInt),
  reasoningTokens: Schema.NullOr(NonNegativeInt),
  localCommand: Schema.Boolean,
  hasSubagents: Schema.Boolean,
  otherInputTokens: Schema.NullOr(NonNegativeInt),
  otherOutputTokens: Schema.NullOr(NonNegativeInt),
});
export type ThreadUsagePoint = typeof ThreadUsagePoint.Type;
export const ThreadInsights = Schema.Struct({
  threadId: ThreadId,
  selectedRunId: Schema.NullOr(RunId),
  runs: Schema.Array(
    Schema.Struct({ id: RunId, ordinal: NonNegativeInt, startedAt: Schema.NullOr(IsoDateTime) }),
  ),
  loads: Schema.Array(ThreadLoadEvent),
  usage: Schema.Array(ThreadUsagePoint),
  footprints: Schema.Array(InstructionFootprint),
  estimateMethod: Schema.String,
});
export type ThreadInsights = typeof ThreadInsights.Type;
export const ThreadInsightsGetInput = Schema.Struct({
  threadId: ThreadId,
  runId: Schema.optional(RunId),
  allRuns: Schema.optional(Schema.Boolean),
});
export type ThreadInsightsGetInput = typeof ThreadInsightsGetInput.Type;
export class ThreadInsightsError extends Schema.TaggedError<ThreadInsightsError>()(
  "ThreadInsightsError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const ThreadContextRead = Schema.Struct({
  key: Schema.String,
  kind: ThreadLoadEvent.fields.kind,
  label: Schema.String,
  count: NonNegativeInt,
  outputBytes: Schema.NullOr(NonNegativeInt),
  evidence: ThreadLoadEvent.fields.evidence,
});
export type ThreadContextRead = typeof ThreadContextRead.Type;
export const TurnContextRecord = Schema.Struct({
  runId: RunId,
  status: OrchestrationV2RunStatus,
  ordinal: NonNegativeInt,
  model: Schema.String,
  providerInstanceId: ProviderInstanceId,
  startedAt: IsoDateTime,
  instructions: Schema.Array(InstructionFootprint),
  reads: Schema.Array(ThreadContextRead),
  repeatedReads: NonNegativeInt,
  inputTokens: Schema.NullOr(NonNegativeInt),
  cachedInputTokens: Schema.NullOr(NonNegativeInt),
  cachedInputTokensStatus: Schema.Literals(["complete", "partial", "unavailable"]),
  outputTokens: Schema.NullOr(NonNegativeInt),
  usageStatus: Schema.Literals(["complete", "partial", "unavailable"]),
  truncated: Schema.Boolean,
});
export type TurnContextRecord = typeof TurnContextRecord.Type;
export const ThreadContextGetInput = Schema.Struct({
  threadId: ThreadId,
  beforeOrdinal: Schema.optional(NonNegativeInt),
  limit: Schema.optional(NonNegativeInt.check(Schema.isBetween({ minimum: 1, maximum: 20 }))),
  maxBytes: Schema.optional(
    NonNegativeInt.check(Schema.isBetween({ minimum: 4000, maximum: 160000 })),
  ),
  includeInjectedTools: Schema.optional(Schema.Boolean),
});
export type ThreadContextGetInput = typeof ThreadContextGetInput.Type;
export const ThreadContextResult = Schema.Struct({
  threadId: ThreadId,
  records: Schema.Array(TurnContextRecord),
  nextBeforeOrdinal: Schema.NullOr(NonNegativeInt),
  coverage: Schema.String,
});
export type ThreadContextResult = typeof ThreadContextResult.Type;

export const DefaultContextItem = Schema.Struct({
  id: Schema.String,
  category: Schema.Literals(["t3", "app-context", "custom", "files", "skills", "tools"]),
  label: Schema.String,
  source: Schema.String,
  delivery: Schema.Literals(["every-turn", "first-prompt", "session-start", "on-demand"]),
  bytes: NonNegativeInt,
  estimatedTokens: NonNegativeInt,
  /** False for text that stays out of the default load, such as deferred tool descriptions. */
  counted: Schema.Boolean,
  readable: Schema.Boolean,
  depth: Schema.optional(NonNegativeInt),
  /** The file whose markdown link lists this one, read on demand rather than loaded. */
  parentId: Schema.optional(Schema.String),
  status: Schema.optional(
    Schema.Literals(["expected", "loaded", "not-loaded", "unexpected", "not-read", "secret"]),
  ),
});
export type DefaultContextItem = typeof DefaultContextItem.Type;
export const DefaultContextPreview = Schema.Struct({
  threadId: ThreadId,
  providerInstanceId: ProviderInstanceId,
  /** Opens Settings › Agent context for the same project. */
  projectId: Schema.optional(ProjectId),
  driver: Schema.String,
  model: Schema.String,
  cwd: Schema.NullOr(Schema.String),
  support: Schema.Literals(["exact", "estimate", "unsupported"]),
  filesSupported: Schema.Boolean,
  notes: Schema.Array(Schema.String),
  items: Schema.Array(DefaultContextItem),
  notVisible: Schema.Array(Schema.Struct({ label: Schema.String, why: Schema.String })),
  lastTurn: Schema.NullOr(
    Schema.Struct({
      capturedAt: IsoDateTime,
      model: Schema.String,
      reportsFiles: Schema.Boolean,
      /** T3, app-context and custom bytes sent that turn. */
      injectedBytes: NonNegativeInt,
    }),
  ),
  estimateMethod: Schema.String,
});
export type DefaultContextPreview = typeof DefaultContextPreview.Type;
export const DefaultContextGetInput = Schema.Struct({
  threadId: ThreadId,
  providerInstanceId: Schema.optional(ProviderInstanceId),
  model: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
  /** A thread that exists only as a client draft, before its first message. */
  draft: Schema.optional(
    Schema.Struct({
      projectId: ProjectId,
      worktreePath: Schema.NullOr(Schema.String.check(Schema.isMaxLength(4096))),
      interactionMode: ProviderInteractionMode,
    }),
  ),
});
export type DefaultContextGetInput = typeof DefaultContextGetInput.Type;
export const DefaultContextItemInput = Schema.Struct({
  ...DefaultContextGetInput.fields,
  itemId: Schema.String.check(Schema.isMaxLength(2048)),
});
export type DefaultContextItemInput = typeof DefaultContextItemInput.Type;
export const DefaultContextItemText = Schema.Struct({
  itemId: Schema.String,
  text: Schema.String,
  truncated: Schema.Boolean,
});
export type DefaultContextItemText = typeof DefaultContextItemText.Type;
export const ThreadTimelineGetInput = Schema.Struct({ threadId: ThreadId });
export type ThreadTimelineGetInput = typeof ThreadTimelineGetInput.Type;
export const ThreadUserTurnsGetInput = Schema.Struct({
  threadId: ThreadId,
  sourceRunId: Schema.optional(RunId),
});
export type ThreadUserTurnsGetInput = typeof ThreadUserTurnsGetInput.Type;
export const ThreadTimelineRelation = Schema.Literals([
  "self",
  "delegate",
  "subagent",
  "side-chat",
]);
export type ThreadTimelineRelation = typeof ThreadTimelineRelation.Type;
export const ThreadTimelineLane = Schema.Struct({
  threadId: ThreadId,
  /** Index of the parent lane; null for the requested thread. */
  parent: Schema.NullOr(NonNegativeInt),
  depth: NonNegativeInt,
  title: Schema.String,
  relation: ThreadTimelineRelation,
});
export type ThreadTimelineLane = typeof ThreadTimelineLane.Type;
/** `lane` indexes `ThreadTimeline.lanes` and `model` indexes `ThreadTimeline.models`; `startedAt` is epoch ms. */
export const ThreadTimelineRun = Schema.Struct({
  lane: NonNegativeInt,
  ordinal: NonNegativeInt,
  status: OrchestrationV2RunStatus,
  model: NonNegativeInt,
  startedAt: NonNegativeInt,
  /** From request to start. */
  queuedMs: NonNegativeInt,
  /** Null while the run is open. */
  durationMs: Schema.NullOr(NonNegativeInt),
});
export type ThreadTimelineRun = typeof ThreadTimelineRun.Type;
/** Totals cover every started run, including those past the `runs` cap; open runs are left to the client's clock. */
export const ThreadTimelineTotals = Schema.Struct({
  runs: NonNegativeInt,
  firstStartedAt: Schema.NullOr(NonNegativeInt),
  lastCompletedAt: Schema.NullOr(NonNegativeInt),
  finishedMs: NonNegativeInt,
  finishedMsByModel: Schema.Array(Schema.Struct({ model: Schema.String, ms: NonNegativeInt })),
});
export type ThreadTimelineTotals = typeof ThreadTimelineTotals.Type;
export const ThreadTimeline = Schema.Struct({
  threadId: ThreadId,
  /** Only lanes on the way to a returned run, plus the requested thread's own. */
  lanes: Schema.Array(ThreadTimelineLane),
  models: Schema.Array(Schema.String),
  /** The latest started runs, oldest first, at most `THREAD_TIMELINE_RUN_LIMIT`. */
  runs: Schema.Array(ThreadTimelineRun),
  totals: ThreadTimelineTotals,
});
export type ThreadTimeline = typeof ThreadTimeline.Type;
export const THREAD_TIMELINE_RUN_LIMIT = 1000;
/** The user's own turns, so the turn rail can mark turns outside the loaded history window. */
export const ThreadUserTurn = Schema.Struct({
  messageId: MessageId,
  createdAt: IsoDateTime,
  /** Truncated server-side. */
  text: Schema.String,
  /** The turn's last assistant text, truncated; null before one arrives. */
  replyText: Schema.NullOr(Schema.String),
});
export type ThreadUserTurn = typeof ThreadUserTurn.Type;
/** Newest `THREAD_USER_TURN_LIMIT` turns, oldest first. */
export const ThreadUserTurns = Schema.Struct({
  turns: Schema.Array(ThreadUserTurn),
  sourceMessageId: Schema.optional(MessageId),
});
export type ThreadUserTurns = typeof ThreadUserTurns.Type;
export const THREAD_USER_TURN_LIMIT = 60;
