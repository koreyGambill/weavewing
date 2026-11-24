import { expect, it } from "@effect/vitest";
import {
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  RunId,
  RunAttemptId,
  ProviderTurnId,
  ProviderThreadId,
  NodeId,
  MessageId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { emptyProjection } from "../orchestration-v2/ProjectionStore.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { InstructionFootprints } from "./InstructionFootprints.ts";
import { ThreadInsights, layer } from "./ThreadInsights.ts";

const threadId = ThreadId.make("insights");
const at = DateTime.makeUnsafe("2026-11-06T12:00:00Z");
it.effect(
  "selects only the chosen run's tool history and preserves unknown usage instead of using context snapshots",
  () =>
    Effect.gen(function* () {
      const projection = emptyProjection({
        id: EventId.make("created"),
        type: "thread.created",
        threadId,
        occurredAt: at,
        payload: {
          id: threadId,
          createdBy: "user",
          creationSource: "web",
          projectId: ProjectId.make("project"),
          title: "Notes",
          providerInstanceId: ProviderInstanceId.make("codex"),
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "default" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: at,
          updatedAt: at,
          archivedAt: null,
          deletedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
        },
      });

      const runId = RunId.make("run");
      const attemptId = RunAttemptId.make("attempt");
      const providerId = ProviderThreadId.make("provider");
      const records = {
        ...projection,
        runs: [
          {
            id: runId,
            threadId,
            ordinal: 1,
            providerInstanceId: ProviderInstanceId.make("codex"),
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "default" },
            providerThreadId: providerId,
            userMessageId: MessageId.make("message"),
            rootNodeId: null,
            activeAttemptId: attemptId,
            status: "completed" as const,
            requestedAt: at,
            startedAt: at,
            completedAt: at,
            checkpointId: null,
            contextHandoffId: null,
          },
        ],
        attempts: [
          {
            id: attemptId,
            runId,
            attemptOrdinal: 1,
            rootNodeId: NodeId.make("node"),
            providerInstanceId: ProviderInstanceId.make("codex"),
            providerThreadId: providerId,
            providerTurnId: null,
            reason: "initial" as const,
            status: "completed" as const,
            startedAt: at,
            completedAt: at,
          },
        ],
        providerTurns: [
          {
            id: ProviderTurnId.make("turn"),
            providerThreadId: providerId,
            nodeId: NodeId.make("node"),
            runAttemptId: attemptId,
            nativeTurnRef: null,
            ordinal: 1,
            status: "completed" as const,
            startedAt: at,
            completedAt: at,
            tokenUsage: {
              usedTokens: 1998,
              inputTokens: 999,
              outputTokens: 999,
              updatedAt: "2026-11-06T12:00:00Z",
            },
          },
        ],
      };
      const queries: unknown[] = [];
      const dependencies = Layer.mergeAll(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadRecords: (_id, _keys, filter) => {
            queries.push(filter);
            return Effect.succeed(records);
          },
        }),
        Layer.mock(InstructionFootprints)({ list: () => Effect.succeed([]) }),
        ServerSettingsService.layerTest(),
      );
      const insights = yield* ThreadInsights.pipe(
        Effect.provide(layer.pipe(Layer.provide(dependencies))),
      );
      const result = yield* insights.get({ threadId });
      expect(result.selectedRunId).toBe(runId);
      expect(result.usage).toMatchObject([
        { runId, status: "unavailable", inputTokens: null, outputTokens: null },
      ]);
      expect(queries[1]).toEqual({
        turnItemRunIds: [runId],
        turnItemTypes: ["command_execution", "dynamic_tool", "file_search"],
      });
      expect(
        yield* Effect.result(insights.get({ threadId, runId: RunId.make("another-thread-run") })),
      ).toMatchObject({ _tag: "Failure" });
    }),
);
