// @effect-diagnostics-next-line nodeBuiltinImport:off - a synchronous digest of one message body.
import * as NodeCrypto from "node:crypto";
import type { OrchestrationV2ConversationMessage } from "@t3tools/contracts";

/** Shorter bodies read well enough from their first line to not pay for a summary. */
const MIN_SUMMARY_SOURCE_CHARS = 300;

/** Identifies the text a summary was written from, so an edit in flight can reject it. */
export const messageSummarySourceHash = (text: string) =>
  NodeCrypto.createHash("sha256").update(text).digest("hex");

/** What sent an incoming card, for the summary prompt; null for messages that need no summary. */
export function incomingCardSummarySource(
  message: OrchestrationV2ConversationMessage,
): string | null {
  const origin = message.origin;
  if (
    message.role !== "user" ||
    message.streaming ||
    message.summary !== undefined ||
    message.idleCompaction !== undefined ||
    // Notification messages render as work rows with their own one-line label.
    message.notification !== undefined ||
    message.workflowScript === true ||
    origin === undefined ||
    origin.kind === "user"
  )
    return null;
  if (message.text.trim().length < MIN_SUMMARY_SOURCE_CHARS) return null;
  switch (origin.kind) {
    case "thread":
      return `Message from another agent's thread "${origin.title}"`;
    case "subagent":
      return `${origin.event === "failed" ? "Failure report" : "Report"} from delegated task "${origin.title}"`;
    case "scheduled-task":
      return `Scheduled task "${origin.title}"`;
    // T3 Code's own notices are most of the volume and rarely need more than their first line.
    case "wake":
    case "system":
      return null;
  }
}
