import { formatDiffCount } from "@t3tools/client-runtime/diff-count";
import { useEnvironmentQuery } from "../../state/query";
import type { vcsEnvironment } from "../../state/vcs";
import { resolveChangesTotals } from "../GitActionsControl.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControl } from "./ComposerControl";

type StatusAtom = ReturnType<typeof vcsEnvironment.status>;

export function ComposerChangesControl({
  status,
  onOpen,
}: {
  status: StatusAtom;
  onOpen: () => void;
}) {
  const { data } = useEnvironmentQuery(status);
  const totals = resolveChangesTotals(data);
  if (!totals || (totals.insertions === 0 && totals.deletions === 0)) return null;
  const { insertions, deletions } = totals;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ComposerControl
            size="xs"
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
