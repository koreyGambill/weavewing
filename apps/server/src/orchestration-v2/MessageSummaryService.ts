import { CommandId, type MessageId, type ThreadId } from "@t3tools/contracts";
import * as NodeOS from "node:os";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { settingsForThread } from "@t3tools/shared/serverSettings";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import { incomingCardSummarySource, messageSummarySourceHash } from "./incomingCardSummary.ts";

/** Attempts per UTC day, failures included; past it cards keep their first line until tomorrow. */
const DAILY_SUMMARY_LIMIT = 100;

export class MessageSummaryService extends Context.Service<
  MessageSummaryService,
  {
    readonly execute: (input: {
      readonly threadId: ThreadId;
      readonly messageId: MessageId;
    }) => Effect.Effect<void>;
  }
>()("t3/orchestration-v2/MessageSummaryService") {}

const make = Effect.fn("MessageSummaryService.make")(function* (dailyLimit: number) {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const sql = yield* SqlClient.SqlClient;

  // Reserved before the call and never released, so a restart or replay cannot pay twice.
  const reserveAttempt = Effect.fn("MessageSummaryService.reserveAttempt")(function* (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
  }) {
    const now = yield* DateTime.now;
    const day = DateTime.formatIsoDateUtc(now);
    const reserved = yield* sql`
      INSERT INTO message_summary_attempts (thread_id, message_id, day, attempted_at)
      SELECT ${input.threadId}, ${input.messageId}, ${day}, ${DateTime.formatIso(now)}
      WHERE (SELECT COUNT(*) FROM message_summary_attempts WHERE day = ${day}) < ${dailyLimit}
      ON CONFLICT DO NOTHING
      RETURNING message_id`;
    return reserved.length > 0;
  });

  const execute: MessageSummaryService["Service"]["execute"] = Effect.fn(
    "MessageSummaryService.execute",
  )(
    function* (input) {
      const settings = yield* serverSettings.getSettings;
      if (!settings.incomingCardSummaries) return;
      const { thread, messages } = yield* threads.getThreadRecords(input.threadId, ["messages"], {
        messageIds: [input.messageId],
      });
      const message = messages.find((candidate) => candidate.id === input.messageId);
      const source = message === undefined ? null : incomingCardSummarySource(message);
      const generate = textGeneration.generateMessageSummary;
      if (!generate || message === undefined || source === null || !(yield* reserveAttempt(input)))
        return;
      const { summary } = yield* generate({
        // A summary needs no project, so the thread's provider runs it from a temp dir.
        cwd: NodeOS.tmpdir(),
        source,
        message: message.text,
        modelSelection: settingsForThread(settings, thread.modelSelection)
          .textGenerationModelSelection,
      });
      if (summary.length === 0) return;
      yield* threads.dispatch({
        type: "message.summary.set",
        commandId: CommandId.make(`message-summary:${input.threadId}:${input.messageId}`),
        threadId: input.threadId,
        messageId: input.messageId,
        summary,
        sourceHash: messageSummarySourceHash(message.text),
      });
    },
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("Message summary generation failed", { cause }),
    ),
  );

  return MessageSummaryService.of({ execute });
});

export const layer = Layer.effect(MessageSummaryService, make(DAILY_SUMMARY_LIMIT));
export const layerWithDailyLimit = (dailyLimit: number) =>
  Layer.effect(MessageSummaryService, make(dailyLimit));
