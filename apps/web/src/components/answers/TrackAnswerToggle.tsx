import { MessageSquareReplyIcon } from "lucide-react";

import { isMacPlatform } from "../../lib/utils";
import { HelpButton } from "../questions/ThreadCardShell";

export function TrackAnswerToggle({
  pressed,
  compact,
  disabled,
  onToggle,
}: {
  readonly pressed: boolean;
  readonly compact: boolean;
  readonly disabled?: boolean;
  readonly onToggle: () => void;
}) {
  const shortcut = isMacPlatform(navigator.platform) ? "⌘⇧Y" : "Ctrl+Shift+Y";
  return (
    <HelpButton
      variant={pressed ? "contrast-outline" : "ghost"}
      aria-label="Track answer"
      aria-pressed={pressed}
      disabled={disabled ?? false}
      help={`Track the answer (${shortcut}). You get a card when the agent answers, and it stays in this thread's Checklist.`}
      onClick={onToggle}
    >
      <MessageSquareReplyIcon aria-hidden="true" />
      {compact ? null : "Track answer"}
    </HelpButton>
  );
}
