import { canForkProjectedAssistantItem } from "@t3tools/client-runtime/state/thread-workflows";
import type { ThreadStructureVisibleTurnItem } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import { GitForkIcon } from "lucide-react";
import { useState } from "react";
import { useV2ItemSupport } from "../../state/v2ItemSupport";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { COMPOSER_ICON_COLOR } from "./ComposerControl";

export function ForkConversationButton({
  environmentId,
  source,
  disabled,
  onFork,
  compact = false,
}: {
  readonly compact?: boolean;
  readonly environmentId: EnvironmentId;
  readonly source: ThreadStructureVisibleTurnItem;
  readonly disabled: boolean;
  readonly onFork: (input: { sourceThreadId: ThreadId; runId: RunId }) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const support = useV2ItemSupport({
    environmentId,
    sourceThreadId: source.sourceThreadId,
    sourceItemId: source.sourceItemId,
  });
  const available = canForkProjectedAssistantItem({
    projectedItem: source,
    runStatus: support.run?.status,
    capabilities: support.providerSession?.capabilities,
  });
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size={compact ? "icon-micro" : "icon-sm"}
            variant="ghost-muted"
            aria-label="Fork conversation"
            disabled={disabled || busy || !available}
            onClick={() => {
              if (source.item.runId === null) return;
              setBusy(true);
              void onFork({
                sourceThreadId: source.sourceThreadId,
                runId: source.item.runId,
              }).finally(() => setBusy(false));
            }}
          />
        }
      >
        <GitForkIcon className={compact ? `size-4 ${COMPOSER_ICON_COLOR}` : "size-4"} />
      </TooltipTrigger>
      <TooltipPopup side="top">
        {busy ? "Forking conversation…" : "Fork through the last finished turn"}
      </TooltipPopup>
    </Tooltip>
  );
}
