import {
  CommandId,
  type ModelSelection,
  OrchestratorMcpFailure,
  type OrchestrationV2DomainEvent,
  ProjectId,
  RunId,
  ScheduledTaskGrant,
  ScheduledTaskId,
  ThreadId,
  TurnTokenUsage,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";
import * as UsageService from "../usage/UsageService.ts";
import type { PricedRecord } from "../usage/usagePricing.ts";
import * as RunHistory from "./RunHistory.ts";

/** The automation whose limits a thread runs under. */
export interface AutomationScope {
  readonly taskId: ScheduledTaskId;
  /** The automation's own thread: bound, continuous, or one a run launched. */
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly grant: ScheduledTaskGrant;
  readonly modelSelection: Pick<ModelSelection, "instanceId" | "model">;
}

const MAX_LINEAGE_DEPTH = 16;
const SCOPE_CACHE_MS = 10_000;
const TRACKED_RUNS = 500;
const HOUR_MS = 3_600_000;

const decodeGrant = Schema.decodeUnknownOption(Schema.fromJsonString(ScheduledTaskGrant));
const decodeModel = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ instanceId: Schema.String, model: Schema.String })),
);
const decodeUsage = Schema.decodeUnknownOption(TurnTokenUsage);

/** Native subagents would bypass the subagent cap, and their spend only shows at turn end. */
const disablesNativeSubagents = (grant: ScheduledTaskGrant) =>
  grant.subagents !== undefined || grant.budget !== undefined;

const refuse = (message: string) =>
  new OrchestratorMcpFailure({ code: "capability_denied", message });

/** Keeps the newest `TRACKED_RUNS` keys. */
const remember = <K, V>(map: ReadonlyMap<K, V>, key: K, value: V): ReadonlyMap<K, V> => {
  const next = new Map(map);
  if (!next.has(key) && next.size >= TRACKED_RUNS) {
    const oldest = next.keys().next();
    if (!oldest.done) next.delete(oldest.value);
  }
  return next.set(key, value);
};

/** The task whose run started `threadId`: its first message came from that task. */
export const launchingTask = Effect.fn("AutomationLimits.launchingTask")(function* (
  threadId: ThreadId,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ task_id: string | null }>`
    SELECT json_extract(payload_json, '$.scheduledTaskId') AS task_id
    FROM orchestration_v2_projection_messages WHERE thread_id = ${threadId}
    ORDER BY created_at, message_id LIMIT 1`.pipe(NodeSqliteClient.readOnly);
  return row?.task_id ?? null;
});

/**
 * Walks delegated-task lineage (not forks) up from `threadId` to the nearest thread that belongs
 * to an automation with a grant: its bound thread, or a thread one of its runs launched.
 */
export const automationForThread = Effect.fn("AutomationLimits.automationForThread")(function* (
  threadId: ThreadId,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{
    thread_id: string;
    project_id: string;
    task_id: string;
    grant_json: string;
    model_selection_json: string;
  }>`WITH RECURSIVE chain(thread_id, depth) AS (
      SELECT ${threadId}, 0
      UNION ALL
      SELECT json_extract(t.payload_json, '$.lineage.parentThreadId'), chain.depth + 1
      FROM orchestration_v2_projection_threads t JOIN chain ON t.thread_id = chain.thread_id
      WHERE chain.depth < ${MAX_LINEAGE_DEPTH}
        AND json_extract(t.payload_json, '$.lineage.relationshipToParent') = 'subagent'
        AND json_extract(t.payload_json, '$.lineage.parentThreadId') IS NOT NULL
    )
    SELECT chain.thread_id, s.project_id, s.task_id, s.grant_json, s.model_selection_json
    FROM chain JOIN scheduled_tasks s ON s.grant_json IS NOT NULL AND (
      s.thread_id = chain.thread_id
      OR s.task_id = (SELECT json_extract(m.payload_json, '$.scheduledTaskId')
        FROM orchestration_v2_projection_messages m WHERE m.thread_id = chain.thread_id
        ORDER BY m.created_at, m.message_id LIMIT 1))
    ORDER BY chain.depth LIMIT 1`.pipe(NodeSqliteClient.readOnly);
  if (row === undefined) return null;
  const grant = decodeGrant(row.grant_json);
  const model = decodeModel(row.model_selection_json);
  if (Option.isNone(grant) || Option.isNone(model)) return null;
  const scope: AutomationScope = {
    taskId: ScheduledTaskId.make(row.task_id),
    threadId: ThreadId.make(row.thread_id),
    projectId: ProjectId.make(row.project_id),
    grant: grant.value,
    modelSelection: model.value as AutomationScope["modelSelection"],
  };
  return scope;
});

