import type { EnvironmentId, ScheduledTaskId } from "@t3tools/contracts";
import { CalendarClockIcon } from "lucide-react";
import type { MouseEvent as ReactMouseEvent } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useThreadContextSidebarStore } from "../../threadContextSidebarStore";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Marks a thread an automation's run started; clicking opens that automation. */
export function SidebarAutomationMarker(props: {
  environmentId: EnvironmentId;
  taskId: ScheduledTaskId;
}) {
  const open = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const sidebar = useThreadContextSidebarStore.getState();
    sidebar.selectAutomation({ environmentId: props.environmentId, taskId: props.taskId });
    sidebar.show("automations");
  };
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label="Open the automation that started this thread"
            data-testid="sidebar-automation-marker"
            onClick={open}
            className="inline-flex shrink-0 cursor-pointer items-center rounded-sm text-muted-foreground/65 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          />
        }
      >
        <CalendarClockIcon aria-hidden className="size-3 shrink-0" />
      </TooltipTrigger>
      <TooltipPopup side="top">
        <AutomationMarkerLabel environmentId={props.environmentId} taskId={props.taskId} />
      </TooltipPopup>
    </Tooltip>
  );
}

// Mounts only while the tooltip is open, so listed rows hold no automation subscription.
function AutomationMarkerLabel(props: { environmentId: EnvironmentId; taskId: ScheduledTaskId }) {
  const tasks = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId: props.environmentId, input: {} }),
  );
  const title = tasks.data?.tasks.find((task) => task.id === props.taskId)?.title;
  return <>{title ? `From automation: ${title}` : "From automation"}</>;
}
