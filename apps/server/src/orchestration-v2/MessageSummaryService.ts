import {
  CommandId,
  DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  type MessageId,
  ProviderDriverKind,
  defaultInstanceIdForDriver,
  type ThreadId,
} from "@t3tools/contracts";
import * as NodeOS from "node:os";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import { incomingCardSummarySource } from "./incomingCardSummary.ts";

/** About 2.5x the expected daily volume; past it cards keep their first line until tomorrow. */
export const DAILY_SUMMARY_LIMIT = 1_000;

const CLAUDE = ProviderDriverKind.make("claudeAgent");
const SUMMARY_MODEL = {
  instanceId: defaultInstanceIdForDriver(CLAUDE),
  model: DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER[CLAUDE] ?? "claude-haiku-5-5",
};

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
  const spent = yield* Ref.make({ day: "", count: 0 });

  const takeBudget = Effect.fn("MessageSummaryService.takeBudget")(function* () {
    const day = DateTime.formatIsoDateUtc(yield* DateTime.now);
    return yield* Ref.modify(spent, (current) => {
      const count = current.day === day ? current.count : 0;
      return count >= dailyLimit ? [false, { day, count }] : [true, { day, count: count + 1 }];
    });
  });

  const execute: MessageSummaryService["Service"]["execute"] = Effect.fn(
    "MessageSummaryService.execute",
  )(
    function* (input) {
      if (!(yield* serverSettings.getSettings).incomingCardSummaries) return;
      const { messages } = yield* threads.getThreadRecords(input.threadId, ["messages"], {
        messageIds: [input.messageId],
      });
      const message = messages.find((candidate) => candidate.id === input.messageId);
      const source = message === undefined ? null : incomingCardSummarySource(message);
      const generate = textGeneration.generateMessageSummary;
      if (!generate || message === undefined || source === null || !(yield* takeBudget())) return;
      const { summary } = yield* generate({
        // Claude summarizes from a temp dir; a fallback provider should not load a project either.
        cwd: NodeOS.tmpdir(),
        source,
        message: message.text,
        modelSelection: SUMMARY_MODEL,
      });
      if (summary.length === 0) return;
      yield* threads.dispatch({
        type: "message.summary.set",
        commandId: CommandId.make(`message-summary:${input.threadId}:${input.messageId}`),
        threadId: input.threadId,
        messageId: input.messageId,
        summary,
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
