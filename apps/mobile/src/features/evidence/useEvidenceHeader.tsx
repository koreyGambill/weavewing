import { useState } from "react";

import { useThreadShells } from "../../state/entities";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { evidenceButtonLabel, evidenceThreadsWaitingCount } from "./evidence.logic";
import { EvidenceSheet } from "./EvidenceSheet";
import { useEvidenceEnvironments } from "./useEvidenceEnvironments";

/**
 * The thread list header's Evidence entry: whether any thread across the connected environments
 * has changes waiting on the user's QA, and the sheet it opens, which the caller mounts beside the
 * button. The button shows no number; only the spoken label and the sheet count threads.
 */
export function useEvidenceHeader() {
  const environments = useEvidenceEnvironments();
  const threads = useThreadShells();
  const selectDetail = useSelectWorkspaceDetail();
  const [open, setOpen] = useState(false);
  const threadsWaiting = evidenceThreadsWaitingCount(
    threads,
    new Set(environments.map((environment) => environment.environmentId)),
  );
  return {
    available: environments.length > 0,
    waiting: threadsWaiting > 0,
    accessibilityLabel: evidenceButtonLabel(threadsWaiting),
    open: () => setOpen(true),
    sheet: open ? (
      <EvidenceSheet
        environments={environments}
        threadsWaiting={threadsWaiting}
        onClose={(thread) => {
          setOpen(false);
          if (thread !== null) selectDetail({ name: "Thread", params: thread });
        }}
      />
    ) : null,
  };
}