const latestRunId = Effect.fn("AutomationLimits.latestRunId")(function* (threadId: ThreadId) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ run_id: string }>`SELECT run_id FROM orchestration_v2_projection_runs
    WHERE thread_id = ${threadId} ORDER BY ordinal DESC LIMIT 1`.pipe(NodeSqliteClient.readOnly);
  return row === undefined ? null : RunId.make(row.run_id);
});

/**
 * The run whose limits the thread's latest run shares. Turns an agent sent (follow-ups, delegated
 * results) belong to the run before them; a scheduled run or a user's message starts a new one.
 */
const budgetRunId = Effect.fn("AutomationLimits.budgetRunId")(function* (threadId: ThreadId) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ run_id: string; follow_up: number }>`
    SELECT r.run_id, (json_extract(m.payload_json, '$.senderThreadId') IS NOT NULL
      OR json_type(m.payload_json, '$.delegatedCompletion') IS NOT NULL) AS follow_up
    FROM orchestration_v2_projection_runs r
    LEFT JOIN orchestration_v2_projection_messages m
      ON m.message_id = json_extract(r.payload_json, '$.userMessageId')
    WHERE r.thread_id = ${threadId} ORDER BY r.ordinal DESC LIMIT 50`.pipe(
    NodeSqliteClient.readOnly,
  );
  const owner = rows.find((row) => row.follow_up !== 1) ?? rows.at(-1);
  return owner === undefined ? null : RunId.make(owner.run_id);
});

/** The thread and its delegated descendants that have a run in progress. */
const activeThreads = Effect.fn("AutomationLimits.activeThreads")(function* (threadId: ThreadId) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ thread_id: string; project_id: string }>`
    WITH RECURSIVE tree(thread_id, depth) AS (
      SELECT ${threadId}, 0
      UNION ALL
      SELECT t.thread_id, tree.depth + 1 FROM orchestration_v2_projection_threads t
      JOIN tree ON json_extract(t.payload_json, '$.lineage.parentThreadId') = tree.thread_id
      WHERE tree.depth < ${MAX_LINEAGE_DEPTH}
        AND json_extract(t.payload_json, '$.lineage.relationshipToParent') = 'subagent'
    )
    SELECT DISTINCT t.thread_id, t.project_id FROM tree
    JOIN orchestration_v2_projection_threads t ON t.thread_id = tree.thread_id
    WHERE EXISTS (SELECT 1 FROM orchestration_v2_projection_runs r WHERE r.thread_id = t.thread_id
      AND r.status NOT IN ('completed', 'failed', 'cancelled', 'interrupted', 'rolled_back'))`.pipe(
    NodeSqliteClient.readOnly,
  );
  return rows.map((row) => ({
    threadId: ThreadId.make(row.thread_id),
    projectId: ProjectId.make(row.project_id),
  }));
});

const sameModel = (
  left: { readonly instanceId: string; readonly model: string },
  right: { readonly instanceId: string; readonly model: string },
) => left.instanceId === right.instanceId && left.model === right.model;

interface RequestUsage {
  readonly input: number;
  readonly cached: number;
  readonly output: number;
}

/**
 * One provider turn's spend. Mid-turn each update carries only the latest request's usage, so the
 * turn keeps one entry per request; the ledger's figures replace them when the turn ends.
 */
interface TurnSpend {
  readonly model: string;
  readonly requests: ReadonlyArray<RequestUsage>;
  readonly final: { readonly tokens: number; readonly records: ReadonlyArray<PricedRecord> } | null;
}

