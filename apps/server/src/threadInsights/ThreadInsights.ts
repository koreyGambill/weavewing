import {
  DEFAULT_LOAD_WATCHERS,
  ThreadInsightsError,
  type ThreadInsights as Insights,
  type ThreadInsightsGetInput,
  type ThreadUsagePoint,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { InstructionFootprints } from "./InstructionFootprints.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { projectLoadEvent } from "./insightProjection.ts";

export class ThreadInsights extends Context.Service<
  ThreadInsights,
  { readonly get: (input: ThreadInsightsGetInput) => Effect.Effect<Insights, ThreadInsightsError> }
>()("t3/threadInsights/ThreadInsights") {}

const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const footprints = yield* InstructionFootprints;
  const settings = yield* ServerSettingsService;
  const get = Effect.fn("ThreadInsights.get")(function* ({
    threadId,
    runId,
    allRuns,
  }: ThreadInsightsGetInput) {
    const records = yield* orchestrator
      .getThreadRecords(threadId, ["runs", "attempts", "providerTurns", "providerThreads"])
      .pipe(
        Effect.mapError(
          (cause) => new ThreadInsightsError({ message: "Could not load thread usage.", cause }),
        ),
      );
    if (records.thread.deletedAt !== null)
      return yield* new ThreadInsightsError({ message: "This thread was deleted." });
    const runs = records.runs.toSorted((a, b) => a.ordinal - b.ordinal);
    const selectedRunId = allRuns ? null : (runId ?? runs.at(-1)?.id ?? null);
    if (selectedRunId !== null && !runs.some((run) => run.id === selectedRunId)) {
      return yield* new ThreadInsightsError({
        message: "The selected run does not belong to this thread.",
      });
    }
    const attempts = new Map(records.attempts.map((attempt) => [attempt.id, attempt]));
    const providers = new Map(records.providerThreads.map((provider) => [provider.id, provider]));
    const usage: ThreadUsagePoint[] = records.providerTurns
      .map((turn) => {
        const count = turn.turnTokenUsage;
        const attempt = turn.runAttemptId === null ? undefined : attempts.get(turn.runAttemptId);
        return {
          runId: attempt?.runId ?? null,
          turnId: turn.id,
          ordinal: turn.ordinal,
          providerInstanceId: providers.get(turn.providerThreadId)?.providerInstanceId ?? null,
          at: DateTime.formatIso(turn.startedAt ?? turn.completedAt ?? records.thread.createdAt),
          status: count?.usageStatus ?? "unavailable",
          inputTokens: count?.inputTokens ?? null,
          outputTokens: count?.outputTokens ?? null,
          cachedInputTokens: count?.cachedInputTokens ?? null,
          cacheCreationTokens: count?.cacheCreationTokens ?? null,
          reasoningTokens: count?.reasoningTokens ?? null,
          localCommand: count?.localCommand ?? false,
          hasSubagents: count?.hasSubagents ?? false,
          otherInputTokens: count?.otherUsage?.inputTokens ?? null,
          otherOutputTokens: count?.otherUsage?.outputTokens ?? null,
        };
      })
      .toSorted((a, b) => a.at.localeCompare(b.at) || a.ordinal - b.ordinal);
    const toolRecords =
      selectedRunId === null
        ? null
        : yield* orchestrator
            .getThreadRecords(threadId, ["turnItems"], {
              turnItemRunIds: [selectedRunId],
              turnItemTypes: ["command_execution", "dynamic_tool", "file_search"],
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ThreadInsightsError({
                    message: "Could not load the file and skill timeline.",
                    cause,
                  }),
              ),
            );
    const watchers = yield* settings.getSettings.pipe(
      Effect.map((value) => value.loadWatchers),
      Effect.orElseSucceed(() => DEFAULT_LOAD_WATCHERS),
    );
    return {
      threadId,
      selectedRunId,
      runs: runs.map((run) => ({
        id: run.id,
        ordinal: run.ordinal,
        startedAt: DateTime.formatIso(run.startedAt ?? run.requestedAt),
      })),
      loads:
        toolRecords?.turnItems
          .flatMap((item) => {
            const event = projectLoadEvent(item, watchers);
            return event === null ? [] : [event];
          })
          .toSorted((a, b) => a.at.localeCompare(b.at)) ?? [],
      usage,
      footprints: yield* footprints.list(threadId, selectedRunId),
      estimateMethod:
        "Known instruction and tool-output estimates use UTF-8 bytes divided by four, rounded up. They are not tokenizer counts or billing. Provider input totals include conversation, tools, and instructions; hidden harness instructions cannot be separated. Tool events do not reveal automatic project/skill loading by a provider.",
    } satisfies Insights;
  });
  return ThreadInsights.of({ get });
});

export const layer = Layer.effect(ThreadInsights, make);
