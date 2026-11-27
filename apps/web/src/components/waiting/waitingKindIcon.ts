import type { WaitingItemKind } from "@t3tools/contracts";
import {
  ClipboardCheckIcon,
  ListChecksIcon,
  MessageCircleQuestionIcon,
  type LucideIcon,
} from "lucide-react";

/**
 * Each waiting kind's icon. Its own module so the always-mounted thread-list row reads it
 * without loading the waiting list and the cards behind it.
 */
export const WAITING_KIND_ICON: Record<WaitingItemKind, LucideIcon> = {
  question: MessageCircleQuestionIcon,
  qa: ClipboardCheckIcon,
  task: ListChecksIcon,
};
