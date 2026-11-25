import type { EvidenceChangeQa, EvidenceLanding, ThreadId } from "@t3tools/contracts";

import type { TimelineEntry } from "../../session-logic";

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

type EvidenceEntry = Extract<TimelineEntry, { readonly kind: "thread-evidence" }>;

function runOf(entry: TimelineEntry): string | null {
  if (entry.kind === "message") return entry.message.runId ?? null;
  if (entry.kind === "work") return entry.entry.runId ?? null;
  return null;
}

/** The delegated child a completion entry reports on, if any. */
export function completionChild(entry: TimelineEntry): string | undefined {
  if (entry.kind === "message" && entry.message.origin?.kind === "subagent")
    return entry.message.origin.threadId;
  const item = entry.kind === "work" ? entry.entry.structuredPayload : undefined;
  if (item?.type === "notification" && "childThreadId" in item.source)
    return item.source.childThreadId;
  return undefined;
}

/**
 * `entries` with the cards of landings a delegated child recorded for this thread placed at the
 * completion item for that child, or after the first run of this thread that starts once the
 * landing exists. A landing with neither yet waits at the end.
 */
export function withChildLandingCards(
  threadId: ThreadId,
  entries: ReadonlyArray<TimelineEntry>,
  landings: ReadonlyArray<
    Pick<EvidenceLanding, "id" | "threadId" | "qaThreadId" | "landedAt" | "changes">
  >,
): ReadonlyArray<TimelineEntry> {
  const childLandings = landings
    .filter(
      (landing) =>
        landing.threadId !== threadId &&
        landing.qaThreadId === threadId &&
        landing.changes.some((change) => qaPresence(change.qa) !== "none"),
    )
    .toSorted((a, b) => a.landedAt.localeCompare(b.landedAt) || a.id.localeCompare(b.id));
  if (childLandings.length === 0) return entries;
  const placed = new Map<number, string[]>();
  const atEnd: string[] = [];
  const place = (index: number, landingId: string) =>
    placed.set(index, [...(placed.get(index) ?? []), landingId]);
  for (const landing of childLandings) {
    const completion = entries.findIndex(
      (entry) => entry.createdAt >= landing.landedAt && completionChild(entry) === landing.threadId,
    );
    if (completion !== -1) {
      place(completion, landing.id);
      continue;
    }
    const runId = entries.find(
      (entry) => entry.createdAt >= landing.landedAt && runOf(entry) !== null,
    );
    const nextRun = runId === undefined ? null : runOf(runId);
    const runEnd =
      nextRun === null ? -1 : entries.findLastIndex((entry) => runOf(entry) === nextRun);
    if (runEnd === -1) atEnd.push(landing.id);
    else place(runEnd, landing.id);
  }
  const result: TimelineEntry[] = [];
  const cards = (anchor: TimelineEntry | undefined, landingIds: ReadonlyArray<string>) => {
    const entry: EvidenceEntry = {
      id: `evidence:${anchor?.id ?? "end"}`,
      kind: "thread-evidence",
      createdAt: anchor?.createdAt ?? entries.at(-1)?.createdAt ?? "",
      runId: null,
      landingIds,
    };
    result.push(entry);
  };
  entries.forEach((entry, index) => {
    result.push(entry);
    const landingIds = placed.get(index);
    if (landingIds) cards(entry, landingIds);
  });
  if (atEnd.length > 0) cards(undefined, atEnd);
  return result;
}
