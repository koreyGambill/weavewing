import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { readThreadCost } from "./threadCost.ts";
import * as UsageService from "./UsageService.ts";

// $1 per thousand output tokens for the one model with a rate; anything else is unpriced.
const usage = Layer.mock(UsageService.UsageService)({
  priceRecords: (records) =>
    Effect.succeed(
      records.every((record) => record.model === "claude-sonnet-4-6")
        ? records.reduce((sum, record) => sum + record.totals.outputTokens / 1000, 0)
        : null,
    ),
});

it.effect("splits a thread's cost by provider instance and keeps unpriced turns apart", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const threadId = ThreadId.make("thread:cost");
    const providerThread = (id: string, thread: string, instance: string) =>
      sql`INSERT INTO orchestration_v2_projection_provider_threads
        (provider_thread_id, thread_id, provider, provider_instance_id, status, updated_at, payload_json)
        VALUES (${id}, ${thread}, 'claude', ${instance}, 'idle', '2026-01-01T00:00:00Z', '{}')`;
    yield* providerThread("pt:api", threadId, "claudeApi");
    yield* providerThread("pt:sub", threadId, "codexSubscription");
    yield* providerThread("pt:other", "thread:other", "claudeApi");
    const turn = (
      id: string,
      thread: string,
      providerThreadId: string,
      ordinal: number,
      usage: object,
    ) =>
      sql`INSERT INTO orchestration_v2_projection_provider_turns
        (provider_turn_id, thread_id, provider_thread_id, node_id, ordinal, status, payload_json)
        VALUES (${id}, ${thread}, ${providerThreadId}, 'node:root', ${ordinal}, 'completed',
          ${JSON.stringify({ turnTokenUsage: usage })})`;
    const main = (input: number, output: number, model: string, other?: object) => ({
      usageScope: "main_agent",
      usageStatus: "complete",
      hasSubagents: other !== undefined,
      inputTokens: input,
      outputTokens: output,
      models: [model],
      ...(other === undefined ? {} : { otherUsage: other }),
    });
    yield* turn("turn:1", threadId, "pt:api", 1, main(1_000, 2_000, "claude-sonnet-4-6"));
    yield* turn(
      "turn:2",
      threadId,
      "pt:api",
      2,
      main(500, 1_000, "claude-sonnet-4-6", { inputTokens: 100, outputTokens: 3_000 }),
    );
    // A model without a rate still counts its tokens, outside the price.
    yield* turn("turn:3", threadId, "pt:api", 3, main(10, 20, "claude-unknown"));
    yield* turn("turn:4", threadId, "pt:sub", 1, main(7, 8, "gpt-unpriced"));
    yield* turn("turn:5", "thread:other", "pt:other", 1, main(1, 99_000, "claude-sonnet-4-6"));

    const cost = yield* readThreadCost(threadId);
    const byInstance = Object.fromEntries(
      cost.instances.map((entry) => [entry.providerInstanceId, entry]),
    );
    assert.deepStrictEqual(byInstance.claudeApi, {
      providerInstanceId: byInstance.claudeApi!.providerInstanceId,
      tokens: 3_000 + 1_500 + 30,
      costUsd: 3,
      unpricedTokens: 30,
      otherTokens: 3_100,
      otherCostUsdEstimate: 3,
    });
    assert.strictEqual(byInstance.codexSubscription?.costUsd, null);
    assert.strictEqual(byInstance.codexSubscription?.unpricedTokens, 15);
    assert.strictEqual(cost.instances.length, 2);
  }).pipe(Effect.provide(Layer.merge(SqlitePersistence.layerMemory, usage))),
);
