import type { OrchestrationV2Run, ThreadId } from "@t3tools/contracts";
import type { TimelineEntry } from "../../session-logic";

export interface ContextArchiveRange {
  readonly threadId: ThreadId;
  readonly fromRunOrdinal: number;
  readonly throughRunOrdinal: number;
  readonly createdAt: string;
}

export function groupContextArchiveEntries(input: {
  readonly entries: ReadonlyArray<TimelineEntry>;
  readonly archiveImportedHistory: boolean;
  readonly archives: ReadonlyArray<ContextArchiveRange> | undefined;
  readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "ordinal">>;
  readonly closed: ReadonlySet<ThreadId>;
  readonly expanded: ReadonlySet<ThreadId>;
  readonly revealEntryIds: ReadonlyArray<string | undefined>;
}): ReadonlyArray<TimelineEntry> {
  if (!input.archives?.length) return input.entries;

  const ordinalByRun = new Map(input.runs.map((run) => [run.id, run.ordinal]));
  const sections = input.archives
    .toSorted((left, right) => left.fromRunOrdinal - right.fromRunOrdinal)
    .map((archive) => ({ archive, entries: new Array<TimelineEntry>() }));
  const recent: TimelineEntry[] = [];
  const first = sections[0];
  for (const entry of input.entries) {
    const runId =
      entry.kind === "message"
        ? entry.message.runId
        : entry.kind === "work"
          ? entry.entry.runId
          : entry.kind === "event"
            ? entry.projectedItem.item.runId
            : entry.kind === "proposed-plan"
              ? entry.proposedPlan.runId
              : entry.kind === "context-archive"
                ? null
                : entry.runId;
    const ordinal = runId == null ? undefined : ordinalByRun.get(runId);
    const section =
      ordinal === undefined
        ? first?.archive.fromRunOrdinal === 1 &&
          entry.createdAt < first.archive.createdAt &&
          ((runId == null && input.archiveImportedHistory) ||
            (entry.kind === "message" && entry.projectedItem?.visibility === "inherited") ||
            (entry.kind === "work" && entry.entry.projectedItem?.visibility === "inherited") ||
            (entry.kind === "event" && entry.projectedItem.visibility === "inherited"))
          ? first
          : undefined
        : sections.find(
            ({ archive }) =>
              ordinal >= archive.fromRunOrdinal && ordinal <= archive.throughRunOrdinal,
          );
    (section?.entries ?? recent).push(entry);
  }

  const revealIds = new Set(input.revealEntryIds.filter((id) => id !== undefined));
  const result: TimelineEntry[] = [];
  for (const { archive, entries } of sections) {
    const expanded =
      input.expanded.has(archive.threadId) ||
      (!input.closed.has(archive.threadId) && entries.some((entry) => revealIds.has(entry.id)));
    result.push({
      id: `context-archive:${archive.threadId}`,
      kind: "context-archive",
      createdAt: archive.createdAt,
      threadId: archive.threadId,
      expanded,
      hasLoadedEntries: entries.length > 0,
    });
    if (expanded) for (const entry of entries) result.push(entry);
  }
  return result.concat(recent);
}
