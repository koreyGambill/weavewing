import type { ListItem } from "@t3tools/contracts";

export type TaskCardStatus =
  | "open"
  | "in-composer"
  | "discussing"
  | "done-by-you"
  | "recorded"
  | "cancelled";

/** Where a user task stands; `inComposer` is whether this device's composer holds its Discuss. */
export function taskCardStatus(
  task: Pick<ListItem, "state" | "settledBy" | "discussedInMessageId">,
  inComposer: boolean,
): TaskCardStatus {
  switch (task.state) {
    case "done":
      return task.settledBy === "agent" ? "recorded" : "done-by-you";
    case "dropped":
      return "cancelled";
    case "open":
    case "handed_off":
      if (inComposer) return "in-composer";
      return task.discussedInMessageId === undefined ? "open" : "discussing";
  }
}

/**
 * What a closed task's one line shows after its title: the recorded note when there is one, else
 * how it closed. Null while the task is open and keeps its full card.
 */
export function taskCardOutcome(task: Pick<ListItem, "state" | "settledBy" | "note">) {
  if (task.state !== "done" && task.state !== "dropped") return null;
  const note = task.note?.trim() ?? "";
  if (note !== "") return `“${note}”`;
  if (task.state === "done") return "Done";
  return task.settledBy === "agent" ? "Cancelled by the agent" : "Cancelled";
}
