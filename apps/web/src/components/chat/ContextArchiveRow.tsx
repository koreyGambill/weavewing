import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowUpRightIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  HistoryIcon,
  PanelsTopLeftIcon,
} from "lucide-react";
import { useRightPanelStore } from "../../rightPanelStore";
import { Button } from "../ui/button";

export function ContextArchiveRow(props: {
  readonly parent: ScopedThreadRef;
  readonly host: ScopedThreadRef;
  readonly threadId: ThreadId;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly onBringBack?: (() => void) | undefined;
}) {
  const navigate = useNavigate();
  return (
    <div className="relative flex min-w-0 flex-wrap items-center gap-1 border-l border-info/60 pl-2">
      <button
        type="button"
        aria-label="Toggle earlier conversation"
        aria-expanded={props.expanded}
        className="absolute inset-y-0 left-[-1px] w-1.5 cursor-pointer rounded-sm hover:bg-current/15 focus-visible:outline-2 focus-visible:outline-ring"
        onClick={props.onToggle}
      />
      <Button variant="ghost" size="xs" aria-expanded={props.expanded} onClick={props.onToggle}>
        <HistoryIcon aria-hidden="true" />
        Earlier conversation
        {props.expanded ? (
          <ChevronDownIcon aria-hidden="true" />
        ) : (
          <ChevronRightIcon aria-hidden="true" />
        )}
      </Button>
      {props.expanded ? (
        <>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Open as side chat tab"
            title="Open as side chat tab"
            onClick={() => useRightPanelStore.getState().openSideChat(props.host, props.threadId)}
          >
            <PanelsTopLeftIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Open full chat"
            title="Open full chat"
            onClick={() =>
              void navigate({
                to: "/$environmentId/$threadId",
                params: scopeThreadRef(props.parent.environmentId, props.threadId),
              })
            }
          >
            <ArrowUpRightIcon />
          </Button>
          {props.onBringBack ? (
            <Button variant="ghost" size="xs" onClick={props.onBringBack}>
              Bring back
            </Button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
