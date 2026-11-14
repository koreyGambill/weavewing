import type { ScheduledTaskId } from "@t3tools/contracts";

const TITLE_MAX = 120;
const BODY_MAX = 4000;

export const clip = (text: string, max: number) => {
  if (text.length <= max) return text;
  // Never end on the first half of a surrogate pair.
  const cut = /[\uD800-\uDBFF]/.test(text[max - 2] ?? "") ? max - 2 : max - 1;
  return `${text.slice(0, cut).trimEnd()}…`;
};

const OUTCOMES: Record<string, string> = {
  corrected: "Corrected",
  accepted_explanation: "Accepted explanation",
  unresolved: "Unresolved",
  unverified: "Unverified · no verified correction",
};

/** Plain strings, so the fold migration can pass the stored payloads it reads. */
interface FindingContent {
  readonly detail: string;
  readonly evidence: ReadonlyArray<{ threadId: string; messageId: string; excerpt: string }>;
  readonly exchanges: ReadonlyArray<{ at: string; role: string; text: string }>;
  readonly outcome: string | null;
}

export const reviewNotificationTitle = (finding: { readonly summary: string }) =>
  clip(finding.summary, TITLE_MAX);

/** The finding's report as the inbox shows it; the latest discussion is kept when it overflows. */
export function reviewNotificationBody(finding: FindingContent): string {
  const head = [
    finding.detail,
    `**Evidence**\n${finding.evidence.map((item) => `- ${item.excerpt} (thread ${item.threadId}, message ${item.messageId})`).join("\n")}`,
  ].join("\n\n");
  const discussion = finding.exchanges.map(
    (exchange) =>
      `**${exchange.role === "agent" ? "Lead agent" : exchange.role === "monitor" ? "Reviewer" : "You"}** · ${exchange.at}\n${exchange.text}`,
  );
  const outcome =
    finding.outcome === null ? "" : `**Outcome:** ${OUTCOMES[finding.outcome] ?? finding.outcome}`;
  const tail = [
    ...(discussion.length > 0 ? [`**Discussion**\n\n${discussion.join("\n\n")}`] : []),
    ...(outcome ? [outcome] : []),
  ].join("\n\n");
  if (tail === "") return clip(head, BODY_MAX);
  const room = BODY_MAX - tail.length - 2;
  return room >= 200
    ? `${clip(head, room)}\n\n${tail}`
    : clip(`${clip(head, 1000)}\n\n${tail.slice(-(BODY_MAX - 1004))}`, BODY_MAX);
}

/** The key NotificationService stores for a finding raised with its id as the dedupe key. */
export const reviewNotificationDedupeKey = (taskId: ScheduledTaskId | string, findingId: string) =>
  `review:${taskId}:${findingId}\n${findingId}`;
