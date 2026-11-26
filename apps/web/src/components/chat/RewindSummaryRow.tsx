import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import { ChevronDownIcon, ChevronRightIcon, ScrollTextIcon } from "lucide-react";
import { use, useState } from "react";

import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { TimelineRowCtx } from "./timelineRowContext";

/** The summary the agent wrote when the user rewound to this reply; it stays readable here. */
export function RewindSummaryRow(props: {
  readonly item: Extract<OrchestrationV2TurnItem, { readonly type: "handoff" }>;
}) {
  const ctx = use(TimelineRowCtx);
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="relative min-w-0 border-l border-info/60 pl-2" data-rewind-summary>
      <Collapsible open={expanded} onOpenChange={setExpanded}>
        <CollapsibleTrigger render={<Button variant="ghost" size="xs" />}>
          <ScrollTextIcon aria-hidden="true" />
          {props.item.title ?? "Context rewind summary"}
          {expanded ? (
            <ChevronDownIcon aria-hidden="true" />
          ) : (
            <ChevronRightIcon aria-hidden="true" />
          )}
        </CollapsibleTrigger>
        {/* Virtualized rows must settle before disclosure scroll anchoring resumes. */}
        <CollapsiblePanel animate={false}>
          {expanded ? (
            <div className="px-2 pt-1 pb-2" data-thread-find-text="true">
              <ChatMarkdown
                text={props.item.summary ?? ""}
                cwd={ctx.markdownCwd}
                threadRef={ctx.threadRef ?? undefined}
                environmentId={ctx.activeThreadEnvironmentId}
                isStreaming={false}
              />
            </div>
          ) : null}
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}
