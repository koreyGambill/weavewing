import type { TimelineEntry } from "../../session-logic";

type TasksEntry = Extract<TimelineEntry, { kind: "thread-tasks" }>;

/**
 * `entries` with the cards of open user tasks whose filing call is not in the loaded timeline
 * placed at its start, so every task the strip counts opens from it. That happens only while the
 * call could be out of reach, in history not yet loaded or in folded work; with the whole thread
 * loaded and nothing folded, a task without a call was added in Todos and raises no card.
 */
export function withUnplacedTaskCards(
  entries: ReadonlyArray<TimelineEntry>,
  waitingTaskRefs: ReadonlyArray<string>,
  historyComplete: boolean,
): ReadonlyArray<TimelineEntry> {
  if (waitingTaskRefs.length === 0) return entries;
  const placed = new Set(
    entries.flatMap((entry) => (entry.kind === "thread-tasks" ? entry.taskRefs : [])),
  );
  const unplaced = waitingTaskRefs.filter((ref) => !placed.has(ref));
  if (unplaced.length === 0) return entries;
  const callMayBeHidden =
    !historyComplete ||
    entries.some((entry) => entry.kind === "work" && entry.entry.projectedItem?.item.deferredWork);
  if (!callMayBeHidden) return entries;
  const card: TasksEntry = {
    id: "tasks:start",
    kind: "thread-tasks",
    createdAt: entries[0]?.createdAt ?? "",
    runId: null,
    taskRefs: unplaced,
  };
  return [card, ...entries];
}
