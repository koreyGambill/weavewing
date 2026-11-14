import type { DefaultContextGetInput, ScopedThreadRef } from "@t3tools/contracts";
import { CoinsIcon, FileTextIcon, LayersIcon, ListStartIcon } from "lucide-react";

import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { DefaultContextPanel } from "./DefaultContextPanel";
import { ThreadContextPanel } from "./ThreadContextPanel";
import { ThreadInsightsPanel } from "./ThreadInsightsPanel";

export type ThreadInspectSection = "loads" | "tokens" | "context" | "defaults";

const sections = [
  ["loads", "Loads", FileTextIcon],
  ["context", "Context", LayersIcon],
  ["tokens", "Tokens", CoinsIcon],
  ["defaults", "Default context", ListStartIcon],
] as const;

export function ThreadInspectPanel({
  threadRef,
  section,
  visible,
  startedThread,
  draft,
  onSectionChange,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly section: ThreadInspectSection;
  readonly visible: boolean;
  readonly startedThread: boolean;
  /** What a draft thread will start with, so Default can preview it before the first message. */
  readonly draft?: Omit<DefaultContextGetInput, "threadId"> | undefined;
  readonly onSectionChange: (section: ThreadInspectSection) => void;
}) {
  const tabs = (
    <div className="shrink-0 border-b border-border px-2.5 pt-2.5 pb-2">
      <ToggleGroup
        aria-label="Inspect sections"
        size="segmented-compact"
        className="w-full *:flex-1"
        value={[section]}
        onValueChange={(value) => {
          const next = sections.find(([id]) => id === value[0]);
          if (next) onSectionChange(next[0]);
        }}
      >
        {sections.map(([id, label, Icon]) => (
          <Tooltip key={id}>
            <TooltipTrigger render={<Toggle value={id} aria-label={label} />}>
              <Icon />
            </TooltipTrigger>
            <TooltipPopup>{label}</TooltipPopup>
          </Tooltip>
        ))}
      </ToggleGroup>
    </div>
  );
  const panelKey = `${threadRef.environmentId}:${threadRef.threadId}`;
  if (section === "defaults" && (startedThread || draft !== undefined))
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        {tabs}
        <DefaultContextPanel
          key={panelKey}
          threadRef={threadRef}
          request={{ threadId: threadRef.threadId, ...(startedThread ? {} : draft) }}
          visible={visible}
        />
      </div>
    );
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      {tabs}
      {startedThread ? (
        section === "context" ? (
          <ThreadContextPanel key={panelKey} threadRef={threadRef} visible={visible} />
        ) : (
          <ThreadInsightsPanel
            threadRef={threadRef}
            visible={visible}
            mode={section === "defaults" ? "loads" : section}
          />
        )
      ) : (
        <>
          <p className="p-2 text-xs text-muted-foreground">
            Send a message to inspect activity. Default context shows what will load first.
          </p>
        </>
      )}
    </div>
  );
}
