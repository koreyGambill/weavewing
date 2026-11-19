import { expect, it } from "@effect/vitest";
import {
  RunId,
  THREAD_TIMELINE_RUN_LIMIT,
  THREAD_USER_TURN_LIMIT,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Timeline from "./ThreadTimeline.ts";

const at = "2026-11-09T12:00:00.000Z";
const ms = (minute: number) => Date.parse(at) + minute * 60_000;
const iso = (minute: number) => DateTime.formatIso(DateTime.makeUnsafe(ms(minute)));

const insertThread = (
  id: string,
  lineage: {
    parentThreadId: string | null;
    relationshipToParent: string | null;
    sideChat?: boolean;
  },
  options: { creationSource?: string; deleted?: boolean } = {},
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const payload = JSON.stringify({
      lineage: { ...lineage, rootThreadId: "root" },
      creationSource: options.creationSource ?? "mcp",
    });
    yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,deleted_at,payload_json) VALUES (${id},'project',${`Title ${id}`},'claude','full-access','default',${at},${at},${options.deleted ? at : null},${payload})`;
  });

const insertRun = (
  threadId: string,
  ordinal: number,
  status: string,
  started: number | null,
  completed: number | null,
  model = "haiku",
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const payload = JSON.stringify({
      modelSelection: { model, instanceId: "claude" },
      startedAt: started === null ? null : iso(started),
    });
    yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id,thread_id,ordinal,provider,status,requested_at,completed_at,payload_json) VALUES (${`${threadId}-${ordinal}`},${threadId},${ordinal},'claude',${status},${iso((started ?? 0) - 1)},${completed === null ? null : iso(completed)},${payload})`;
  });

const run = Effect.fn(function* (threadId: string) {
  return yield* (yield* Timeline.ThreadTimeline).get({ threadId: ThreadId.make(threadId) });
});

const layer = Timeline.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));

it.effect("walks delegated descendants and side chats, not forks, ancestors or siblings", () =>
  Effect.gen(function* () {
    yield* insertThread("root", { parentThreadId: null, relationshipToParent: null });
    yield* insertThread("lead", { parentThreadId: "root", relationshipToParent: "subagent" });
    yield* insertThread("sibling", { parentThreadId: "root", relationshipToParent: "subagent" });
    yield* insertThread("child", { parentThreadId: "lead", relationshipToParent: "subagent" });
    yield* insertThread(
      "native",
      { parentThreadId: "child", relationshipToParent: "subagent" },
      { creationSource: "provider" },
    );
    yield* insertThread("side", {
      parentThreadId: "lead",
      relationshipToParent: "fork",
      sideChat: true,
    });
    yield* insertThread("fork", { parentThreadId: "lead", relationshipToParent: "fork" });
    yield* insertThread(
      "gone",
      { parentThreadId: "lead", relationshipToParent: "subagent" },
      { deleted: true },
    );
    yield* insertThread("gone-child", { parentThreadId: "gone", relationshipToParent: "subagent" });
    yield* insertRun("lead", 1, "completed", 0, 10, "opus");
    yield* insertRun("lead", 2, "running", 30, null, "opus");
    yield* insertRun("lead", 3, "queued", null, null, "opus");
    yield* insertRun("child", 1, "failed", 2, 5);
    yield* insertRun("native", 1, "completed", 3, 4);
    yield* insertRun("side", 1, "interrupted", 6, 7);
    yield* insertRun("fork", 1, "completed", 1, 2);
    yield* insertRun("sibling", 1, "completed", 1, 2);
    yield* insertRun("gone-child", 1, "completed", 1, 2);

    const timeline = yield* run("lead");
    expect(
      timeline.lanes.map(({ threadId, parent, depth, relation }) => ({
        threadId,
        parent: parent === null ? null : timeline.lanes[parent]?.threadId,
        depth,
        relation,
      })),
    ).toEqual(
      expect.arrayContaining([
        { threadId: "lead", parent: null, depth: 0, relation: "self" },
        { threadId: "child", parent: "lead", depth: 1, relation: "delegate" },
        { threadId: "side", parent: "lead", depth: 1, relation: "side-chat" },
        { threadId: "native", parent: "child", depth: 2, relation: "subagent" },
      ]),
    );
    expect(timeline.lanes).toHaveLength(4);
    const laneOf = (index: number) => timeline.lanes[index]?.threadId;
    expect(
      timeline.runs.map((entry) => [
        laneOf(entry.lane),
        entry.ordinal,
        entry.status,
        entry.durationMs,
      ]),
    ).toEqual([
      ["lead", 1, "completed", 10 * 60_000],
      ["child", 1, "failed", 3 * 60_000],
      ["native", 1, "completed", 60_000],
      ["side", 1, "interrupted", 60_000],
      ["lead", 2, "running", null],
    ]);
    expect(timeline.models[timeline.runs[0]?.model ?? -1]).toBe("opus");
    expect(timeline.runs[0]).toMatchObject({ queuedMs: 60_000, startedAt: ms(0) });
    expect(timeline.totals).toEqual({
      runs: 5,
      firstStartedAt: ms(0),
      lastCompletedAt: ms(10),
      finishedMs: 15 * 60_000,
      finishedMsByModel: [
        { model: "opus", ms: 10 * 60_000 },
        { model: "haiku", ms: 5 * 60_000 },
      ],
    });
  }).pipe(Effect.provide(layer)),
);

