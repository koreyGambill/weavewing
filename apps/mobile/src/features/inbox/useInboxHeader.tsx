import { useState } from "react";

import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { inboxBadgeText, inboxButtonLabel, inboxSignal } from "./inbox.logic";
import { InboxSheet } from "./InboxSheet";
import { useInboxEnvironments } from "./useInboxEnvironments";

/**
 * The thread list header's Inbox entry: the button's label and unread badge across every
 * connected environment, and the sheet it opens, which the caller mounts beside the button.
 */
export function useInboxHeader() {
  const environments = useInboxEnvironments();
  const selectDetail = useSelectWorkspaceDetail();
  const [open, setOpen] = useState(false);
  const signal = inboxSignal(environments);
  return {
    accessibilityLabel: inboxButtonLabel(signal),
    badge: inboxBadgeText(signal.unread),
    open: () => setOpen(true),
    sheet: open ? (
      <InboxSheet
        environments={environments}
        onClose={(thread) => {
          setOpen(false);
          if (thread !== null) selectDetail({ name: "Thread", params: thread });
        }}
      />
    ) : null,
  };
}
