import type { ThreadQuestionStatus } from "@t3tools/client-runtime/state/thread-questions";

import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

type BadgeVariant =
  | "outline"
  | "secondary"
  | "info-outline"
  | "warning-outline"
  | "success-outline";

const STATUS: Record<
  ThreadQuestionStatus,
  { readonly label: string; readonly variant: BadgeVariant; readonly help: string }
> = {
  open: {
    label: "Open",
    variant: "outline",
    help: "Waiting on you. Choose an option or add a note to draft an answer.",
  },
  deferred: {
    label: "Deferred",
    variant: "secondary",
    help: "Set aside and out of your count. The agent may raise it again when the work needs it.",
  },
  drafted: {
    label: "Drafted",
    variant: "secondary",
    help: "Your answer is saved here, not queued. Answer puts it in the composer.",
  },
  "in-composer": {
    label: "In composer",
    variant: "info-outline",
    help: "In your composer. It goes with your next message.",
  },
  sent: {
    label: "Sent · waiting for the agent",
    variant: "warning-outline",
    help: "Sent. The agent has not started the turn that carries it.",
  },
  received: {
    label: "Received by the agent",
    variant: "success-outline",
    help: "The agent's turn that carries this answer has started.",
  },
  recorded: {
    label: "Recorded by the agent",
    variant: "success-outline",
    help: "The agent recorded this from your message. Reopen it if the agent misread you.",
  },
  dismissed: {
    label: "Dismissed",
    variant: "outline",
    help: "Closed without an answer. The agent is told with your next message.",
  },
  replaced: {
    label: "Replaced",
    variant: "outline",
    help: "The agent replaced this with a newer question.",
  },
};

/** A question's status, with what it means on hover; the same hue everywhere it shows. */
export function QuestionStatusBadge({ status }: { readonly status: ThreadQuestionStatus }) {
  const { label, variant, help } = STATUS[status];
  return (
    <Tooltip>
      <TooltipTrigger render={<Badge variant={variant} size="sm" />}>{label}</TooltipTrigger>
      <TooltipPopup side="top" className="max-w-72">
        {help}
      </TooltipPopup>
    </Tooltip>
  );
}
