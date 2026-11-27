import { CardStatusBadge, type CardBadgeVariant } from "../questions/QuestionStatusBadge";
import type { TaskCardStatus } from "./taskCard.logic";

const STATUS: Record<
  TaskCardStatus,
  { readonly label: string; readonly variant: CardBadgeVariant; readonly help: string }
> = {
  open: {
    label: "Open",
    variant: "outline",
    help: "Only you can do this. Mark it Done when you have.",
  },
  "in-composer": {
    label: "In composer",
    variant: "info-outline",
    help: "A reference to this task is in your composer. It goes with your next message.",
  },
  discussing: {
    label: "Discussing",
    variant: "warning-outline",
    help: "You sent a message about this task. The agent records what it settled; you can still mark it here.",
  },
  "done-by-you": {
    label: "Done by you",
    variant: "success-outline",
    help: "You marked this done.",
  },
  recorded: {
    label: "Recorded by the agent",
    variant: "success-outline",
    help: "The agent recorded this as done from your message. Reopen it if the agent misread you.",
  },
  dismissed: { label: "Dismissed", variant: "outline", help: "Closed without doing it." },
};

/** A task's badge, with the recorded note as its meaning when the agent or user left one. */
export function TaskStatusBadge({ status, note }: { status: TaskCardStatus; note: string }) {
  const { label, variant, help } = STATUS[status];
  const noted = note !== "" && (status === "recorded" || status === "dismissed");
  return <CardStatusBadge label={label} variant={variant} help={noted ? note : help} />;
}
