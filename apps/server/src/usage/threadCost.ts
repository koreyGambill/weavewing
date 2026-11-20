import {
  ProviderInstanceId,
  type ThreadCost,
  type ThreadCostEntry,
  type ThreadId,
  TurnTokenUsage,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { turnUsage } from "../scheduledTasks/RunHistory.ts";
import * as UsageService from "./UsageService.ts";

const decodeUsage = Schema.decodeUnknownOption(Schema.fromJsonString(TurnTokenUsage));

/**
 * The thread's main-agent and native-subagent tokens at list price, per provider instance, so a
 * client can count only the instances it bills by usage. Turns are priced one at a time because
 * rates can be tiered by prompt size.
 */
export const readThreadCost = Effect.fn("UsageThreadCost.read")(function* (threadId: ThreadId) {
  const sql = yield* SqlClient.SqlClient;
  const usage = yield* UsageService.UsageService;
  const turns = yield* sql<{
    instance_id: string | null;
    usage_json: string | null;
    model: string | null;
  }>`
    SELECT p.provider_instance_id AS instance_id,
      json_extract(t.payload_json, '$.turnTokenUsage') AS usage_json,
      json_extract(t.payload_json, '$.model') AS model
    FROM orchestration_v2_projection_provider_turns t
    JOIN orchestration_v2_projection_provider_threads p
      ON p.provider_thread_id = t.provider_thread_id
    WHERE t.thread_id = ${threadId}`.pipe(NodeSqliteClient.readOnly);
  const [subagentModel] = yield* sql<{ model: string }>`
    SELECT json_extract(payload_json, '$.model') AS model
    FROM orchestration_v2_projection_subagents
    WHERE thread_id = ${threadId} AND origin = 'provider_native'
      AND json_extract(payload_json, '$.model') IS NOT NULL
    GROUP BY model ORDER BY COUNT(*) DESC, model LIMIT 1`.pipe(NodeSqliteClient.readOnly);

  const entries = new Map<string, { -readonly [K in keyof ThreadCostEntry]: ThreadCostEntry[K] }>();
  for (const turn of turns) {
    if (turn.instance_id === null || turn.usage_json === null) continue;
    const decoded = decodeUsage(turn.usage_json);
    if (Option.isNone(decoded)) continue;
    const used = turnUsage(decoded.value, turn.model, subagentModel?.model ?? null);
    if (used === null) continue;
    let entry = entries.get(turn.instance_id);
    if (entry === undefined) {
      entry = {
        providerInstanceId: ProviderInstanceId.make(turn.instance_id),
        tokens: 0,
        costUsd: null,
        unpricedTokens: 0,
        otherTokens: 0,
        otherCostUsdEstimate: null,
      };
      entries.set(turn.instance_id, entry);
    }
    entry.tokens += used.tokens;
    const cost = used.record === null ? null : yield* usage.priceRecords([used.record]);
    if (cost === null) entry.unpricedTokens += used.tokens;
    else entry.costUsd = (entry.costUsd ?? 0) + cost;
    if (used.otherTokens === null) continue;
    entry.otherTokens += used.otherTokens;
    const otherCost =
      used.otherRecord === null ? null : yield* usage.priceRecords([used.otherRecord]);
    if (otherCost !== null)
      entry.otherCostUsdEstimate = (entry.otherCostUsdEstimate ?? 0) + otherCost;
  }
  const result: ThreadCost = { instances: [...entries.values()] };
  return result;
});
