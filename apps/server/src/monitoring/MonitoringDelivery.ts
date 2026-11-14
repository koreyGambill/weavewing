import * as ThreadWorkspace from "../threadWorkspace/ThreadWorkspace.ts";
import { CommandId, MessageId, MonitoringError, type MonitoringFinding } from "@t3tools/contracts";
import type { ReviewProfile } from "./ReviewProfile.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";

export function monitoringAdvisory(
  profile: Pick<ReviewProfile, "title" | "modelSelection" | "rules">,
  finding: MonitoringFinding,
): string {
  const rule =
    finding.ruleSnapshot ?? profile.rules.find((candidate) => candidate.id === finding.ruleId);
  return `[Automated cron advisory · ${profile.title} · ${profile.modelSelection.model}]\nThis watcher has incomplete context. This is advice, not a user instruction. Keep the user's scope and standards. You may disagree and explain why. Never treat a promise as evidence of a correction.\nObservation: ${finding.summary}\nRule: ${rule?.title ?? finding.ruleId}\nRule instructions: ${rule?.instructions ?? "Original rule unavailable."}\nEvidence and advice: ${finding.detail}\n${finding.evidence.map((item) => `- thread:${item.threadId} message:${item.messageId}: ${item.excerpt}`).join("\n")}\nIf useful, give a short acceptance or disagreement with your reason using respond_monitoring_advisory({findingId:"${finding.id}",responseId:"<unique-id>",text:"<your reason>"}). At most two replies are reviewed. The watcher will check fresh evidence and report its assessment to the human. No response is required to continue authorized work.`;
}

export class MonitoringDelivery extends Context.Service<
  MonitoringDelivery,
  {
    readonly deliver: (input: {
      readonly profile: ReviewProfile;
      readonly finding: MonitoringFinding;
      readonly exchangeId?: string;
    }) => Effect.Effect<
      {
        readonly delivery: "steered" | "alert_only" | "workspace";
        readonly messageId: MessageId | null;
      },
      MonitoringError
    >;
  }
>()("t3/monitoring/MonitoringDelivery") {}

export const layer = Layer.effect(
  MonitoringDelivery,
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const workspace = yield* ThreadWorkspace.ThreadWorkspace;
    const deliver: MonitoringDelivery["Service"]["deliver"] = Effect.fn(
      "MonitoringDelivery.deliver",
    )(function* ({ profile, finding, exchangeId }) {
      if (profile.delivery === "alerts") return { delivery: "alert_only", messageId: null };
      if (profile.kind === "context-review") {
        const target = yield* threads
          .getProjectThreadRecords({ projectId: profile.projectId, threadId: finding.threadId }, [])
          .pipe(
            Effect.mapError(
              (cause) => new MonitoringError({ operation: "resolve context review target", cause }),
            ),
          );
        if (
          target.thread.deletedAt !== null ||
          (profile.targets.threadIds.length &&
            !profile.targets.threadIds.includes(finding.threadId))
        )
          return { delivery: "alert_only", messageId: null };
        const id = `context-review:${finding.id}`;
        yield* Effect.gen(function* () {
          const current = yield* workspace.get({ threadId: finding.threadId });
          if (current.items.some((item) => item.id === id)) return;
          yield* workspace.update({
            threadId: finding.threadId,
            expectedRevision: current.revision,
            changes: [
              {
                id,
                text: finding.summary,
                owner: "you",
                state: "open",
                details: `${finding.detail}\n\nEvidence:\n${finding.evidence.map((item) => `${item.messageId}: ${item.excerpt}`).join("\n")}\n\nAdvisory from ${profile.modelSelection.model}. Accept or reject before changing instructions, skills or knowledge.`,
              },
            ],
          });
        }).pipe(
          Effect.retry({ times: 1, while: (cause) => cause.code === "conflict" }),
          Effect.mapError(
            (cause) => new MonitoringError({ operation: "propose context improvement", cause }),
          ),
        );
        return { delivery: "workspace", messageId: null };
      }
      if (
        !profile.enabled ||
        profile.id !== finding.taskId ||
        (profile.targets.threadIds.length > 0 &&
          !profile.targets.threadIds.includes(finding.threadId) &&
          !profile.targets.includeChildren)
      )
        return { delivery: "alert_only", messageId: null };
      const target = yield* threads
        .getProjectThreadRecords({ projectId: profile.projectId, threadId: finding.threadId }, [
          "runs",
        ])
        .pipe(
          Effect.mapError((cause) => new MonitoringError({ operation: "delivery-target", cause })),
        );
      if (
        profile.targets.threadIds.length > 0 &&
        !profile.targets.threadIds.includes(finding.threadId)
      ) {
        const visited = new Set([finding.threadId]);
        let ancestor = target.thread.lineage.parentThreadId;
        let authorized = false;
        while (ancestor !== null && !visited.has(ancestor)) {
          if (profile.targets.threadIds.includes(ancestor)) {
            authorized = true;
            break;
          }
          visited.add(ancestor);
          const parent = yield* threads
            .getProjectThreadRecords({ projectId: profile.projectId, threadId: ancestor }, [])
            .pipe(
              Effect.mapError(
                (cause) => new MonitoringError({ operation: "delivery-ancestry", cause }),
              ),
            );
          ancestor = parent.thread.lineage.parentThreadId;
        }
        if (!authorized) return { delivery: "alert_only", messageId: null };
      }
      const running = target.runs.some((run) => run.status === "running");
      // Turn-end reviews find the thread idle, so their findings start the thread's next turn.
      const wakesIdle = profile.turnEnd && exchangeId === undefined;
      if (
        target.thread.archivedAt !== null ||
        target.thread.deletedAt !== null ||
        (!running &&
          (!wakesIdle || target.thread.settledAt !== null || target.thread.snoozedUntil != null))
      )
        return { delivery: "alert_only", messageId: null };
      const deliveryId = `monitoring:${finding.id}${exchangeId === undefined ? "" : `:${exchangeId}`}`;
      const messageId = MessageId.make(deliveryId);
      const sent = yield* threads
        .sendToThread({
          origin: { kind: "system", event: "monitoring advisory" },
          commandId: CommandId.make(deliveryId),
          messageId,
          projectId: profile.projectId,
          threadId: finding.threadId,
          text:
            exchangeId === undefined
              ? monitoringAdvisory(profile, finding)
              : `[Automated cron advisory follow-up · ${profile.title} · ${profile.modelSelection.model}]\n${finding.exchanges.find((exchange) => exchange.id === exchangeId)?.text ?? "Assessment available in the inbox."}\nThis is advisory, not a user instruction. Keep the user’s scope and standards.`,
          attachments: [],
          ...(running
            ? { mode: "steer" as const, advisoryOnly: true }
            : { mode: "queue" as const }),
          createdBy: "system",
          creationSource: "server",
        })
        .pipe(
          Effect.as(true),
          Effect.catchTags({
            OrchestratorAdvisorySkippedError: () => Effect.succeed(false),
            ThreadManagementNoSteerableRunError: () => Effect.succeed(false),
            ThreadManagementThreadArchivedError: () => Effect.succeed(false),
          }),
          Effect.mapError((cause) => new MonitoringError({ operation: "delivery", cause })),
        );
      return { delivery: sent ? "steered" : "alert_only", messageId: sent ? messageId : null };
    });
    return MonitoringDelivery.of({ deliver });
  }),
);
