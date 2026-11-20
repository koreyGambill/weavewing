import { formatDiffCount } from "@t3tools/client-runtime/diff-count";
import { useEnvironmentQuery } from "../../state/query";
import type { vcsEnvironment } from "../../state/vcs";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useBranchChangesTotals } from "../useBranchChangesTotals";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControl } from "./ComposerControl";

type StatusAtom = ReturnType<typeof vcsEnvironment.status>;

export function ComposerChangesControl({
  status,
  threadRef,
  cwd,
  workspaceMutationId,
  onOpen,
}: {
  status: StatusAtom;
  threadRef: ScopedThreadRef;
  cwd: string;
  workspaceMutationId: string | null;
  onOpen: () => void;
}) {
  const { data } = useEnvironmentQuery(status);
  const totals = useBranchChangesTotals({
    enabled: true,
    threadRef,
    cwd,
    workspaceMutationId,
    gitStatus: data,
  });
  if (!totals) return null;
  const { insertions, deletions } = totals;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ComposerControl
            size="xs"
            className="shrink-0"
            aria-label={`Changes: ${insertions} additions, ${deletions} deletions`}
            onClick={onOpen}
          />
        }
      >
        <span className="tabular-nums text-success-foreground">+{formatDiffCount(insertions)}</span>
        <span className="tabular-nums text-error-foreground">−{formatDiffCount(deletions)}</span>
      </TooltipTrigger>
      <TooltipPopup>Open Changes</TooltipPopup>
    </Tooltip>
  );
}
