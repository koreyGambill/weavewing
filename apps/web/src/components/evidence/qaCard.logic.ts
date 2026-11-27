import { qaPresence } from "@t3tools/client-runtime/qa-card";
import {
  EVIDENCE_THREAD_REQUEST_LIMIT,
  type EvidenceLanding,
  type ThreadId,
} from "@t3tools/contracts";

import type { TimelineEntry } from "../../session-logic";

type EvidenceEntry = Extract<TimelineEntry, { readonly kind: "thread-evidence" }>;

function runOf(entry: TimelineEntry): string | null {
  if (entry.kind === "message") return entry.message.runId ?? null;
  if (entry.kind === "work") return entry.entry.runId ?? null;
  return null;
}

/** The delegated child a completion entry reports on, if any. */
function completionChild(entry: TimelineEntry): string | undefined {
  if (entry.kind === "message" && entry.message.origin?.kind === "subagent")
    return entry.message.origin.threadId;
  const item = entry.kind === "work" ? entry.entry.structuredPayload : undefined;
  if (item?.type === "notification" && "childThreadId" in item.source)
    return item.source.childThreadId;
  return undefined;
}

/**
 * `entries` with a delegated child's landings placed at the child's completion item, else after
 * the next run once the landing exists, else at the end. A waiting landing of this thread whose
 * `evidence_record` call is not loaded sits at the loaded start, so the strip can still open it.
 */
export function withLandingCards(
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
  const anchored = new Set(
    entries.flatMap((entry) => (entry.kind === "thread-evidence" ? entry.landingIds : [])),
  );
  const unanchored = landings
    .filter(
      (landing) =>
        landing.threadId === threadId &&
        !anchored.has(landing.id) &&
        landing.changes.some(({ qa }) => qa.state === "pending" || qa.state === "problem"),
    )
    .toSorted((a, b) => a.landedAt.localeCompare(b.landedAt) || a.id.localeCompare(b.id))
    .map((landing) => landing.id);
  if (childLandings.length === 0 && unanchored.length === 0) return entries;
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
  if (unanchored.length > 0)
    result.push({
      id: "evidence:start",
      kind: "thread-evidence",
      createdAt: entries[0]?.createdAt ?? "",
      runId: null,
      landingIds: unanchored,
    } satisfies EvidenceEntry);
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

/**
 * Whether the open thread reads its landings: it has a card spot of its own, a completion from a
 * child, delegated children that may have recorded a landing for it, or a QA change its strip
 * lists, whose card must open.
 */
export function timelineMayHoldQa(
  entries: ReadonlyArray<TimelineEntry>,
  hasSubagents: boolean,
  waitsOnQa: boolean,
): boolean {
  return (
    hasSubagents ||
    waitsOnQa ||
    entries.some(
      (entry) => entry.kind === "thread-evidence" || completionChild(entry) !== undefined,
    )
  );
}

/** The landings the loaded timeline places at its own `evidence_record` calls, sorted. */
export function placedLandingIds(
  entries: ReadonlyArray<TimelineEntry>,
  limit = EVIDENCE_THREAD_REQUEST_LIMIT,
): ReadonlyArray<string> {
  // Newest last, so a long history keeps the landings nearest the end of what is loaded.
  const newestLast = new Set<string>();
  for (const entry of entries) {
    if (entry.kind !== "thread-evidence") continue;
    for (const id of entry.landingIds) {
      newestLast.delete(id);
      newestLast.add(id);
    }
  }
  return [...newestLast].slice(-limit).toSorted();
}