it.effect("keeps the latest runs past the cap and totals every run", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* insertThread("root", { parentThreadId: null, relationshipToParent: null });
    const count = THREAD_TIMELINE_RUN_LIMIT + 5;
    yield* sql`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${count})
      INSERT INTO orchestration_v2_projection_runs (run_id,thread_id,ordinal,provider,status,requested_at,completed_at,payload_json)
      SELECT 'run-' || i, 'root', i, 'claude', 'completed',
        strftime('%Y-%m-%dT%H:%M:%fZ', ${at}, '+' || i || ' minutes'),
        strftime('%Y-%m-%dT%H:%M:%fZ', ${at}, '+' || i || ' minutes', '+30 seconds'),
        json_object('startedAt', strftime('%Y-%m-%dT%H:%M:%fZ', ${at}, '+' || i || ' minutes'),
          'modelSelection', json_object('model', 'haiku'))
      FROM n`;
    const timeline = yield* run("root");
    expect(timeline.runs).toHaveLength(THREAD_TIMELINE_RUN_LIMIT);
    expect(timeline.runs[0]?.ordinal).toBe(6);
    expect(timeline.runs.at(-1)?.ordinal).toBe(count);
    expect(timeline.totals).toMatchObject({ runs: count, finishedMs: count * 30_000 });
  }).pipe(Effect.provide(layer)),
);

it.effect("fails for a missing thread", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(run("missing"));
    expect(error.message).toBe("This thread is unavailable.");
  }).pipe(Effect.provide(layer)),
);

const insertItem = (
  ordinal: number,
  type: string,
  fields: Record<string, unknown>,
  runId: string | null = null,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const payload = JSON.stringify({ startedAt: iso(ordinal), ...fields });
    yield* sql`INSERT INTO orchestration_v2_projection_turn_items (turn_item_id,thread_id,run_id,ordinal,type,status,updated_at,payload_json) VALUES (${`item-${ordinal}`},'root',${runId},${ordinal},${type},'completed',${at},${payload})`;
  });

const userTurns = Effect.fn(function* (threadId: string) {
  return yield* (yield* Timeline.ThreadTimeline).userTurns({ threadId: ThreadId.make(threadId) });
});

it.effect("finds a recorded fork's source message independently of the turn rail window", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* insertRun("root", 1, "completed", 0, 1);
    yield* sql`UPDATE orchestration_v2_projection_runs
      SET payload_json = json_set(payload_json, '$.userMessageId', 'source-message')
      WHERE run_id = 'root-1'`;
    const timeline = yield* Timeline.ThreadTimeline;
    const sourceRunId = RunId.make("root-1");
    expect(yield* timeline.userTurns({ threadId: ThreadId.make("root"), sourceRunId })).toEqual({
      turns: [],
      sourceMessageId: "source-message",
    });
    expect(yield* timeline.userTurns({ threadId: ThreadId.make("other"), sourceRunId })).toEqual({
      turns: [],
    });
  }).pipe(Effect.provide(layer)),
);