const turnSpendParts = (spend: TurnSpend) =>
  spend.final ?? {
    tokens: spend.requests.reduce((total, request) => total + request.input + request.output, 0),
    records: spend.requests.map((request): PricedRecord => ({
      model: spend.model,
      totals: {
        uncachedInputTokens: Math.max(0, request.input - request.cached),
        cachedInputTokens: request.cached,
        cacheCreationTokens: 0,
        outputTokens: request.output,
        reasoningTokens: 0,
      },
      speed: "standard",
      reportedCostUsd: null,
    })),
  };

const nextTurnSpend = (
  previous: TurnSpend | undefined,
  turn: Extract<OrchestrationV2DomainEvent, { readonly type: "provider-turn.updated" }>["payload"],
  fallbackModel: string,
): TurnSpend => {
  const model = turn.model ?? previous?.model ?? fallbackModel;
  const requests = previous?.requests ?? [];
  const ledger =
    turn.turnTokenUsage === undefined ? Option.none() : decodeUsage(turn.turnTokenUsage);
  if (Option.isSome(ledger)) {
    const used = RunHistory.turnUsage(ledger.value, model, null);
    const final = {
      tokens: used === null ? 0 : used.tokens + (used.otherTokens ?? 0),
      records:
        used === null ? [] : [used.record, used.otherRecord].filter((record) => record !== null),
    };
    return { model, requests, final };
  }
  const snapshot = turn.tokenUsage;
  // A context-size update without per-request counts is not a request.
  if (snapshot?.inputTokens === undefined) return previous ?? { model, requests, final: null };
  const request: RequestUsage = {
    input: snapshot.inputTokens,
    cached: snapshot.cachedInputTokens ?? 0,
    output: snapshot.outputTokens ?? 0,
  };
  // A request reports again as its output grows; a new input size is a new request.
  const last = requests.at(-1);
  return {
    model,
    requests:
      last !== undefined && last.input === request.input
        ? [...requests.slice(0, -1), request]
        : [...requests, request],
    final: null,
  };
};

const SCHEDULING_REFUSED =
  "An agent in a limited automation can't create tasks, change limits or run tasks now. Ask the user to do it in Settings → Scheduled tasks.";

export class AutomationLimits extends Context.Service<
  AutomationLimits,
  {
    readonly forThread: (threadId: ThreadId) => Effect.Effect<AutomationScope | null>;
    /**
     * Counts new subagents against the caller's automation run, or refuses them. A model without
     * `model` is one the caller left to a linked environment to pick.
     */
    readonly admitSubagents: (input: {
      readonly callerThreadId: ThreadId;
      readonly models: ReadonlyArray<{ readonly instanceId?: string; readonly model?: string }>;
    }) => Effect.Effect<void, OrchestratorMcpFailure>;
    /** Work outside the automation's threads would escape its limits. */
    readonly refuseOutside: (
      callerThreadId: ThreadId,
      action: string,
    ) => Effect.Effect<void, OrchestratorMcpFailure>;
    /** Refuses moving turns in a thread outside the automation, such as answering or queueing. */
    readonly refuseOtherThread: (input: {
      readonly callerThreadId: ThreadId;
      readonly targetThreadId: ThreadId;
      readonly action: string;
    }) => Effect.Effect<void, OrchestratorMcpFailure>;
    /** Sends start turns: outside the automation they escape its limits, inside they count. */
    readonly admitSend: (input: {
      readonly callerThreadId: ThreadId;
      readonly targetThreadId: ThreadId;
    }) => Effect.Effect<void, OrchestratorMcpFailure>;
    /** Creating tasks, changing limits and running tasks now are the user's to do. */
    readonly refuseScheduling: (
      callerThreadId: ThreadId,
    ) => Effect.Effect<void, OrchestratorMcpFailure>;
    readonly allowsNotify: (threadId: ThreadId) => Effect.Effect<boolean>;
  }
>()("t3/scheduledTasks/AutomationLimits") {}

