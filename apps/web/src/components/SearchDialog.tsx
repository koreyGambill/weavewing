import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { rankPickerProjects } from "@t3tools/client-runtime/project-picker";
import { rankSearchItems, foldSearchQuery, scoreThreadSearch } from "@t3tools/shared/paletteSearch";
import { FolderGit2Icon } from "lucide-react";
import { useState } from "react";

import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useProjects } from "../state/entities";
import { useEnvironments } from "../state/environments";
import { hostEnvironmentIdAtom } from "../state/primaryEnvironment";
import { primaryServerKeybindingsAtom } from "../state/server";
import { CommandPaletteContent } from "./CommandPaletteContent";
import {
  searchTabForKey,
  type SearchTab,
  type CommandPaletteActionItem,
} from "./CommandPalette.logic";
import { CommandPaletteResults } from "./CommandPaletteResults";
import { useCommandPaletteThreadItems } from "./CommandPaletteThreadItems";
import { ProjectFilePicker } from "./files/ProjectFilePicker";
import { Button } from "./ui/button";

const PAGE_SIZE = 10;

export function SearchDialog(props: {
  readonly initialQuery: string;
  readonly setOpen: (open: boolean) => void;
}) {
  const [tab, setTab] = useState<SearchTab>("threads");
  const [query, setQuery] = useState(props.initialQuery);
  const [allMachines, setAllMachines] = useState(false);
  const [shown, setShown] = useState(PAGE_SIZE);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const hostEnvironmentId = useAtomValue(hostEnvironmentIdAtom);
  const { activeThread, routeThreadRef, handleNewThread } = useHandleNewThread();
  const { environments } = useEnvironments();
  const connected = environments.filter(
    (environment) => environment.connection.phase === "connected",
  );
  const preferredEnvironmentId =
    [routeThreadRef?.environmentId, primaryEnvironmentId, hostEnvironmentId]
      .map((id) => connected.find((environment) => environment.environmentId === id)?.environmentId)
      .find((id) => id !== undefined) ?? null;
  const environmentIds = connected
    .filter(
      (environment) =>
        allMachines ||
        preferredEnvironmentId === null ||
        environment.environmentId === preferredEnvironmentId,
    )
    .map((environment) => environment.environmentId);
  const environmentSet = new Set(environmentIds);
  const projects = useProjects();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const threadSearch = useCommandPaletteThreadItems({
    activeThread: activeThread ?? null,
    threadSearchQuery: tab === "threads" ? query : "",
    environmentIds: tab === "threads" ? environmentIds : [],
    messageLimit: 50,
    includeTitleMatches: true,
  });
  const messageByValue = new Map(threadSearch.threadMessageItems.map((item) => [item.value, item]));
  const normalizedQuery = foldSearchQuery(query);
  const scopedThreads = threadSearch.threadItems.filter(
    (item) => item.threadRef && environmentSet.has(item.threadRef.environmentId),
  );
  const titleMatches = normalizedQuery
    ? rankSearchItems(scopedThreads, (item, options) =>
        scoreThreadSearch(normalizedQuery, item.threadSearch!, threadSearch.now, options),
      ).map(({ item }) => messageByValue.get(item.value) ?? item)
    : scopedThreads;
  const listed = new Set(titleMatches.map((item) => item.value));
  const threadItems = normalizedQuery
    ? [
        ...titleMatches,
        ...threadSearch.threadMessageItems.filter(
          (item) =>
            !listed.has(item.value) &&
            item.threadRef &&
            environmentSet.has(item.threadRef.environmentId),
        ),
      ]
    : titleMatches;
  const rankedProjects = rankPickerProjects(
    projects
      .filter((project) => !project.archivedAt && environmentSet.has(project.environmentId))
      .map((project) => ({
        key: `${project.environmentId}:${project.id}`,
        environmentId: project.environmentId,
        title: project.title,
        workspaceRoot: project.workspaceRoot,
        pinned: Boolean(project.pinnedAt),
        activity: Date.parse(project.updatedAt),
        project,
      })),
    allMachines ? null : preferredEnvironmentId,
    query,
  );
  const projectItems: CommandPaletteActionItem[] = rankedProjects.map(({ project, key }) => ({
    kind: "action",
    value: `project:${key}`,
    title: project.title,
    description: project.workspaceRoot,
    searchTerms: [project.title, project.workspaceRoot],
    icon: <FolderGit2Icon className="size-4" />,
    run: async () => {
      await handleNewThread(scopeProjectRef(project.environmentId, project.id));
    },
  }));
  const items = tab === "threads" ? threadItems : projectItems;
  const changeQuery = (value: string) => {
    setQuery(value);
    setShown(PAGE_SIZE);
    setHighlighted(null);
  };
  const changeTab = (value: SearchTab) => {
    setTab(value);
    setShown(PAGE_SIZE);
    setHighlighted(null);
  };

  return (
    <div
      className="contents"
      onKeyDownCapture={(event) => {
        if (event.nativeEvent.isComposing) return;
        const next = searchTabForKey(tab, event);
        if (!next) return;
        event.preventDefault();
        event.stopPropagation();
        changeTab(next);
      }}
    >
      <div className="flex shrink-0 items-center gap-1 border-b px-3 py-2">
        <div role="tablist" aria-label="Search categories" className="flex gap-1">
          {(["threads", "projects", "files"] as const).map((value) => (
            <Button
              key={value}
              role="tab"
              aria-selected={tab === value}
              variant={tab === value ? "secondary" : "ghost"}
              size="sm"
              onClick={() => changeTab(value)}
            >
              {value === "threads" ? "Threads" : value === "projects" ? "Projects" : "Files"}
            </Button>
          ))}
        </div>
        <span className="ml-auto text-xs text-muted-foreground">Tab ⇥ switch</span>
      </div>
      {tab === "files" ? (
        <ProjectFilePicker query={query} onQueryChange={changeQuery} setOpen={props.setOpen} />
      ) : (
        <CommandPaletteContent
          key={tab}
          aria-label={`Search ${tab}`}
          autoHighlight="always"
          mode="none"
          value={query}
          onValueChange={changeQuery}
          inputProps={{
            placeholder:
              tab === "threads"
                ? "Search thread messages and titles…"
                : "Search projects by name or path…",
          }}
          onItemHighlighted={(value) => setHighlighted(typeof value === "string" ? value : null)}
          footerActionLabel={tab === "threads" ? "Open thread" : "New thread"}
          footerTrailing={
            connected.length > 1 && preferredEnvironmentId !== null ? (
              <Button
                size="xs"
                variant="ghost"
                aria-pressed={allMachines}
                onClick={() => {
                  setAllMachines(!allMachines);
                  setShown(PAGE_SIZE);
                }}
              >
                {allMachines ? "All connected machines" : "Current machine"}
              </Button>
            ) : null
          }
        >
          <CommandPaletteResults
            groups={items.length ? [{ value: tab, label: "", items: items.slice(0, shown) }] : []}
            highlightedItemValue={highlighted}
            isActionsOnly={false}
            keybindings={keybindings}
            onExecuteItem={(item) => {
              if (item.kind !== "action") return;
              props.setOpen(false);
              void item.run();
            }}
            emptyStateMessage={
              tab === "threads" && threadSearch.isSearchPending
                ? "Searching thread messages…"
                : "No matches."
            }
          />
          {items.length > shown ? (
            <div className="flex justify-end px-3 py-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={(event) => {
                  setShown(shown + PAGE_SIZE);
                  event.currentTarget
                    .closest("[data-command-palette]")
                    ?.querySelector<HTMLInputElement>('input[role="combobox"]')
                    ?.focus();
                }}
              >
                Show more ▸
              </Button>
            </div>
          ) : null}
        </CommandPaletteContent>
      )}
    </div>
  );
}
