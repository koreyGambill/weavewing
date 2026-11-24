// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import {
  DEFAULT_LOAD_WATCHERS,
  OrchestrationV2TurnItemJson,
  TurnTokenUsage,
  TurnContextRecord,
  ThreadInsightsError,
  RunId,
  ProviderInstanceId,
  ThreadContextGetInput,
  type ThreadContextResult,
  type ThreadContextRead,
  type OrchestrationV2RunStatus,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Footprints from "./InstructionFootprints.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { projectLoadEvent } from "./insightProjection.ts";

const decodeItem = Schema.decodeEffect(Schema.fromJsonString(OrchestrationV2TurnItemJson));
const encodeRecord = Schema.encodeEffect(Schema.fromJsonString(TurnContextRecord));
const isInsightsError = Schema.is(ThreadInsightsError);
const decodeInput = Schema.decodeEffect(ThreadContextGetInput);
const decodeUsage = Schema.decodeEffect(Schema.fromJsonString(TurnTokenUsage));
export class ContextRecords extends Context.Service<
  ContextRecords,
  {
    readonly get: (
      input: ThreadContextGetInput,
    ) => Effect.Effect<ThreadContextResult, ThreadInsightsError>;
  }
>()("t3/threadInsights/ContextRecords") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const footprints = yield* Footprints.InstructionFootprints;
  const settings = yield* ServerSettingsService;
  return ContextRecords.of({
    get: Effect.fn("ContextRecords.get")(
      function* (input) {
        yield* decodeInput(input).pipe(
          Effect.mapError(
            (cause) =>
              new ThreadInsightsError({ message: "Invalid context record request.", cause }),
          ),
        );
        const threads =
          yield* sql`SELECT thread_id FROM orchestration_v2_projection_threads WHERE thread_id=${input.threadId} AND deleted_at IS NULL`;
        if (!threads.length)
          return yield* new ThreadInsightsError({ message: "Thread context is unavailable." });
        const watchers = yield* settings.getSettings.pipe(
          Effect.map((value) => value.loadWatchers),
          Effect.orElseSucceed(() => DEFAULT_LOAD_WATCHERS),
        );
        const limit = input.limit ?? 10;
        const rows = yield* sql<{
          run_id: string;
          ordinal: number;
          requested_at: string;
          model: string;
          provider: string;
          status: OrchestrationV2RunStatus;
          cwd: string | null;
        }>`
        SELECT r.run_id, r.ordinal, r.requested_at, r.provider, r.status,
          COALESCE(json_extract(r.payload_json, '$.modelSelection.model'), '') AS model,
          COALESCE(
            (SELECT json_extract(s.payload_json, '$.cwd') FROM orchestration_v2_projection_checkpoint_scopes s
              WHERE s.thread_id=r.thread_id AND s.run_id=r.run_id AND s.kind='root_run' ORDER BY s.created_at DESC LIMIT 1),
            (SELECT json_extract(s.payload_json, '$.cwd') FROM orchestration_v2_projection_provider_sessions s
              JOIN orchestration_v2_projection_provider_threads p ON p.provider_session_id=s.provider_session_id
              WHERE p.provider_thread_id=r.provider_thread_id LIMIT 1)
          ) AS cwd
        FROM orchestration_v2_projection_runs r WHERE r.thread_id=${input.threadId}
          AND status != 'queued'
          AND ${input.beforeOrdinal === undefined ? sql`1` : sql`ordinal < ${input.beforeOrdinal}`}
        ORDER BY ordinal DESC LIMIT ${limit + 1}`;
        const records: ThreadContextResult["records"][number][] = [];
        const recordBudget = (input.maxBytes ?? 160_000) - 2048;
        let remaining = recordBudget;
        let payloadLimited = false;
        for (const row of rows.slice(0, limit)) {
          const runId = RunId.make(row.run_id);
          // Outputs stay in SQLite; only their byte counts enter this projection.
          const items = yield* sql<{ payload_json: string | null; output_bytes: number | null }>`
          WITH recent AS (
            SELECT payload_json FROM orchestration_v2_projection_turn_items
            WHERE thread_id=${input.threadId} AND run_id=${runId}
              AND type IN ('command_execution','dynamic_tool','file_search')
            ORDER BY ordinal LIMIT 501
          )
          SELECT CASE WHEN length(json_remove(payload_json, '$.output')) <= 65536
            AND length(COALESCE(json_extract(payload_json,'$.input'),'')) <= 16000
            THEN json_remove(payload_json, '$.output') ELSE NULL END AS payload_json,
            length(CAST(json_extract(payload_json, '$.output') AS BLOB)) AS output_bytes
          FROM recent`;
          const reads = new Map<string, ThreadContextRead>();
          let truncated = items.length > 500 || items.some((item) => item.payload_json === null);
          for (const item of items.slice(0, 500)) {
            if (item.payload_json === null) continue;
            const event = projectLoadEvent(yield* decodeItem(item.payload_json), watchers);
            if (!event || event.status !== "completed") continue;
            const filePaths =
              event.kind === "file" || event.kind === "skill" || event.kind === "instructions"
                ? event.paths.filter((path) => path.length > 0 && !/^[\w+.-]+:\/\//.test(path))
                : [];
            const labels =
              filePaths.length === 0
                ? [event.label]
                : filePaths.map((path) => {
                    const paths = /^[A-Za-z]:[\\/]/.test(row.cwd ?? path)
                      ? NodePath.win32
                      : NodePath.posix;
                    return row.cwd === null ? paths.normalize(path) : paths.resolve(row.cwd, path);
                  });
            for (const label of labels) {
              const repeatable =
                filePaths.length > 0 || (event.kind === "resource" && label !== event.toolName);
              const key = `${repeatable ? event.kind : event.itemId}:${label}`;
              const previous = reads.get(key);
              if (!previous && reads.size >= 64) {
                truncated = true;
                continue;
              }
              reads.set(key, {
                key,
                kind: event.kind,
                label: label.slice(0, 512),
                count: (previous?.count ?? 0) + 1,
                outputBytes:
                  item.output_bytes === null
                    ? (previous?.outputBytes ?? null)
                    : (previous?.outputBytes ?? 0) + item.output_bytes,
                evidence: event.evidence,
              });
            }
          }
          const turns = yield* sql<{ usage_json: string | null }>`
          SELECT json_extract(t.payload_json, '$.turnTokenUsage') AS usage_json
          FROM orchestration_v2_projection_provider_turns t
          JOIN orchestration_v2_projection_run_attempts a ON a.attempt_id=t.run_attempt_id
          WHERE t.thread_id=${input.threadId} AND a.run_id=${runId} ORDER BY t.ordinal LIMIT 101`;
          const usage = yield* Effect.forEach(turns.slice(0, 100), (turn) =>
            turn.usage_json === null ? Effect.succeed(null) : decodeUsage(turn.usage_json),
          );
          const total = (field: "inputTokens" | "cachedInputTokens" | "outputTokens") => {
            const known = usage.flatMap((value) => (value?.[field] == null ? [] : [value[field]]));
            return known.length ? known.reduce((sum, value) => sum + value, 0) : null;
          };
          const instructions = yield* footprints.list(input.threadId, runId);
          const boundedInstructions = instructions
            .slice(-8)
            .map(({ injectedTools, ...footprint }) => ({
              ...footprint,
              source: footprint.source.slice(0, 512),
              parts: footprint.parts.slice(0, 64).map((part) => ({
                ...part,
                key: part.key.slice(0, 512),
                label: part.label.slice(0, 512),
              })),
              ...(input.includeInjectedTools === false
                ? {}
                : { injectedTools: injectedTools?.slice(0, 256) }),
              injectedToolCount: footprint.injectedToolCount ?? injectedTools?.length,
              instructionSources: footprint.instructionSources?.slice(0, 64),
            }));
          const grouped = [...reads.values()];
          const record: ThreadContextResult["records"][number] = {
            runId,
            status: row.status,
            ordinal: row.ordinal,
            model: row.model.slice(0, 256),
            providerInstanceId: ProviderInstanceId.make(row.provider),
            startedAt: row.requested_at,
            instructions: boundedInstructions,
            reads: grouped,
            repeatedReads: grouped.reduce((sum, read) => sum + Math.max(0, read.count - 1), 0),
            inputTokens: total("inputTokens"),
            cachedInputTokens: total("cachedInputTokens"),
            cachedInputTokensStatus:
              total("cachedInputTokens") === null
                ? "unavailable"
                : usage.every(
                      (value) =>
                        value?.cachedInputTokens != null && value.usageStatus === "complete",
                    ) && turns.length <= 100
                  ? "complete"
                  : "partial",
            outputTokens: total("outputTokens"),
            usageStatus:
              !usage.length ||
              usage.every((value) => value === null || value.usageStatus === "unavailable")
                ? "unavailable"
                : usage.every((value) => value?.usageStatus === "complete") && turns.length <= 100
                  ? "complete"
                  : "partial",
            truncated:
              truncated ||
              turns.length > 100 ||
              instructions.length > 8 ||
              instructions.some((item) => item.truncated),
          };
          let size = new TextEncoder().encode(yield* encodeRecord(record)).byteLength;
          while (size > recordBudget) {
            Object.assign(record, {
              truncated: true,
              reads: record.reads.slice(0, Math.floor(record.reads.length / 2)),
              instructions: record.instructions.slice(-1).map((item) => ({
                ...item,
                source: item.source.slice(0, 512),
                parts: item.parts.slice(0, Math.floor(item.parts.length / 2)),
                ...(item.injectedTools === undefined
                  ? {}
                  : {
                      injectedTools: item.injectedTools.slice(
                        0,
                        Math.floor(item.injectedTools.length / 2),
                      ),
                    }),
                instructionSources: item.instructionSources?.slice(
                  0,
                  Math.floor(item.instructionSources.length / 2),
                ),
              })),
            });
            size = new TextEncoder().encode(yield* encodeRecord(record)).byteLength;
          }
          if (records.length && size > remaining) {
            payloadLimited = true;
            break;
          }
          records.push(record);
          remaining -= size;
        }
        return {
          threadId: input.threadId,
          records,
          nextBeforeOrdinal:
            rows.length > limit || payloadLimited ? (records.at(-1)?.ordinal ?? null) : null,
          coverage:
            "Successful reported tools and inferred shell reads only. Shell paths and sizes do not prove every file was loaded. Combined command output is attributed to each named path. Instruction estimates are UTF-8 bytes / 4; source sizes are filesystem sizes at capture, not tokenizer counts. Hidden harness context and automatic skills may be unavailable. Input is billed input across model calls, not context size. Cached totals are partial when any provider turn omits cache usage; unknown stays unknown. At most 20 runs, 500 items, 64 grouped reads and 8 instruction snapshots per run.",
        };
      },
      Effect.mapError((cause) =>
        isInsightsError(cause)
          ? cause
          : new ThreadInsightsError({ message: "Could not derive context records.", cause }),
      ),
      NodeSqliteClient.readOnly,
    ),
  });
});
export const layer = Layer.effect(ContextRecords, make);