export const layer = Layer.effect(
  AutomationLimits,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const usage = yield* Effect.serviceOption(UsageService.UsageService);
    const withSql = Effect.provideService(SqlClient.SqlClient, sql);
    const scopes = yield* Ref.make<
      ReadonlyMap<ThreadId, { readonly at: number; readonly scope: AutomationScope | null }>
    >(new Map());
    const subagentCounts = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
    const spends = yield* Ref.make<ReadonlyMap<RunId, ReadonlyMap<string, TurnSpend>>>(new Map());
    const stopped = yield* Ref.make<ReadonlyMap<RunId, string>>(new Map());
    const enforced = yield* Ref.make<ReadonlyMap<RunId, true>>(new Map());

    const forThread = Effect.fn("AutomationLimits.forThread")(function* (threadId: ThreadId) {
      const now = yield* Clock.currentTimeMillis;
      const cached = (yield* Ref.get(scopes)).get(threadId);
      if (cached !== undefined && now - cached.at < SCOPE_CACHE_MS) return cached.scope;
      const scope = yield* automationForThread(threadId).pipe(
        withSql,
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not read an automation's limits", { threadId, cause }).pipe(
            Effect.as(null),
          ),
        ),
      );
      yield* Ref.update(scopes, (map) => remember(map, threadId, { at: now, scope }));
      return scope;
    });

    const runKey = (scope: AutomationScope) =>
      budgetRunId(scope.threadId).pipe(
        withSql,
        Effect.orElseSucceed(() => null),
      );

    const admitSubagents = Effect.fn("AutomationLimits.admitSubagents")(function* (input: {
      readonly callerThreadId: ThreadId;
      readonly models: ReadonlyArray<{ readonly instanceId?: string; readonly model?: string }>;
    }) {
      const scope = yield* forThread(input.callerThreadId);
      const limit = scope?.grant.subagents;
      if (scope === null || limit === undefined || input.models.length === 0) return;
      const allowed = limit.models.length === 0 ? [scope.modelSelection] : limit.models;
      const allowedText = allowed.map((model) => `${model.instanceId}/${model.model}`).join(", ");
      for (const { instanceId, model } of input.models) {
        if (instanceId === undefined || model === undefined) {
          return yield* refuse(
            `Name target.providerInstanceId and target.model: this automation allows subagents only on ${allowedText}.`,
          );
        }
        if (!allowed.some((ok) => sameModel(ok, { instanceId, model }))) {
          return yield* refuse(
            `This automation allows subagents only on ${allowedText}, not ${instanceId}/${model}.`,
          );
        }
      }
      const key = (yield* runKey(scope)) ?? scope.threadId;
      // After a restart the count comes back from the run's history row.
      const stored = (yield* Ref.get(subagentCounts)).has(key)
        ? 0
        : ((yield* sql<{ subagent_count: number }>`SELECT subagent_count FROM scheduled_task_runs
              WHERE orchestration_run_id = ${key}`.pipe(Effect.orElseSucceed(() => [])))[0]
            ?.subagent_count ?? 0);
      const admitted = yield* Ref.modify(subagentCounts, (counts) => {
        const used = counts.get(key) ?? stored;
        return used + input.models.length > limit.max
          ? ([false, remember(counts, key, used)] as const)
          : ([true, remember(counts, key, used + input.models.length)] as const);
      });
      if (!admitted) {
        return yield* refuse(
          `This automation allows ${limit.max} subagent${limit.max === 1 ? "" : "s"} per run.`,
        );
      }
      yield* sql`UPDATE scheduled_task_runs SET subagent_count = subagent_count + ${input.models.length}
        WHERE thread_id = ${scope.threadId} AND ended_at IS NULL`.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not record an automation subagent", { cause }),
        ),
      );
    });

    const outsideMessage = (action: string) =>
      `This automation's limits keep its work in its own threads, so it can't ${action}. Use delegate_task for subagents.`;

    const refuseOutside = Effect.fn("AutomationLimits.refuseOutside")(function* (
      callerThreadId: ThreadId,
      action: string,
    ) {
      const scope = yield* forThread(callerThreadId);
      if (scope !== null && disablesNativeSubagents(scope.grant)) {
        return yield* refuse(outsideMessage(action));
      }
    });

    /** The caller's limited automation when `targetThreadId` is not one of its threads. */
    const outsider = Effect.fn("AutomationLimits.outsider")(function* (
      callerThreadId: ThreadId,
      targetThreadId: ThreadId,
    ) {
      const caller = yield* forThread(callerThreadId);
      if (caller === null) return { caller, outside: false };
      const target = yield* forThread(targetThreadId);
      return { caller, outside: target?.taskId !== caller.taskId };
    });

    const refuseOtherThread = Effect.fn("AutomationLimits.refuseOtherThread")(function* (input: {
      readonly callerThreadId: ThreadId;
      readonly targetThreadId: ThreadId;
      readonly action: string;
    }) {
      const { caller, outside } = yield* outsider(input.callerThreadId, input.targetThreadId);
      if (caller !== null && outside && disablesNativeSubagents(caller.grant)) {
        return yield* refuse(outsideMessage(input.action));
      }
    });

    const admitSend = Effect.fn("AutomationLimits.admitSend")(function* (input: {
      readonly callerThreadId: ThreadId;
      readonly targetThreadId: ThreadId;
    }) {
      const { caller, outside } = yield* outsider(input.callerThreadId, input.targetThreadId);
      if (caller === null) return;
      if (outside) {
        if (disablesNativeSubagents(caller.grant)) {
          return yield* refuse(outsideMessage("send to threads outside it"));
        }
        return;
      }
      // Its delegated threads spend inside the run already; only the main thread starts runs.
      if (input.targetThreadId !== caller.threadId) return;
      const key = yield* runKey(caller);
      const stop = key === null ? undefined : (yield* Ref.get(stopped)).get(key);
      if (stop !== undefined) {
        return yield* refuse(`${stop} It continues at its next scheduled run.`);
      }
      const cap = caller.grant.maxRunsPerHour;
      if (cap === undefined) return;
      const now = yield* Clock.currentTimeMillis;
      const since = DateTime.formatIso(DateTime.makeUnsafe(now - HOUR_MS));
      const recent = yield* RunHistory.countRecentRuns(caller.taskId, since).pipe(
        withSql,
        Effect.orElseSucceed(() => 0),
      );
      if (recent >= cap) {
        return yield* refuse(`This automation allows ${cap} run${cap === 1 ? "" : "s"} per hour.`);
      }
    });

    const refuseScheduling = Effect.fn("AutomationLimits.refuseScheduling")(function* (
      callerThreadId: ThreadId,
    ) {
      if ((yield* forThread(callerThreadId)) !== null) return yield* refuse(SCHEDULING_REFUSED);
    });

    const price = (records: ReadonlyArray<PricedRecord>) =>
      Option.isSome(usage) && records.length > 0
        ? usage.value.priceRecords(records)
        : Effect.succeed(records.length === 0 ? 0 : null);

    /** Interrupts the automation thread's active work, once per run of its main thread. */
    const interruptActive = Effect.fn("AutomationLimits.interruptActive")(function* (
      scope: AutomationScope,
      reason: string,
    ) {
      const latest = yield* latestRunId(scope.threadId).pipe(
        withSql,
        Effect.orElseSucceed(() => null),
      );
      if (latest === null) return;
      const first = yield* Ref.modify(enforced, (map) =>
        map.has(latest) ? ([false, map] as const) : ([true, remember(map, latest, true)] as const),
      );
      if (!first) return;
      const targets = yield* activeThreads(scope.threadId).pipe(
        withSql,
        Effect.orElseSucceed(() => [{ threadId: scope.threadId, projectId: scope.projectId }]),
      );
      yield* Effect.forEach(
        targets,
        (target) =>
          threads
            .interruptThread({
              ...target,
              commandId: CommandId.make(`automation-budget:${latest}:${target.threadId}`),
              reason,
            })
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Could not stop a thread over its automation budget", {
                  threadId: target.threadId,
                  cause,
                }),
              ),
            ),
        { discard: true },
      );
    });

    const stopRun = Effect.fn("AutomationLimits.stopRun")(function* (
      scope: AutomationScope,
      key: RunId,
      reason: string,
    ) {
      const first = yield* Ref.modify(stopped, (map) =>
        map.has(key) ? ([false, map] as const) : ([true, remember(map, key, reason)] as const),
      );
      if (first) {
        yield* RunHistory.markBudgetStopped(scope.threadId, reason).pipe(
          withSql,
          Effect.flatMap((taskIds) =>
            Effect.forEach(
              taskIds,
              (taskId) =>
                sql`UPDATE scheduled_tasks SET last_run_status = 'failed', last_run_error = ${reason}
                  WHERE task_id = ${taskId} AND last_run_status IN ('running', 'succeeded')`,
              { discard: true },
            ),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not record an automation budget stop", { cause }),
          ),
        );
      }
      yield* interruptActive(scope, reason);
    });

    const trackSpend = Effect.fnUntraced(function* (
      event: Extract<OrchestrationV2DomainEvent, { readonly type: "provider-turn.updated" }>,
    ) {
      const scope = yield* forThread(event.threadId);
      const budget = scope?.grant.budget;
      if (scope === null || budget === undefined) return;
      const key = yield* runKey(scope);
      if (key === null) return;
      // A follow-up of a stopped run, such as a delegated result arriving, stops too.
      const stop = (yield* Ref.get(stopped)).get(key);
      if (stop !== undefined) return yield* interruptActive(scope, stop);
      const turnKey = `${event.threadId}:${event.payload.id}`;
      const turns = yield* Ref.modify(spends, (all) => {
        const previous = all.get(key) ?? new Map<string, TurnSpend>();
        const next = new Map(previous).set(
          turnKey,
          nextTurnSpend(previous.get(turnKey), event.payload, scope.modelSelection.model),
        );
        return [next, remember(all, key, next)] as const;
      });
      const parts = [...turns.values()].map(turnSpendParts);
      const tokens = parts.reduce((total, part) => total + part.tokens, 0);
      if (budget.maxTokens !== undefined && tokens > budget.maxTokens) {
        return yield* stopRun(
          scope,
          key,
          `Stopped at the ${budget.maxTokens.toLocaleString("en-US")} token run budget.`,
        );
      }
      if (budget.maxCostUsd === undefined) return;
      const cost = yield* price(parts.flatMap((part) => part.records));
      if (cost !== null && cost > budget.maxCostUsd) {
        yield* stopRun(scope, key, `Stopped at the $${budget.maxCostUsd.toFixed(2)} run budget.`);
      }
    });

    // Backstop for providers, or sessions started before the grant, that kept native subagents.
    const refuseNativeSubagent = Effect.fnUntraced(function* (
      event: Extract<OrchestrationV2DomainEvent, { readonly type: "subagent.updated" }>,
    ) {
      if (event.payload.origin !== "provider_native") return;
      const scope = yield* forThread(event.threadId);
      if (scope === null || !disablesNativeSubagents(scope.grant)) return;
      const key = yield* runKey(scope);
      if (key === null) return;
      yield* stopRun(scope, key, "Stopped: this automation's subagents must go through T3 Code.");
    });

    yield* forkParked(
      Stream.runForEach(threads.streamDomainEvents, (event) =>
        (event.type === "provider-turn.updated"
          ? trackSpend(event)
          : event.type === "subagent.updated"
            ? refuseNativeSubagent(event)
            : Effect.void
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not check an automation's limits", { cause }),
          ),
        ),
      ).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Automation budget event stream failed", { cause }),
        ),
      ),
    );

    return AutomationLimits.of({
      forThread,
      admitSubagents,
      refuseOutside,
      refuseOtherThread,
      admitSend,
      refuseScheduling,
      allowsNotify: Effect.fn("AutomationLimits.allowsNotify")(function* (threadId: ThreadId) {
        return (yield* forThread(threadId))?.grant.notify !== false;
      }),
    });
  }),
);

/** Lays an automation's native-subagent switch over another runtime policy. */
export const runtimePolicyLayer: Layer.Layer<
  RuntimePolicy.RuntimePolicyV2,
  never,
  RuntimePolicy.RuntimePolicyV2 | SqlClient.SqlClient
> = Layer.effect(
  RuntimePolicy.RuntimePolicyV2,
  Effect.gen(function* () {
    const base = yield* RuntimePolicy.RuntimePolicyV2;
    const sql = yield* SqlClient.SqlClient;
    return RuntimePolicy.RuntimePolicyV2.of({
      resolve: Effect.fn("RuntimePolicyV2.resolveWithAutomationLimits")(function* (input) {
        const policy = yield* base.resolve(input);
        const scope = yield* automationForThread(input.thread.id).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not read an automation's limits", { cause }).pipe(
              Effect.as(null),
            ),
          ),
        );
        return scope !== null && disablesNativeSubagents(scope.grant)
          ? { ...policy, disableNativeSubagents: true as const }
          : policy;
      }),
    });
  }),
);
