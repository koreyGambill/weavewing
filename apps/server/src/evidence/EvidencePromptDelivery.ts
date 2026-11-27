import { CommandId, EVIDENCE_PROMPT_ORIGIN_EVENT } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";

import type * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";

type Delivery = Pick<EffectOutbox.OrchestrationEffectV2, "threadId" | "commandId"> & {
  readonly request: Extract<
    EffectOutbox.OrchestrationEffectRequestV2,
    { readonly type: "evidence-prompt.deliver" }
  >;
};

/**
 * Sends a claimed done prompt as a queued system message. Its command and message ids are fixed,
 * so a retry after a restart adds no second message. A thread archived or deleted since the claim,
 * or the setting turned off, withdraws the prompt as `cancelled`; the last failed attempt marks it
 * `failed`, so a claim is always delivered, still owed, or says why not.
 */
export const deliverEvidencePrompt = Effect.fn("EvidencePromptDelivery.deliver")(function* (
  effect: Delivery,
  options: { readonly willRetry: boolean },
) {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const { messageId, projectId, text } = effect.request;
  const settle = (outcome: "cancelled" | "failed") =>
    sql`UPDATE evidence_prompts SET outcome = ${outcome}
      WHERE message_id = ${messageId} AND outcome = 'sent'`;
  // A replay after the message committed has nothing to send and must keep the claim delivered.
  if (yield* threads.hasReceipt(CommandId.make(effect.commandId))) return;
  if (!(yield* settings.getSettings).evidencePromptEnabled) return yield* settle("cancelled");
  const sent = yield* threads
    .sendToThread({
      origin: { kind: "system", event: EVIDENCE_PROMPT_ORIGIN_EVENT },
      commandId: CommandId.make(effect.commandId),
      messageId,
      projectId,
      threadId: effect.threadId,
      text,
      attachments: [],
      mode: "queue",
      createdBy: "system",
      creationSource: "server",
    })
    .pipe(Effect.exit);
  if (Exit.isSuccess(sent)) return;
  const { thread } = yield* projections.getThreadRecords(effect.threadId, []);
  if (thread.archivedAt !== null || thread.deletedAt !== null) return yield* settle("cancelled");
  if (!options.willRetry) yield* settle("failed");
  return yield* Effect.failCause(sent.cause);
});
