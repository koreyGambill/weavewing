import { useId } from "react";
import type { OrchestrationV2ContextTransfer, ScopedThreadRef } from "@t3tools/contracts";
import { useClientSettings, updateClientSettings } from "../../hooks/useSettings";
import { useQuietThreadProjection, useServerConfigs } from "../../state/entities";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SummaryHandoffAction } from "./SummaryHandoffAction";
import { ThreadDetailsSection } from "./ThreadDetailsSection";

function effectiveHistory(transfer: OrchestrationV2ContextTransfer | undefined): string | null {
  if (!transfer) return null;
  if (transfer.resolution?.strategy === "native_fork") return "Native history";
  if (transfer.resolution?.strategy === "portable_context") return "Portable conversation context";
  if (transfer.forkHistoryPolicy === "require_native" && transfer.error) {
    return "Native history unavailable";
  }
  if (transfer.status === "failed") return "Context transfer failed";
  return transfer.forkHistoryPolicy === "require_native"
    ? "Native history required on first message"
    : "Context selected on first message";
}

export function ForkHistoryStatus({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const projection = useQuietThreadProjection(threadRef)?.projection;
  const transfer = projection?.contextTransfers.find(
    (candidate) => candidate.type === "fork" && candidate.targetThreadId === threadRef.threadId,
  );
  const status = effectiveHistory(transfer);
  return status ? <p className="px-2 text-xs text-muted-foreground">{status}</p> : null;
}

export function ThreadHistoryControls({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const headingId = useId();
  const policy = useClientSettings((settings) => settings.forkHistoryPolicy);
  const supported = useServerConfigs().get(threadRef.environmentId)?.environment.capabilities
    .forkHistoryPolicy;
  return (
    <ThreadDetailsSection
      title="Conversation history"
      headingId={headingId}
      data-thread-details-history
    >
      <div className="flex flex-col items-start gap-1 px-2 pb-2">
        <Select
          value={policy}
          onValueChange={(value) => {
            if (value === "automatic" || value === "require_native") {
              void updateClientSettings({ forkHistoryPolicy: value });
            }
          }}
        >
          <SelectTrigger aria-label="Fork history" size="sm">
            <SelectValue>
              {policy === "require_native" ? "Require native history" : "Automatic"}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="automatic">Automatic</SelectItem>
            <SelectItem value="require_native">Require native history</SelectItem>
          </SelectPopup>
        </Select>
        <p className="text-xs text-muted-foreground">
          {policy === "require_native"
            ? supported
              ? "Forks, side chats, and drill-ins need native history."
              : "Update this environment to require native history, or choose Automatic."
            : "Uses native history when available, with saved conversation as a fallback."}
        </p>
        <SummaryHandoffAction source={threadRef} />
      </div>
      <ForkHistoryStatus threadRef={threadRef} />
    </ThreadDetailsSection>
  );
}
