import { expect, it } from "@effect/vitest";
import { ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as Footprints from "./InstructionFootprints.ts";
import * as Records from "./ContextRecords.ts";

it.effect(
  "derives repeats and knowledge reads from retained items, scopes usage, and pages recent turns",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const at = "2026-11-09T12:00:00.000Z";
      const threadId = ThreadId.make("context-thread");
      yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES (${threadId},'project','Context','claude','full-access','default',${at},${at},'{}')`;
      for (const ordinal of [1, 2, 3, 4]) {
        const runId = `run-${ordinal}`;
        const payload = JSON.stringify({
          modelSelection: { model: "haiku", instanceId: "claude" },
        });
        yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES (${runId},${threadId},${ordinal},'claude','completed',${at},${payload})`;
      }
      yield* sql`UPDATE orchestration_v2_projection_runs SET status='queued' WHERE run_id='run-4'`;
      yield* sql`UPDATE orchestration_v2_projection_runs SET status='rolled_back' WHERE run_id='run-3'`;
      const scope = JSON.stringify({ cwd: "/repo" });
      yield* sql`INSERT INTO orchestration_v2_projection_checkpoint_scopes (scope_id,thread_id,run_id,node_id,kind,ordinal_within_parent,advances_app_run_count,created_at,payload_json) VALUES ('scope',${threadId},'run-2','node','root_run',1,1,${at},${scope})`;
      for (const [id, input] of [
        ["a", "cat /repo/AGENTS.md"],
        ["b", "sed -n '1,20p' /repo/AGENTS.md"],
        ["c", "overwing search context engines"],
        ["d", "overwing search context engines"],
        ["e", "cat README.md"],
        ["f", "/usr/bin/cat README.md"],
        ["g", "git log | head -5"],
        ["h", "git log | tail -20"],
      ]) {
        const payload = JSON.stringify({
          id,
          threadId,
          runId: "run-2",
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "completed",
          title: null,
          startedAt: at,
          completedAt: at,
          updatedAt: at,
          type: "command_execution",
          input,
          output: "é".repeat(6000),
          exitCode: 0,
        });
        yield* sql`INSERT INTO orchestration_v2_projection_turn_items (turn_item_id,thread_id,run_id,ordinal,type,status,updated_at,payload_json) VALUES (${id},${threadId},'run-2',1,'command_execution','completed',${at},${payload})`;
      }
      for (const [id, toolName, input] of [
        ["read", "Read", { file_path: "/repo/README.md" }],
        ["mcp-a", "mcp__t3_code__t3_thread_read", { threadId: "a" }],
        ["mcp-b", "mcp__t3_code__t3_thread_read", { threadId: "b" }],
        ["mcp-a-again", "mcp__t3_code__t3_thread_read", { threadId: "a" }],
        ["ws-a", "mcp__t3_code__list_read", { threadId: "a" }],
        ["uri-a", "mcp__resources__read_resource", { uri: "notes://latest" }],
        ["uri-b", "mcp__resources__read_resource", { uri: "notes://latest" }],
      ] as const) {
        const payload = JSON.stringify({
          id,
          threadId,
          runId: "run-2",
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 2,
          status: "completed",
          title: null,
          startedAt: at,
          completedAt: at,
          updatedAt: at,
          type: "dynamic_tool",
          toolName,
          input,
          output: "text",
        });
        yield* sql`INSERT INTO orchestration_v2_projection_turn_items (turn_item_id,thread_id,run_id,ordinal,type,status,updated_at,payload_json) VALUES (${id},${threadId},'run-2',2,'dynamic_tool','completed',${at},${payload})`;
      }
      const records = yield* Records.ContextRecords;
      expect((yield* records.get({ threadId, limit: 1 })).records[0]).toMatchObject({
        runId: "run-3",
        status: "rolled_back",
      });
      const result = yield* records.get({ threadId, limit: 1, beforeOrdinal: 3 });
      expect(result.nextBeforeOrdinal).toBe(2);
      expect(result.records).toHaveLength(1);
      expect(result.records[0]).toMatchObject({
        runId: "run-2",
        repeatedReads: 4,
        inputTokens: null,
        usageStatus: "unavailable",
        truncated: false,
      });
      expect(new Set(result.records[0]?.reads.map((read) => read.key)).size).toBe(
        result.records[0]?.reads.length,
      );
      expect(result.records[0]?.reads).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            label: "/repo/AGENTS.md",
            count: 2,
            outputBytes: 24000,
            evidence: "inferred",
          }),
          expect.objectContaining({
            label: "overwing: overwing search context engines",
            kind: "knowledge",
            count: 1,
          }),
        ]),
      );
      expect(result.records[0]?.reads).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ label: "/repo/README.md", count: 3 }),
          expect.objectContaining({ label: "mcp__t3_code__t3_thread_read a", count: 2 }),
          expect.objectContaining({ label: "mcp__t3_code__t3_thread_read b", count: 1 }),
          expect.objectContaining({ label: "mcp__t3_code__list_read a", count: 1 }),
        ]),
      );
      expect(
        (yield* records.get({ threadId, beforeOrdinal: 2 })).records.map((record) => record.runId),
      ).toEqual([RunId.make("run-1")]);
      yield* sql`INSERT INTO orchestration_v2_projection_run_attempts (attempt_id,thread_id,run_id,attempt_ordinal,root_node_id,provider,provider_thread_id,status,payload_json) VALUES ('attempt',${threadId},'run-2',1,'node','claude','provider','completed','{}')`;
      const usage = JSON.stringify({
        turnTokenUsage: {
          usageScope: "main_agent",
          usageStatus: "complete",
          inputTokens: 1000,
          cachedInputTokens: 800,
          outputTokens: 100,
          hasSubagents: false,
        },
      });
      yield* sql`INSERT INTO orchestration_v2_projection_provider_turns (provider_turn_id,thread_id,provider_thread_id,node_id,run_attempt_id,ordinal,status,payload_json) VALUES ('turn',${threadId},'provider','node','attempt',1,'completed',${usage})`;
      expect((yield* records.get({ threadId, beforeOrdinal: 3 })).records[0]).toMatchObject({
        inputTokens: 1000,
        cachedInputTokens: 800,
        outputTokens: 100,
        usageStatus: "complete",
        cachedInputTokensStatus: "complete",
      });

      const uncachedUsage = JSON.stringify({
        turnTokenUsage: {
          usageScope: "main_agent",
          usageStatus: "complete",
          inputTokens: 500,
          outputTokens: 50,
          hasSubagents: false,
        },
      });
      yield* sql`INSERT INTO orchestration_v2_projection_provider_turns (provider_turn_id,thread_id,provider_thread_id,node_id,run_attempt_id,ordinal,status,payload_json) VALUES ('turn-2',${threadId},'provider','node','attempt',2,'completed',${uncachedUsage})`;
      expect((yield* records.get({ threadId, beforeOrdinal: 3 })).records[0]).toMatchObject({
        inputTokens: 1500,
        cachedInputTokens: 800,
        usageStatus: "complete",
        cachedInputTokensStatus: "partial",
      });

      expect(
        yield* Effect.result(records.get({ threadId: ThreadId.make("missing") })),
      ).toMatchObject({ _tag: "Failure" });
    }).pipe(
      Effect.provide(
        Records.layer.pipe(
          Layer.provide(
            Layer.mock(Footprints.InstructionFootprints)({ list: () => Effect.succeed([]) }),
          ),
          Layer.provide(ServerSettingsService.layerTest()),
          Layer.provideMerge(Sqlite.layerMemory),
        ),
      ),
    ),
);

