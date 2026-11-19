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
import { resolveNewThreadButtons } from "./SidebarThreadHeader.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface SidebarThreadHeaderProps {
  hasProjects: boolean;
  projectScope: ReactNode;
  onNewThread: (event: ReactMouseEvent) => void;
  onNewThreadInProject: () => void;
  newThreadDisabled: boolean;
  newThreadShortcutLabel: string | null | undefined;
  newThreadInProjectShortcutLabel: string | null | undefined;
  /** Where New thread starts right now, as the default-place resolver names it. */
  defaultPlaceLabel: string | null;
  /** The open thread's or draft's project; null when neither is open. */
  currentProjectLabel: string | null;
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
  onNewThreadInProject,
  newThreadDisabled,
  newThreadShortcutLabel,
  newThreadInProjectShortcutLabel,
  defaultPlaceLabel,
  currentProjectLabel,
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
  const buttons = resolveNewThreadButtons({
    defaultPlaceLabel,
    currentProjectLabel,
    newThreadShortcut: newThreadShortcutLabel,
    newThreadInProjectShortcut: newThreadInProjectShortcutLabel,
  });

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center">
        <h2 className="h-7 min-w-0 flex-1 truncate pl-2 text-base leading-7 font-medium tracking-tight text-sidebar-muted-foreground">
          Threads
        </h2>
        <div className="flex shrink-0 items-center">
          <SidebarHeaderIconButton
            label={buttons.defaultPlace.label}
            tooltip={buttons.defaultPlace.tooltip}
            disabled={newThreadDisabled}
            onClick={onNewThread}
          >
            <MessageSquareDashedIcon />
          </SidebarHeaderIconButton>
          <SidebarHeaderIconButton
            label={buttons.currentProject.label}
            tooltip={buttons.currentProject.tooltip}
            disabled={newThreadDisabled}
            onClick={onNewThreadInProject}
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
