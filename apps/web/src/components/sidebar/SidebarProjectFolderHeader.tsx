import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ChevronDownIcon, SquarePenIcon } from "lucide-react";
import { type DragEvent, memo } from "react";

import { cn } from "~/lib/utils";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useUiStateStore } from "../../uiStateStore";
import { isProjectFolderDrag } from "./sidebarFolderDrag";
import { resolveSidebarFolderDot, resolveThreadLastVisitedAt } from "../Sidebar.logic";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const FOLDER_DOT_CLASS_NAME = {
  attention: "bg-warning",
  failed: "bg-error",
  unread: "bg-success",
  working: "bg-info",
} as const;

const FOLDER_DOT_LABEL = {
  attention: ", needs you",
  failed: ", failed",
  unread: ", done",
  working: ", working",
} as const;

/** The folder's sidebar tree row; its thread rows name it as their parent. */
export function sidebarFolderRowId(projectKey: string) {
  return `folder:${projectKey}`;
}

/**
 * A project folder in the boring sidebar. It reads like a shelf header: a trailing
 * count and chevron, with the count and a status dot only while it is closed, so a
 * closed folder still says when a hidden thread needs you.
 */
export const SidebarProjectFolderHeader = memo(function SidebarProjectFolderHeader(props: {
  group: SidebarProjectSnapshot;
  collapsed: boolean;
  hiddenThreads: readonly EnvironmentThreadShell[];
  onToggle: (group: SidebarProjectSnapshot) => void;
  onNewThread: (group: SidebarProjectSnapshot) => void;
  onContextMenu: (group: SidebarProjectSnapshot, position: { x: number; y: number }) => void;
  selected: boolean;
  dropSide: "before" | "after" | null;
  /** Set when folders keep a manual order, so the header drags to reorder them. */
  reorder: {
    readonly onSelect: (group: SidebarProjectSnapshot, mode: "toggle" | "range" | "clear") => void;
    readonly onDragStart: (group: SidebarProjectSnapshot, event: DragEvent<HTMLElement>) => void;
    readonly onDragOver: (group: SidebarProjectSnapshot, side: "before" | "after") => void;
    readonly onDrop: (group: SidebarProjectSnapshot, side: "before" | "after") => void;
    readonly onDragEnd: () => void;
  } | null;
}) {
  const { group, collapsed, hiddenThreads, reorder, selected, dropSide } = props;
  const sideOf = (event: DragEvent<HTMLElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return event.clientY < bounds.top + bounds.height / 2 ? "before" : "after";
  };
  const rowId = sidebarFolderRowId(group.projectKey);
  const localLastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  const dot = collapsed
    ? resolveSidebarFolderDot(
        hiddenThreads.map((thread) => ({
          ...thread,
          lastVisitedAt: resolveThreadLastVisitedAt(
            thread.lastVisitedAt,
            localLastVisitedAtById[
              scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))
            ],
          ),
        })),
      )
    : null;
  return (
    <li
      data-testid="sidebar-project-folder"
      data-sidebar-group-header={rowId}
      className="group/project-folder relative mt-2 list-none first:mt-0"
      {...(reorder === null
        ? {}
        : {
            onDragOver: (event: DragEvent<HTMLElement>) => {
              if (!isProjectFolderDrag(event)) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              reorder.onDragOver(group, sideOf(event));
            },
            onDrop: (event: DragEvent<HTMLElement>) => {
              if (!isProjectFolderDrag(event)) return;
              event.preventDefault();
              reorder.onDrop(group, sideOf(event));
            },
          })}
    >
      {dropSide ? (
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-x-1 z-10 h-0.5 rounded-full bg-primary",
            dropSide === "before" ? "-top-1" : "-bottom-px",
          )}
        />
      ) : null}
      <button
        type="button"
        data-sidebar-row={rowId}
        aria-expanded={!collapsed}
        draggable={reorder !== null}
        {...(reorder === null
          ? {}
          : {
              onDragStart: (event: DragEvent<HTMLElement>) => reorder.onDragStart(group, event),
              onDragEnd: reorder.onDragEnd,
            })}
        onClick={(event) => {
          if (reorder !== null && (event.metaKey || event.ctrlKey || event.shiftKey)) {
            reorder.onSelect(group, event.shiftKey ? "range" : "toggle");
            return;
          }
          reorder?.onSelect(group, "clear");
          props.onToggle(group);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          props.onContextMenu(group, { x: event.clientX, y: event.clientY });
        }}
        data-selected={selected || undefined}
        className={cn(
          "flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-(--control-radius) px-(--sidebar-row-content-inset) text-left outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          selected && "bg-sidebar-row-selected",
        )}
      >
        <ProjectFavicon project={group} className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-sidebar-foreground/90">
          {group.displayName}
        </span>
        {dot ? (
          <span className={cn("size-1.5 shrink-0 rounded-full", FOLDER_DOT_CLASS_NAME[dot])}>
            <span className="sr-only">{FOLDER_DOT_LABEL[dot]}</span>
          </span>
        ) : null}
        {collapsed && hiddenThreads.length > 0 ? (
          <span className="shrink-0 text-xs tabular-nums text-sidebar-muted-foreground group-hover/project-folder:invisible group-has-[[data-sidebar-action-for]:focus]/project-folder:invisible pointer-coarse:invisible">
            {hiddenThreads.length}
          </span>
        ) : null}
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "size-3 shrink-0 text-sidebar-muted-foreground transition-transform",
            collapsed && "-rotate-90",
          )}
        />
      </button>
      {/* Sits over the count, which hides on hover or focus, and left of the chevron. */}
      <span className="absolute inset-y-0 right-6 flex items-center opacity-0 focus-within:opacity-100 group-hover/project-folder:opacity-100 pointer-coarse:opacity-100">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                data-sidebar-action-for={rowId}
                size="icon-xs"
                variant="ghost-muted"
                aria-label={`New thread in ${group.displayName}`}
                onClick={() => props.onNewThread(group)}
              />
            }
          >
            <SquarePenIcon aria-hidden />
          </TooltipTrigger>
          <TooltipPopup>New thread in {group.displayName}</TooltipPopup>
        </Tooltip>
      </span>
    </li>
  );
});