it.effect(
  "bounds compact records and omits injected tool names on request while retaining counts",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("bounded-thread");
      const at = "2026-11-09T12:00:00.000Z";
      yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES (${threadId},'project','Context','claude','full-access','default',${at},${at},'{}')`;
      for (const ordinal of [1, 2, 3, 4]) {
        const runId = `bounded-${ordinal}`;
        yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES (${runId},${threadId},${ordinal},'claude','completed',${at},'{}')`;
      }
      const records = yield* Records.ContextRecords;
      const compact = yield* records.get({
        threadId,
        limit: 3,
        maxBytes: 24000,
        includeInjectedTools: false,
      });
      expect(Buffer.byteLength(JSON.stringify(compact))).toBeLessThanOrEqual(24000);
      expect(compact.records.length).toBeLessThanOrEqual(3);
      expect(compact.records[0]?.instructions[0]).toMatchObject({ injectedToolCount: 256 });
      expect(compact.records[0]?.instructions[0]).not.toHaveProperty("injectedTools");
      expect(compact.records[0]?.truncated).toBe(true);
      const full = yield* records.get({ threadId, limit: 1 });
      expect(full.records[0]?.instructions[0]?.injectedTools).toHaveLength(256);
    }).pipe(
      Effect.provide(
        Records.layer.pipe(
          Layer.provide(
            Layer.mock(Footprints.InstructionFootprints)({
              list: (threadId, runId) =>
                Effect.succeed([
                  {
                    threadId,
                    runId: runId!,
                    providerInstanceId: ProviderInstanceId.make("claude"),
                    driver: "claude",
                    model: "test",
                    capturedAt: "2026-11-09T12:00:00.000Z",
                    source: "test",
                    injectedToolCount: 256,
                    injectedTools: Array.from(
                      { length: 256 },
                      (_, index) => `tool-${index}-${"t".repeat(240)}`,
                    ),
                    instructionSources: Array.from({ length: 64 }, (_, index) => ({
                      path: `/${"s".repeat(480)}/${index}.md`,
                      bytes: 1,
                    })),
                    parts: [],
                  },
                ]),
            }),
          ),
          Layer.provide(ServerSettingsService.layerTest()),
          Layer.provideMerge(Sqlite.layerMemory),
        ),
      ),
    ),
);
