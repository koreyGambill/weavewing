import { MessageSquareDashedIcon, SquarePenIcon } from "lucide-react";
import {
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { cn } from "~/lib/utils";
import { SidebarMenuButton } from "../ui/sidebar";
import { SidebarSearchField } from "./SidebarSearchField";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface SidebarThreadHeaderProps {
  hasProjects: boolean;
  projectScope: ReactNode;
  onNewThread: (event: ReactMouseEvent) => void;
  newThreadDisabled: boolean;
  newThreadShortcutLabel: string | null | undefined;
  newThreadInProjectShortcutLabel: string | null | undefined;
  showNewThreadInProjectHint: boolean;
  /** Null when no connected machine offers a default folder. */
  defaultFolderLabel: string | null;
  defaultFolderShortcutLabel: string | null | undefined;
  onNewDefaultFolderThread: () => void;
  searchInputRef: RefObject<HTMLInputElement | null>;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  onSearchKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  isSearching: boolean;
  searchResultCount: number;
  activeSearchResultIndex: number;
  onClearSearch: () => void;
}

export function SidebarThreadHeader({
  hasProjects,
  projectScope,
  onNewThread,
  newThreadDisabled,
  newThreadShortcutLabel,
  newThreadInProjectShortcutLabel,
  showNewThreadInProjectHint,
  defaultFolderLabel,
  defaultFolderShortcutLabel,
  onNewDefaultFolderThread,
  searchInputRef,
  searchQuery,
  onSearchQueryChange,
  onSearchKeyDown,
  isSearching,
  searchResultCount,
  activeSearchResultIndex,
  onClearSearch,
}: SidebarThreadHeaderProps) {
  const resultsVisible = isSearching && searchResultCount > 0;
  // Shrinking results can remove the active option; never leave aria-activedescendant pointing at it.
  const activeResultExists = resultsVisible && activeSearchResultIndex < searchResultCount;
  const newThreadLabel = newThreadShortcutLabel
    ? `New thread (${newThreadShortcutLabel})`
    : "New thread";
  const defaultFolderThreadLabel =
    defaultFolderLabel === null
      ? "No default folder available"
      : `New thread in ${defaultFolderLabel}`;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center">
        <h2 className="flex h-7 flex-1 pl-2 text-base leading-7 font-medium tracking-tight">
          <span className="min-w-max">
            <span className="text-sidebar-muted-foreground">weave</span>
            <span className="text-(--weavewing-yellow)">wing</span>
          </span>
          {/* "threads" wraps past the spacer onto the clipped second line unless it fits whole. */}
          <span className="flex h-7 w-0 flex-1 flex-wrap overflow-hidden">
            <span aria-hidden className="h-7 w-1.5" />
            <span className="text-sidebar-muted-foreground">threads</span>
          </span>
        </h2>
        <div className="flex shrink-0 items-center">
          {/* Rendered even when unavailable, so New thread never moves. */}
          <SidebarHeaderIconButton
            label={defaultFolderThreadLabel}
            tooltip={
              defaultFolderShortcutLabel && defaultFolderLabel !== null
                ? `${defaultFolderThreadLabel} (${defaultFolderShortcutLabel})`
                : defaultFolderThreadLabel
            }
            disabled={defaultFolderLabel === null}
            onClick={onNewDefaultFolderThread}
          >
            <MessageSquareDashedIcon />
          </SidebarHeaderIconButton>
          <SidebarHeaderIconButton
            label="New thread"
            tooltip={
              showNewThreadInProjectHint ? (
                <span className="flex flex-col gap-0.5">
                  <span>{newThreadLabel}</span>
                  <span className="text-muted-foreground">
                    New thread in current project: Shift+click
                    {newThreadInProjectShortcutLabel ? ` (${newThreadInProjectShortcutLabel})` : ""}
                  </span>
                </span>
              ) : (
                newThreadLabel
              )
            }
            disabled={newThreadDisabled}
            onClick={onNewThread}
          >
            <SquarePenIcon />
          </SidebarHeaderIconButton>
        </div>
      </div>
      <div className="flex items-center gap-1">
        <SidebarSearchField
          inputRef={searchInputRef}
          value={searchQuery}
          onValueChange={onSearchQueryChange}
          onKeyDown={onSearchKeyDown}
          aria-label="Search threads"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={resultsVisible}
          aria-controls={resultsVisible ? "sidebar-thread-search-results" : undefined}
          aria-activedescendant={
            activeResultExists
              ? `sidebar-thread-search-result-${activeSearchResultIndex}`
              : undefined
          }
          onClear={onClearSearch}
          clearLabel="Clear thread search"
        />
        {hasProjects ? projectScope : null}
      </div>
    </div>
  );
}

export function SidebarHeaderIconButton({
  label,
  tooltip = label,
  className,
  children,
  ...rest
}: {
  label: string;
  tooltip?: ReactNode;
  className?: string | undefined;
  children?: ReactNode;
} & Omit<
  ComponentProps<typeof SidebarMenuButton>,
  "children" | "className" | "tooltip" | "isActive" | "aria-label"
>) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <SidebarMenuButton
            size="icon"
            type="button"
            aria-label={label}
            {...rest}
            className={cn("relative size-7 shrink-0", className)}
          />
        }
      >
        {children}
        <span
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
        />
      </TooltipTrigger>
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}
