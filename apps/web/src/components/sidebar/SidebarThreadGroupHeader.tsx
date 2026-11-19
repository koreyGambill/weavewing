import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ChevronDownIcon, EllipsisIcon } from "lucide-react";
import {
  memo,
  useRef,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { cn } from "~/lib/utils";
import { useUiStateStore } from "../../uiStateStore";
import { resolveSidebarFolderDot, resolveThreadLastVisitedAt } from "../Sidebar.logic";
import { Button } from "../ui/button";
import type { SidebarGroupDropTarget } from "./sidebarThreadGroups.logic";

const GROUP_DOT_CLASS_NAME = {
  attention: "bg-warning",
  failed: "bg-error",
  unread: "bg-success",
  working: "bg-info",
} as const;

const GROUP_DOT_LABEL = {
  attention: ", needs you",
  failed: ", failed",
  unread: ", done",
  working: ", working",
} as const;

/** The group's sidebar tree row; its thread rows name it as their parent. */
export function sidebarThreadGroupRowId(groupId: string | null) {
  return groupId === null ? "group:ungrouped" : `group:${groupId}`;
}

/** Marks where a group's rows end, so a drop indicator can sit under its last row. */
export function SidebarThreadGroupEnd(props: { groupId: string | null }) {
  return (
    <li
      aria-hidden
      data-sidebar-group-end={props.groupId ?? ""}
      className="pointer-events-none h-0 list-none"
    />
  );
}

function GroupNameInput(props: {
  name: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  // Enter and Escape blur the input as it unmounts; that blur must not commit again.
  const settledRef = useRef(false);
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      settledRef.current = true;
      props.onCommit(event.currentTarget.value);
    } else if (event.key === "Escape") {
      event.preventDefault();
      settledRef.current = true;
      props.onCancel();
    }
  };
  return (
    <input
      autoFocus
      defaultValue={props.name}
      aria-label="Group name"
      onFocus={(event) => event.currentTarget.select()}
      onKeyDown={handleKeyDown}
      onBlur={(event) => {
        if (!settledRef.current) props.onCommit(event.currentTarget.value);
      }}
      className="min-w-0 flex-1 rounded-sm bg-card px-1 text-xs font-medium text-card-foreground outline-none ring-1 ring-inset ring-input focus:ring-foreground"
    />
  );
}

/**
 * A user group, or Ungrouped when `groupId` is null. It reads like a shelf header with
 * a count; a closed group keeps a status dot so a hidden thread that needs you still shows.
 */
export const SidebarThreadGroupHeader = memo(function SidebarThreadGroupHeader(props: {
  groupId: string | null;
  name: string;
  count: number;
  collapsed: boolean;
  renaming: boolean;
  hiddenThreads: readonly EnvironmentThreadShell[];
  onToggle: (groupId: string | null) => void;
  onContextMenu: (groupId: string | null, position: { x: number; y: number }) => void;
  onCommitRename: (groupId: string, name: string) => void;
  onCancelRename: () => void;
}) {
  const { groupId, collapsed, hiddenThreads } = props;
  const rowId = sidebarThreadGroupRowId(groupId);
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
  const openMenu = (position: { x: number; y: number }) => props.onContextMenu(groupId, position);
  return (
    <li
      data-sidebar-group-header={groupId ?? ""}
      data-testid="sidebar-thread-group"
      className="group/thread-group relative mt-2 list-none first:mt-0"
    >
      {props.renaming && groupId !== null ? (
        <div className="flex h-8 items-center px-2">
          <GroupNameInput
            name={props.name}
            onCommit={(name) => props.onCommitRename(groupId, name)}
            onCancel={props.onCancelRename}
          />
        </div>
      ) : (
        <button
          type="button"
          data-sidebar-row={rowId}
          aria-expanded={!collapsed}
          onClick={() => props.onToggle(groupId)}
          onContextMenu={(event) => {
            event.preventDefault();
            openMenu({ x: event.clientX, y: event.clientY });
          }}
          className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-xs font-medium text-sidebar-foreground/80 outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
        >
          <ChevronDownIcon
            aria-hidden
            className={cn("size-3 shrink-0 transition-transform", collapsed && "-rotate-90")}
          />
          <span
            className={cn(
              "min-w-0 flex-1 truncate",
              groupId === null && "text-sidebar-muted-foreground",
            )}
          >
            {props.name}
          </span>
          {dot ? (
            <span className={cn("size-1.5 shrink-0 rounded-full", GROUP_DOT_CLASS_NAME[dot])}>
              <span className="sr-only">{GROUP_DOT_LABEL[dot]}</span>
            </span>
          ) : null}
          {/* The count yields its place to the menu button on hover, so the chevron never moves. */}
          <span className="w-6 shrink-0 text-right tabular-nums text-sidebar-muted-foreground group-hover/thread-group:invisible group-has-[[data-sidebar-action-for]:focus]/thread-group:invisible pointer-coarse:invisible">
            {props.count}
          </span>
        </button>
      )}
      {groupId !== null && !props.renaming ? (
        <span className="absolute inset-y-0 right-1 flex items-center opacity-0 focus-within:opacity-100 group-hover/thread-group:opacity-100 pointer-coarse:opacity-100">
          <Button
            data-sidebar-action-for={rowId}
            size="icon-xs"
            variant="ghost-muted"
            aria-label={`${props.name} group actions`}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              openMenu({ x: rect.left, y: rect.bottom });
            }}
          >
            <EllipsisIcon aria-hidden />
          </Button>
        </span>
      ) : null}
    </li>
  );
});

export interface SidebarGroupDropState {
  readonly top: number;
  readonly target: SidebarGroupDropTarget;
}

/** Holds the live drop target outside React state, so a drag re-renders only the indicator. */
export function createSidebarGroupDropStore() {
  let current: SidebarGroupDropState | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set(next: SidebarGroupDropState | null) {
      if (
        next === current ||
        (next !== null &&
          current !== null &&
          next.top === current.top &&
          next.target.groupId === current.target.groupId &&
          next.target.beforeKey === current.target.beforeKey)
      ) {
        return;
      }
      current = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
export type SidebarGroupDropStore = ReturnType<typeof createSidebarGroupDropStore>;

export function SidebarGroupDropIndicator(props: { store: SidebarGroupDropStore }) {
  const drop = useSyncExternalStore(props.store.subscribe, props.store.get);
  if (drop === null) return null;
  return (
    <li
      aria-hidden
      data-testid="sidebar-group-drop-indicator"
      className="pointer-events-none absolute inset-x-1 z-10 h-0.5 -translate-y-1/2 list-none rounded-full bg-primary"
      style={{ top: drop.top }}
    />
  );
}
