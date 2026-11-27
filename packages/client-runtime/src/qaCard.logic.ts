import type { EvidenceChangeQa, EvidenceLanding, EvidenceQaRaiseReason } from "@t3tools/contracts";

export type QaChange = EvidenceLanding["changes"][number];

/** What a QA card says about its change, in the shared card vocabulary. */
export type QaCardStatus =
  | "open"
  | "in-composer"
  | "discussing"
  | "confirmed-by-you"
  | "recorded"
  | "agent-fixing"
  | "dismissed";

/** How a recorded change shows in the thread: a card, one quiet line, or nothing. */
export function qaPresence(qa: EvidenceChangeQa): "card" | "quiet" | "none" {
  if (qa.state === "quiet") return "quiet";
  // A landing from before reasons were kept shows a card only while it still waits on the user.
  if (qa.raised === undefined && qa.state !== "pending") return "none";
  return "card";
}

/** A note: a change recorded without a card that lists gaps or captures, kept in the notes log. */
export function qaNoted(change: Pick<QaChange, "qa" | "gaps" | "captures">): boolean {
  return change.qa.state === "quiet" && (change.gaps.length > 0 || change.captures.length > 0);
}

export function qaCardStatus(qa: EvidenceChangeQa, inComposer: boolean): QaCardStatus {
  switch (qa.state) {
    case "pending":
    case "quiet":
      if (inComposer) return "in-composer";
      return qa.discussedMessageId === undefined ? "open" : "discussing";
    case "problem":
      return "agent-fixing";
    case "confirmed":
      return qa.by === "agent" ? "recorded" : "confirmed-by-you";
    case "waived":
      return qa.by === "agent" ? "recorded" : "dismissed";
  }
}

/** The bold outcome on a settled card's line; none while it waits or when the badge says it all. */
export function qaCardOutcome(qa: EvidenceChangeQa): string | null {
  switch (qa.state) {
    case "confirmed":
      return "Looks good";
    case "problem":
      return "Problem";
    case "waived":
      return qa.by === "agent" ? "Dismissed" : null;
    default:
      return null;
  }
}

const firstLine = (text: string) => text.split("\n", 1)[0]!.trim();

/** The card's title: the change's summary, else the user's ask. */
export function qaCardTitle(change: Pick<QaChange, "summary" | "ask" | "id">): string {
  return firstLine(change.summary) || firstLine(change.ask) || change.id;
}

export const qaRef = (change: QaChange) =>
  change.qa.ref === undefined ? "QA" : `QA${change.qa.ref}`;

/** The composer record key of a change, `<landingId>/<changeId>`. */
export const qaKey = (landingId: string, changeId: string) => `${landingId}/${changeId}`;

const forcingReason: Partial<Record<EvidenceQaRaiseReason, string>> = {
  check_skipped: "a check was skipped",
  check_failed: "a check failed",
  review_waived: "the review was waived",
  review_changes_requested: "the reviewer requested changes",
};

/** Selects the lead of an expanded QA card for both clients. */
export function qaCardLead(change: Pick<QaChange, "qaCheck" | "qa">) {
  const check = change.qaCheck;
  if (check === undefined) {
    const explanation = change.qa.raised?.map((reason) => forcingReason[reason]).find(Boolean);
    return {
      kind: "fallback",
      text:
        explanation === undefined
          ? "No QA check was recorded"
          : `No QA check was recorded. Raised because ${explanation}.`,
    } as const;
  }
  return {
    kind: "check",
    rows: [
      { label: "Where", text: check.where },
      { label: "Do", text: check.do },
      { label: "Expect", text: check.expect },
    ],
  } as const;
}