it.effect("lists the user's own turns with each turn's last reply, newest first capped", () =>
  Effect.gen(function* () {
    const own = (ordinal: number, extra: Record<string, unknown> = {}) =>
      insertItem(ordinal, "user_message", {
        messageId: `m${ordinal}`,
        createdBy: "user",
        text: `ask ${ordinal}`,
        ...extra,
      });
    const reply = (ordinal: number, text: string) =>
      insertItem(ordinal, "assistant_message", { messageId: `a${ordinal}`, text });
    yield* own(1, { text: "x".repeat(500) });
    yield* reply(2, "first reply");
    yield* reply(3, "y".repeat(500));
    yield* own(4, { origin: { kind: "user" } });
    yield* insertItem(5, "user_message", {
      messageId: "m5",
      createdBy: "user",
      origin: { kind: "subagent", threadId: "child", title: "Child", event: "completed" },
      text: "report",
    });
    yield* reply(6, "reply to the report");
    yield* insertItem(7, "user_message", { messageId: "m7", createdBy: "agent", text: "agent" });
    yield* insertItem(8, "user_message", {
      messageId: "m8",
      scheduledTaskId: "task",
      text: "auto",
    });
    yield* insertItem(9, "user_message", {
      messageId: "m9",
      linkedSender: { threadId: "peer", environmentId: "env", title: "Peer" },
      text: "linked",
    });
    yield* own(10, { createdBy: undefined });

    const { turns } = yield* userTurns("root");
    expect(turns.map(({ messageId, replyText }) => [messageId, replyText])).toEqual([
      ["m1", "y".repeat(300)],
      ["m4", null],
      ["m10", null],
    ]);
    expect(turns[0]).toMatchObject({ createdAt: iso(1), text: "x".repeat(200) });
    expect(yield* userTurns("missing")).toEqual({ turns: [] });

    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      WITH RECURSIVE n(i) AS (SELECT 11 UNION ALL SELECT i + 1 FROM n WHERE i < ${10 + THREAD_USER_TURN_LIMIT})
      INSERT INTO orchestration_v2_projection_turn_items (turn_item_id,thread_id,ordinal,type,status,updated_at,payload_json)
      SELECT 'item-' || i, 'root', i, 'user_message', 'completed', ${at},
        json_object('messageId', 'm' || i, 'createdBy', 'user', 'text', 'more', 'startedAt', ${at})
      FROM n`;
    const capped = (yield* userTurns("root")).turns;
    expect(capped).toHaveLength(THREAD_USER_TURN_LIMIT);
    expect(capped[0]?.messageId).toBe("m11");
    expect(capped.at(-1)?.messageId).toBe(`m${10 + THREAD_USER_TURN_LIMIT}`);
  }).pipe(Effect.provide(layer)),
);

it.effect("leaves out inputs and replies the conversation hides", () =>
  Effect.gen(function* () {
    const input = (ordinal: number, run: number, inputIntent = "queued_turn") =>
      insertItem(
        ordinal,
        "user_message",
        { messageId: `m${ordinal}`, createdBy: "user", text: `ask ${ordinal}`, inputIntent },
        `root-${run}`,
      );
    const reply = (ordinal: number, run: number) =>
      insertItem(
        ordinal,
        "assistant_message",
        { messageId: `a${ordinal}`, text: `re ${ordinal}` },
        `root-${run}`,
      );
    yield* insertRun("root", 1, "completed", 0, 1);
    yield* insertRun("root", 2, "queued", null, null);
    yield* insertRun("root", 3, "cancelled", null, 3);
    yield* insertRun("root", 4, "cancelled", 4, 5);
    yield* insertRun("root", 5, "rolled_back", 6, 7);
    yield* input(1, 1, "turn_start");
    yield* input(2, 2);
    yield* input(3, 3);
    yield* reply(4, 1);
    yield* input(5, 4);
    yield* input(6, 5, "turn_start");
    yield* reply(7, 5);

    const { turns } = yield* userTurns("root");
    expect(turns.map(({ messageId, replyText }) => [messageId, replyText])).toEqual([
      ["m1", "re 4"],
      ["m5", null],
    ]);
  }).pipe(Effect.provide(layer)),
);
