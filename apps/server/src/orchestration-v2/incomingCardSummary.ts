import {
  DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  type ModelSelection,
  type OrchestrationV2ConversationMessage,
  ProviderDriverKind,
  defaultInstanceIdForDriver,
} from "@t3tools/contracts";

const CLAUDE = ProviderDriverKind.make("claudeAgent");
/** Low effort keeps Haiku from thinking past the output cap on a one-line job. */
export const MESSAGE_SUMMARY_MODEL: ModelSelection = {
  instanceId: defaultInstanceIdForDriver(CLAUDE),
  model: DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER[CLAUDE] ?? "claude-haiku-5-5",
  options: [{ id: "effort", value: "low" }],
};

/** The first line already says everything a one-line card can. */
const SHORT_MESSAGE_CHARS = 100;
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
  const text = message.text.trim();
  if (text.length <= SHORT_MESSAGE_CHARS && !/\r?\n/.test(text)) return null;
  switch (origin.kind) {
    case "thread":
      return `Message from another agent's thread "${origin.title}"`;
    case "subagent":
      return `${origin.event === "failed" ? "Failure report" : "Report"} from delegated task "${origin.title}"`;
    case "scheduled-task":
      return `Scheduled task "${origin.title}"`;
    case "wake":
      return `Wake: ${origin.detail}`;
    case "system":
      return `T3 Code (${origin.event})`;
  }
}
