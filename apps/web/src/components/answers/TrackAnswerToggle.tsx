import { MessageSquareReplyIcon } from "lucide-react";

import { HelpButton } from "../questions/ThreadCardShell";

export function TrackAnswerToggle({
  pressed,
  compact,
  disabled,
  shortcut,
  onToggle,
}: {
  readonly pressed: boolean;
  readonly compact: boolean;
  readonly disabled?: boolean;
  readonly shortcut?: string | null;
  readonly onToggle: () => void;
}) {
  return (
    <HelpButton
      variant={pressed ? "contrast-outline" : "ghost"}
      aria-label="Track answer"
      aria-pressed={pressed}
      disabled={disabled ?? false}
      help={`Track the answer${shortcut ? ` (${shortcut})` : ""}. You get a card when the agent answers, and it stays in this thread's Checklist.`}
      onClick={onToggle}
    >
      <MessageSquareReplyIcon aria-hidden="true" />
      {compact ? null : "Track answer"}
    </HelpButton>
  );
}
