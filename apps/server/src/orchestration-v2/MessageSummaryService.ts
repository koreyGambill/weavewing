import {
  CommandId,
  OrchestrationV2PrepareSummaryHandoffError,
  type OrchestrationV2RpcSchemas,
  type MessageId,
  type ThreadId,
  latestProviderTurnForAttempt,
} from "@t3tools/contracts";
import * as NodeOS from "node:os";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { settingsForThread } from "@t3tools/shared/serverSettings";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { HANDOFF_SUMMARY_INPUT_LIMIT } from "@t3tools/provider-core/server/textGenerationPrompts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import { incomingCardSummarySource, messageSummarySourceHash } from "./incomingCardSummary.ts";

/** Attempts per UTC day, failures included; past it cards keep their first line until tomorrow. */
const DAILY_SUMMARY_LIMIT = 100;

export class MessageSummaryService extends Context.Service<
  MessageSummaryService,
  {
    readonly prepareHandoff: (
      input: typeof OrchestrationV2RpcSchemas.prepareSummaryHandoff.input.Type,
    ) => Effect.Effect<
      typeof OrchestrationV2RpcSchemas.prepareSummaryHandoff.output.Type,
      OrchestrationV2PrepareSummaryHandoffError
    >;
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
  const projects = yield* ProjectStore.ProjectStoreV2;

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
        modelSelection: settingsForThread(
          resolveProjectSettings(settings, thread.projectId).settings,
          thread.modelSelection,
        ).textGenerationModelSelection,
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

  const preparePortableHandoff = Effect.fn("MessageSummaryService.preparePortableHandoff")(
    function* (threadId: ThreadId) {
      const { thread } = yield* threads
        .getThreadRecords(threadId, [])
        .pipe(Effect.mapError((cause) => new OrchestrationV2PrepareSummaryHandoffError({ cause })));
      if (thread.deletedAt !== null) {
        return yield* new OrchestrationV2PrepareSummaryHandoffError({
          cause: "Thread was deleted.",
        });
      }
      const page = yield* threads
        .getTimelinePage(threadId, {
          view: "messages",
          beforePosition: Number.POSITIVE_INFINITY,
          limit: 100,
        })
        .pipe(Effect.mapError((cause) => new OrchestrationV2PrepareSummaryHandoffError({ cause })));
      const history = page.items.flatMap(({ item }) => {
        if (item.type === "user_message" && !item.workflowScript && item.text.trim()) {
          return [{ label: "User", text: item.text.trim() }];
        }
        if (
          item.type === "assistant_message" &&
          !item.streaming &&
          item.phase !== "commentary" &&
          item.text.trim()
        ) {
          return [{ label: "Assistant", text: item.text.trim() }];
        }
        return [];
      });
      if (history.length === 0)
        return { kind: "empty", text: "", truncated: page.hasEarlier } as const;

      const excerpt: string[] = [];
      let remaining = HANDOFF_SUMMARY_INPUT_LIMIT;
      let truncated = page.hasEarlier;
      for (const { label, text } of history.toReversed()) {
        const entry = `${label}: ${text}`;
        if (entry.length + 2 > remaining) {
          truncated = true;
          if (excerpt.length === 0) {
            excerpt.push(`${label}: …${text.slice(-(remaining - label.length - 4))}`);
          }
          break;
        }
        excerpt.push(entry);
        remaining -= entry.length + 2;
      }
      const transcript = excerpt.reverse().join("\n\n");
      const settings = yield* serverSettings.getSettings.pipe(Effect.orElseSucceed(() => null));
      const generated =
        settings && textGeneration.generateMessageSummary
          ? yield* textGeneration
              .generateMessageSummary({
                cwd: NodeOS.tmpdir(),
                source: "Conversation handoff",
                message: transcript,
                purpose: "handoff",
                modelSelection: settingsForThread(
                  resolveProjectSettings(settings, thread.projectId).settings,
                  thread.modelSelection,
                ).textGenerationModelSelection,
              })
              .pipe(Effect.orElseSucceed(() => null))
          : null;
      return generated?.summary.trim()
        ? ({ kind: "summary", text: generated.summary, truncated } as const)
        : ({ kind: "excerpt", text: transcript, truncated } as const);
    },
  );

  const nativeUnavailable = (reason: string) => ({ kind: "native_unavailable", reason }) as const;
  const prepareNativeHandoff = Effect.fn("MessageSummaryService.prepareNativeHandoff")(function* (
    sourceThreadId: ThreadId,
  ) {
    const generate = textGeneration.generateNativeHandoffSummary;
    const { thread, runs, providerThreads, providerTurns } = yield* threads
      .getThreadRecords(sourceThreadId, ["runs", "providerThreads", "providerTurns"])
      .pipe(Effect.mapError((cause) => new OrchestrationV2PrepareSummaryHandoffError({ cause })));
    const boundary = runs.findLast(
      (run) => run.status === "completed" && run.ordinal > (thread.contextRewind?.runOrdinal ?? 0),
    );
    if (!boundary || thread.deletedAt !== null) {
      return nativeUnavailable(
        "Native preparation needs a completed turn in the source conversation.",
      );
    }
    const providerThread = providerThreads.find(
      (candidate) => candidate.id === boundary.providerThreadId,
    );
    const providerTurn = latestProviderTurnForAttempt(
      providerTurns.filter((candidate) => candidate.providerThreadId === providerThread?.id),
      boundary.activeAttemptId,
    );
    const sessionRef = providerThread?.nativeThreadRef;
    const turnRef = providerTurn?.nativeTurnRef;
    if (
      !generate ||
      !sessionRef?.nativeId ||
      sessionRef.strength !== "strong" ||
      providerThread?.providerInstanceId !== boundary.modelSelection.instanceId ||
      !turnRef?.nativeId ||
      turnRef.driver !== sessionRef.driver ||
      providerTurn?.status !== "completed"
    ) {
      return nativeUnavailable("The source turn has no usable native conversation boundary.");
    }
    const cwd =
      thread.worktreePath ??
      (yield* projects.get(thread.projectId).pipe(
        Effect.map(Option.map((project) => project.workspaceRoot)),
        Effect.map(Option.getOrUndefined),
        Effect.orElseSucceed(() => undefined),
      ));
    if (cwd === undefined) {
      return nativeUnavailable("The source conversation workspace is unavailable.");
    }
    return yield* generate({
      cwd,
      sourceDriver: sessionRef.driver,
      nativeSessionId: sessionRef.nativeId,
      nativeTurnId: turnRef.nativeId,
      modelSelection: boundary.modelSelection,
    }).pipe(
      Effect.map(({ summary }) => {
        const text = summary.trim();
        return text
          ? ({ kind: "native_summary", text, truncated: false } as const)
          : nativeUnavailable("The native summary returned no text.");
      }),
      Effect.catch((error) =>
        Effect.logDebug("Native summary preparation was unavailable", {
          detail: error.detail,
        }).pipe(
          Effect.as(
            nativeUnavailable("The source provider could not prepare a tool-free native summary."),
          ),
        ),
      ),
    );
  });

  const prepareHandoff: MessageSummaryService["Service"]["prepareHandoff"] = (input) =>
    input.strategy === "portable"
      ? preparePortableHandoff(input.threadId)
      : prepareNativeHandoff(input.threadId);
  return MessageSummaryService.of({ execute, prepareHandoff });
});

export const layer = Layer.effect(MessageSummaryService, make(DAILY_SUMMARY_LIMIT));
export const layerWithDailyLimit = (dailyLimit: number) =>
  Layer.effect(MessageSummaryService, make(dailyLimit));
