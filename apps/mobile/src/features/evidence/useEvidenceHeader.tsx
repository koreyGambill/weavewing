import { useState } from "react";

import { useThreadShells } from "../../state/entities";
import { inboxBadgeText } from "../inbox/inbox.logic";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { evidenceAwaitingCount, evidenceButtonLabel } from "./evidence.logic";
import { EvidenceSheet } from "./EvidenceSheet";
import { useEvidenceEnvironments } from "./useEvidenceEnvironments";

/**
 * The thread list header's Evidence entry: how many changes wait on the user's QA across every
 * connected environment, and the sheet it opens, which the caller mounts beside the button.
 * Null when no connected environment records evidence.
 */
export function useEvidenceHeader() {
  const environments = useEvidenceEnvironments();
  const threads = useThreadShells();
  const selectDetail = useSelectWorkspaceDetail();
  const [open, setOpen] = useState(false);
  const awaiting = evidenceAwaitingCount(
    threads,
    new Set(environments.map((environment) => environment.environmentId)),
  );
  return {
    available: environments.length > 0,
    awaiting,
    accessibilityLabel: evidenceButtonLabel(awaiting),
    badge: inboxBadgeText(awaiting),
    open: () => setOpen(true),
    sheet: open ? (
      <EvidenceSheet
        environments={environments}
        awaiting={awaiting}
        onClose={(thread) => {
          setOpen(false);
          if (thread !== null) selectDetail({ name: "Thread", params: thread });
        }}
      />
    ) : null,
  };
}
