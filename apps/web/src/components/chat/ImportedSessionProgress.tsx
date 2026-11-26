import { AuthOrchestrationReadScope, type ScopedThreadRef } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { ChevronRightIcon, TerminalIcon } from "lucide-react";
import { useState } from "react";

import { agentSessionProgress } from "../../state/agentSessions";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { formatChatTimestampTooltip, formatShortTimestamp } from "../../timestampFormat";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { APP_BASE_NAME } from "~/branding";

export function ImportedSessionProgress({
  threadRef,
  timestampFormat,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly timestampFormat: TimestampFormat;
}) {
  const [expanded, setExpanded] = useState(true);
  const canRead = useEnvironmentScope(threadRef.environmentId, AuthOrchestrationReadScope);
  const progress = useEnvironmentQuery(
    expanded && canRead
      ? agentSessionProgress({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        })
      : null,
  );
  if (!canRead || progress.data?.status === "continued") return null;

  return (
    <div className="shrink-0 border-b border-border bg-muted/20">
      <Collapsible open={expanded} onOpenChange={setExpanded}>
        <CollapsibleTrigger className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm font-medium">
          <ChevronRightIcon aria-hidden className={`size-3.5 ${expanded ? "rotate-90" : ""}`} />
          <TerminalIcon aria-hidden className="size-3.5 text-muted-foreground" />
          Terminal activity
        </CollapsibleTrigger>
        <CollapsiblePanel animate={false}>
          <div className="max-h-[35vh] space-y-3 overflow-y-auto px-4 pb-3">
            <p className="text-xs text-muted-foreground">
              Following the original Claude terminal. Updates every 5 seconds while this panel is
              open, newest messages first. Finish its turn before continuing in {APP_BASE_NAME}.
            </p>
            {progress.data?.updatedAt ? (
              <p className="text-xs text-muted-foreground">
                Transcript updated{" "}
                <TranscriptTimestamp value={progress.data.updatedAt} format={timestampFormat} />
              </p>
            ) : null}
            {progress.error ? (
              <p role="status" className="text-xs text-muted-foreground">
                Could not refresh terminal activity. Retrying…
              </p>
            ) : null}
            {progress.data?.status === "unavailable" ? (
              <p role="status" className="text-sm text-muted-foreground">
                The source transcript is unavailable. Imported history remains below.
              </p>
            ) : progress.data ? (
              <>
                {progress.data.truncated ? (
                  <p className="text-xs text-muted-foreground">
                    Showing the latest available messages.
                  </p>
                ) : null}
                <ol className="space-y-3">
                  {progress.data.messages
                    .slice(-20)
                    .toReversed()
                    .map((message, index) => (
                      // oxlint-disable-next-line react/no-array-index-key -- Transcript snapshots have no message ids and may repeat timestamps and text.
                      <li key={`${message.createdAt}:${index}`} className="space-y-1 text-sm">
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <span className="font-medium">
                            {message.role === "user" ? "You" : "Claude"}
                          </span>
                          <TranscriptTimestamp value={message.createdAt} format={timestampFormat} />
                        </div>
                        <p className="whitespace-pre-wrap break-words">{message.text}</p>
                      </li>
                    ))}
                </ol>
                {progress.data.messages.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Waiting for visible conversation messages.
                  </p>
                ) : null}
              </>
            ) : !progress.error ? (
              <p role="status" className="text-sm text-muted-foreground">
                Reading terminal activity…
              </p>
            ) : null}
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}

function TranscriptTimestamp({
  value,
  format,
}: {
  readonly value: string;
  readonly format: TimestampFormat;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={<time dateTime={value} tabIndex={0} />}>
        {formatShortTimestamp(value, format)}
      </TooltipTrigger>
      <TooltipPopup>{formatChatTimestampTooltip(value, format)}</TooltipPopup>
    </Tooltip>
  );
}
