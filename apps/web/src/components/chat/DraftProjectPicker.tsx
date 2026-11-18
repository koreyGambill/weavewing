import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";
import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  completePickerFolder,
  isProjectPickerPath,
  pickerProjectSections,
  projectPickerPathLabel,
  rankPickerProjects,
} from "@t3tools/client-runtime/project-picker";
import { filterFilesystemBrowseEntries } from "@t3tools/client-runtime/state/filesystem";
import {
  findProjectByPath,
  getBrowseDirectoryPath,
  getBrowseLeafPathSegment,
  getBrowseParentPath,
  inferProjectTitleFromPath,
  isScratchProject,
} from "@t3tools/client-runtime/state/projects";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { ArrowLeftIcon, FolderGit2Icon, FolderOpenIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { DraftId } from "~/composerDraftStore";
import {
  focusDraftProjectPicker,
  openDraftProjectPicker,
  registerDraftProjectPicker,
} from "~/draftProjectPicker";
import { useThreadRouteTarget } from "~/hooks/useThreadRouteTarget";
import { isCommandPaletteOpen } from "~/commandPaletteBus";
import { useProjectPin } from "~/hooks/useProjectGroupUpdate";
import { useOrderWhileOpen } from "~/hooks/useOrderWhileOpen";
import { useStableCallback } from "~/hooks/useStableCallback";
import { shortcutLabelForCommand } from "~/keybindings";
import { newProjectId } from "~/lib/utils";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { registerCommands } from "~/shortcuts/dispatcher";
import { useEnvironments } from "~/state/environments";
import { useProjects, useThreadShells, waitForProject } from "~/state/entities";
import { projectEnvironment } from "~/state/projects";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironmentsWithScope } from "~/state/session";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { ProjectFavicon } from "../ProjectFavicon";
import { isProjectPinShortcut, ProjectPinButton } from "../ProjectPinButton";
import { Button, InlineButton } from "../ui/button";
import {
  Combobox,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from "../ui/combobox";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { DraftProjectName } from "./DraftProjectName";
import { useProjectPickerBrowse, useProjectPickerHomes } from "./useProjectPickerBrowse";

interface PickerItem {
  readonly value: string;
  readonly label: string;
  readonly section?: string | undefined;
  readonly project?: EnvironmentProject | undefined;
  readonly environmentId?: EnvironmentId;
  readonly path?: string;
  readonly activity?: number;
  readonly completionName?: string;
  readonly current?: boolean;
}

export function DraftProjectPicker({
  draftId = null,
  inline = false,
  onClose,
  onBack,
  activeProjectRef,
  environmentId,
  label,
  truncateStart,
  onSelect,
  onEnvironmentChange,
  onAddProject,
  onStartWithoutProject,
  defaultFolderLabel,
}: {
  readonly draftId?: DraftId | null;
  readonly inline?: boolean;
  readonly onClose?: () => void;
  readonly onBack?: () => void;
  readonly activeProjectRef: ScopedProjectRef | null;
  readonly environmentId: EnvironmentId | null;
  readonly label: string;
  readonly truncateStart: boolean;
  readonly onSelect: (project: EnvironmentProject) => void;
  readonly onEnvironmentChange: (id: EnvironmentId) => void;
  readonly onStartWithoutProject?: () => void;
  readonly defaultFolderLabel?: string | null;
  readonly onAddProject: (step: "folder" | "clone") => void;
}) {
  const projects = useProjects();
  const threads = useThreadShells();
  const { environments } = useEnvironments();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const [open, setOpen] = useState(inline);
  const routeTarget = useThreadRouteTarget();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [query, setQuery] = useState("");
  const [allMachines, setAllMachines] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const highlighted = useRef<PickerItem | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestRef = useRef<symbol | null>(null);
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const { canPinProjectGroup, toggleProjectGroupPin } = useProjectPin();
  const operable = useEnvironmentsWithScope(environments, AuthOrchestrationOperateScope);
  const connected = environments.filter((env) => env.connection.phase === "connected");
  const targets = (open ? connected : [])
    .filter((env) => allMachines || env.environmentId === environmentId)
    .map((env) => ({
      environmentId: env.environmentId,
      cwd:
        projects.find(
          (project) =>
            project.environmentId === env.environmentId &&
            project.id === activeProjectRef?.projectId,
        )?.workspaceRoot ?? env.serverConfig?.cwd,
    }));
  const homeByEnvironment = useProjectPickerHomes(targets, open);
  const pathMode = isProjectPickerPath(query);
  const trimmedQuery = query.trim();
  const browseQuery =
    trimmedQuery === "~"
      ? "~/"
      : trimmedQuery === "."
        ? "./"
        : /^[a-z]:$/i.test(trimmedQuery)
          ? `${trimmedQuery}\\`
          : trimmedQuery;
  const directory = pathMode ? getBrowseDirectoryPath(browseQuery) : null;
  const folders = useProjectPickerBrowse(targets, directory, open && pathMode);
  const leaf = pathMode ? getBrowseLeafPathSegment(browseQuery) : "";
  const activity = new Map<string, number>();
  for (const thread of open ? threads : []) {
    const key = scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId));
    activity.set(key, Math.max(activity.get(key) ?? 0, Date.parse(thread.updatedAt) || 0));
  }
  const configs = new Map(environments.map((env) => [env.environmentId, env.serverConfig]));
  const connectedIds = new Set(connected.map((env) => env.environmentId));
  const metadata = (open ? projects : [])
    .filter(
      (project) =>
        !project.archivedAt &&
        !isScratchProject(project, configs.get(project.environmentId)?.scratchWorkspaceRoot),
    )
    .map((project) => ({
      key: scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
      environmentId: project.environmentId,
      title: project.title,
      workspaceRoot: project.workspaceRoot,
      pathLabel: projectPickerPathLabel(
        project.workspaceRoot,
        homeByEnvironment.get(project.environmentId),
      ),
      pinned: Boolean(project.pinnedAt),
      activity:
        activity.get(scopedProjectKey(scopeProjectRef(project.environmentId, project.id))) ?? 0,
      project,
    }));
  const available = metadata.filter((project) => connectedIds.has(project.environmentId));
  const ranked = rankPickerProjects(available, allMachines ? null : (environmentId ?? ""), query);
  const defaultRanked = rankPickerProjects(
    available,
    allMachines ? null : (environmentId ?? ""),
    "",
  );
  const ordered = useOrderWhileOpen(defaultRanked, (item) => item.key, open);
  const currentKey = activeProjectRef ? scopedProjectKey(activeProjectRef) : null;
  const sections = pickerProjectSections(ordered, currentKey);
  const projectItem = (entry: (typeof metadata)[number], section?: string): PickerItem => ({
    value: entry.key,
    label: entry.title,
    project: entry.project,
    path: entry.workspaceRoot,
    environmentId: entry.environmentId,
    section,
    activity: entry.activity,
    current: entry.key === currentKey,
  });
  const items: PickerItem[] = pathMode
    ? folders.listings.flatMap((listing) => {
        if (!listing.result) return [];
        const matching = filterFilesystemBrowseEntries(listing.result.entries, leaf).visibleEntries;
        const paths =
          leaf === ""
            ? [{ name: "Start in this folder", fullPath: listing.result.parentPath }, ...matching]
            : matching;
        return paths.map((folder, index) => ({
          value: `folder:${listing.environmentId}:${folder.fullPath}`,
          label: folder.name,
          ...(leaf === "" && index === 0 ? {} : { completionName: folder.name }),
          path: folder.fullPath,
          environmentId: listing.environmentId,
          project: findProjectByPath(
            projects.filter((project) => project.environmentId === listing.environmentId),
            folder.fullPath,
          ),
          section:
            allMachines && index === 0
              ? environments.find((env) => env.environmentId === listing.environmentId)?.label
              : undefined,
        }));
      })
    : query.trim()
      ? ranked.map((entry) => projectItem(entry))
      : [
          ...sections.current.map((entry) => projectItem(entry)),
          ...sections.pinned.map((entry, index) =>
            projectItem(entry, index === 0 ? "Pinned" : undefined),
          ),
          ...sections.recent.map((entry, index) =>
            projectItem(entry, index === 0 ? "Recent" : undefined),
          ),
          ...(sections.more.length
            ? [
                {
                  value: "show-all",
                  label: expanded ? "Show fewer projects" : `Show all ${ordered.length} projects`,
                },
              ]
            : []),
          ...(expanded ? sections.more.map((entry) => projectItem(entry)) : []),
          ...(onStartWithoutProject && defaultFolderLabel
            ? [{ value: "scratch", label: `Start in ${defaultFolderLabel}` }]
            : []),
          { value: "open-folder", label: "Open folder…" },
          { value: "clone", label: "Clone repository…" },
        ];
  const changeOpen = (next: boolean) => {
    requestRef.current = null;
    setOpen(next);
    if (!next) onClose?.();
    setBusy(false);
    setError(null);
    if (next) {
      setQuery("");
      setExpanded(false);
      setAllMachines(false);
    }
  };
  const switchMachine = (id: EnvironmentId) => {
    setAllMachines(false);
    onEnvironmentChange(id);
    inputRef.current?.focus();
  };
  const cycleMachine = useStableCallback(() => {
    const index = connected.findIndex((env) => env.environmentId === environmentId);
    const next = connected[(index + 1) % connected.length];
    if (next) switchMachine(next.environmentId);
  });
  const openPicker = useStableCallback(() => changeOpen(true));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers this draft's picker and remembers composer focus across opening the command palette
  useEffect(() => {
    if (!draftId) return;
    const unregister = registerDraftProjectPicker(draftId, openPicker);
    const rememberFocus = (event: Event) => {
      if (
        event.target instanceof Element &&
        event.target.closest("[data-chat-column]") ===
          triggerRef.current?.closest("[data-chat-column]")
      ) {
        focusDraftProjectPicker(draftId);
      }
    };
    document.addEventListener("focusin", rememberFocus);
    document.addEventListener("pointerdown", rememberFocus);
    return () => {
      unregister();
      document.removeEventListener("focusin", rememberFocus);
      document.removeEventListener("pointerdown", rememberFocus);
    };
  }, [draftId, openPicker]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers keyboard commands only while this new-thread picker is mounted
  useEffect(
    () =>
      registerCommands(
        {
          "projectPicker.open": (event) => {
            if (
              inline ||
              !openDraftProjectPicker(routeTarget?.kind === "draft" ? routeTarget.draftId : draftId)
            )
              return false;
            event.preventDefault();
          },
          "projectPicker.nextMachine": (event) => {
            if (!open) return false;
            event.preventDefault();
            cycleMachine();
          },
          "projectPicker.allMachines": (event) => {
            if (!open) return false;
            event.preventDefault();
            setAllMachines((all) => !all);
          },
        },
        {
          capture: true,
          when: (event) =>
            (inline || !isCommandPaletteOpen()) &&
            !(event.target instanceof Element && event.target.closest("[data-keybinding-capture]")),
        },
      ),
    [open, cycleMachine, inline, routeTarget, draftId],
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- prevents an add-project result from navigating after this composer unmounts
  useEffect(
    () => () => {
      requestRef.current = null;
    },
    [],
  );
  const chooseFolder = (item: PickerItem) => {
    const environmentId = item.environmentId;
    const path = item.path;
    if (!environmentId || !path || busy) return;
    const request = Symbol("folder");
    requestRef.current = request;
    setBusy(true);
    setError(null);
    const fail = (cause: unknown) => {
      if (requestRef.current !== request) return;
      setBusy(false);
      setError(cause instanceof Error ? cause.message : "Could not open this folder.");
    };
    const openFolder = async () => {
      let project = item.project;
      if (project?.archivedAt) {
        const result = await updateProject({
          environmentId,
          input: { projectId: project.id, archived: false },
        });
        if (result._tag === "Failure") {
          fail(squashAtomCommandFailure(result));
          return;
        }
      }
      if (!project) {
        const id = newProjectId();
        const result = await createProject({
          environmentId,
          input: {
            projectId: id,
            title: inferProjectTitleFromPath(path),
            workspaceRoot: path,
            createWorkspaceRootIfMissing: false,
            defaultModelSelection: null,
          },
        });
        if (result._tag === "Failure") {
          fail(squashAtomCommandFailure(result));
          return;
        }
        project = await waitForProject(scopeProjectRef(environmentId, id), 5_000);
      }
      if (requestRef.current !== request) return;
      onSelect(project);
      changeOpen(false);
    };
    void openFolder().catch(fail);
  };
  const choose = (item: PickerItem) => {
    if (busy) return;
    if (item.value === "show-all") {
      setExpanded((value) => !value);
      inputRef.current?.focus();
    } else if (pathMode && item.path) {
      void chooseFolder(item);
    } else if (item.project) {
      onSelect(item.project);
      changeOpen(false);
    } else if (item.value === "scratch") {
      onStartWithoutProject?.();
      changeOpen(false);
    } else {
      if (!inline) changeOpen(false);
      onAddProject(item.value === "clone" ? "clone" : "folder");
    }
  };
  const selected = activeProjectRef
    ? (items.find((item) => item.value === scopedProjectKey(activeProjectRef)) ?? null)
    : null;
  const content = (
    <>
      <div className="flex shrink-0 items-center gap-2 px-3 pt-2">
        {onBack ? (
          <InlineButton tone="muted" aria-label="Back" onClick={onBack}>
            <ArrowLeftIcon className="size-4" />
          </InlineButton>
        ) : null}
        <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)]">
          <Select
            value={environmentId}
            onValueChange={(id) => {
              if (id) switchMachine(id);
            }}
          >
            <SelectTrigger size="compact" variant="ghost" aria-label="Project machine">
              <SelectValue>
                {environments.find((env) => env.environmentId === environmentId)?.label ??
                  "Choose machine"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {connected.map((env) => (
                <SelectItem key={env.environmentId} value={env.environmentId}>
                  {env.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
        <Button
          variant={allMachines ? "secondary" : "ghost"}
          size="xs"
          aria-pressed={allMachines}
          onClick={() => {
            setAllMachines((all) => !all);
            inputRef.current?.focus();
          }}
        >
          All machines
        </Button>
      </div>
      <ComboboxSearchInput
        ref={(node) => {
          inputRef.current = node;
          if (inline && node) node.focus();
        }}
        aria-label="Project name or path"
        placeholder="Project name or path (~/…)"
        value={query}
        onChange={(event) => {
          requestRef.current = null;
          setBusy(false);
          setError(null);
          setQuery(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) {
            event.preventBaseUIHandler?.();
            return;
          }
          const item = highlighted.current;
          if (pathMode && event.key === "Tab" && !event.shiftKey && item?.path) {
            event.preventDefault();
            event.stopPropagation();
            setQuery(completePickerFolder(browseQuery, item.completionName ?? null));
          } else if (
            pathMode &&
            event.key === "Backspace" &&
            /[\\/]$/.test(query) &&
            event.currentTarget.selectionStart === query.length &&
            event.currentTarget.selectionEnd === query.length
          ) {
            const parent = getBrowseParentPath(query);
            if (parent) {
              event.preventDefault();
              setQuery(parent);
            }
          } else if (item?.project && isProjectPinShortcut(event, keybindings)) {
            const group = {
              memberProjects: [
                {
                  ...item.project,
                  environmentLabel:
                    environments.find((env) => env.environmentId === item.project?.environmentId)
                      ?.label ?? null,
                },
              ],
              pinned: Boolean(item.project.pinnedAt),
            };
            if (canPinProjectGroup(group)) {
              event.preventDefault();
              event.stopPropagation();
              toggleProjectGroupPin(group);
            }
          }
        }}
      />
      <div role="status" className="shrink-0 px-3 text-muted-foreground text-xs">
        {busy ? "Opening project…" : folders.pending && pathMode ? "Loading folders…" : null}
        {error ? <p className="py-2 text-destructive">{error}</p> : null}
        {pathMode
          ? folders.listings
              .filter((listing) => listing.error)
              .map((listing) => (
                <p key={listing.environmentId} className="py-2 text-destructive">
                  {allMachines
                    ? `${environments.find((env) => env.environmentId === listing.environmentId)?.label}: `
                    : ""}
                  {listing.error}
                </p>
              ))
          : null}
        {targets.length === 0 ? (
          <p className="py-2">Connect a machine to choose a project or folder.</p>
        ) : items.length === 0 &&
          !folders.pending &&
          !folders.listings.some((listing) => listing.error) ? (
          <p className="py-2">{pathMode ? "No matching folders." : "No matching projects."}</p>
        ) : null}
      </div>
      <ComboboxList>
        {(item: PickerItem) => {
          const path = item.path
            ? projectPickerPathLabel(item.path, homeByEnvironment.get(item.environmentId!))
            : null;
          const group = item.project
            ? {
                memberProjects: [
                  {
                    ...item.project,
                    environmentLabel:
                      environments.find((env) => env.environmentId === item.project?.environmentId)
                        ?.label ?? null,
                  },
                ],
                pinned: Boolean(item.project.pinnedAt),
              }
            : null;
          return (
            <div key={item.value}>
              {item.section ? (
                <div className="px-2 pt-2 pb-1 font-medium text-muted-foreground text-3xs uppercase tracking-wide">
                  {item.section}
                </div>
              ) : null}
              <ComboboxItem
                value={item}
                hideIndicator
                disabled={
                  busy ||
                  (pathMode &&
                    item.environmentId !== undefined &&
                    !operable.has(item.environmentId))
                }
              >
                {pathMode || item.value === "open-folder" ? (
                  <FolderOpenIcon className="size-4 shrink-0" />
                ) : item.value === "clone" ? (
                  <FolderGit2Icon className="size-4 shrink-0" />
                ) : item.project ? (
                  <ProjectFavicon project={item.project} className="size-4 shrink-0" />
                ) : null}
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <Tooltip>
                      <TooltipTrigger render={<span className="flex min-w-0 flex-1 text-sm" />}>
                        {pathMode && path ? (
                          <PickerPath path={path} />
                        ) : (
                          <span className="truncate">{item.label}</span>
                        )}
                      </TooltipTrigger>
                      <TooltipPopup>{item.path ?? item.label}</TooltipPopup>
                    </Tooltip>
                    {pathMode && item.path ? (
                      <span className="shrink-0 text-muted-foreground text-xs">
                        {item.project ? "project" : "add project"}
                      </span>
                    ) : null}
                    {item.current ? (
                      <span className="shrink-0 text-muted-foreground text-xs">Current</span>
                    ) : null}
                    {allMachines && item.environmentId ? (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <span className="max-w-28 truncate rounded bg-muted px-1 text-muted-foreground text-3xs" />
                          }
                        >
                          {
                            environments.find((env) => env.environmentId === item.environmentId)
                              ?.label
                          }
                        </TooltipTrigger>
                        <TooltipPopup>
                          {
                            environments.find((env) => env.environmentId === item.environmentId)
                              ?.label
                          }
                        </TooltipPopup>
                      </Tooltip>
                    ) : null}
                    {!pathMode && item.project && group && canPinProjectGroup(group) ? (
                      <ProjectPinButton
                        name={item.label}
                        pinned={group.pinned}
                        shortcutLabel={shortcutLabelForCommand(keybindings, "thread.pin")}
                        onToggle={() => toggleProjectGroupPin(group)}
                      />
                    ) : null}
                  </div>
                  {!pathMode && path ? (
                    <div className="flex min-w-0 items-center gap-2">
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <span className="flex min-w-0 flex-1 font-mono text-muted-foreground text-xs" />
                          }
                        >
                          <PickerPath path={path} />
                        </TooltipTrigger>
                        <TooltipPopup>{item.path}</TooltipPopup>
                      </Tooltip>
                      {item.activity && !item.project?.pinnedAt ? (
                        <Tooltip>
                          <TooltipTrigger
                            render={<span className="shrink-0 text-muted-foreground text-3xs" />}
                          >
                            {formatRelativeTimeLabel(new Date(item.activity).toISOString())}
                          </TooltipTrigger>
                          <TooltipPopup>{new Date(item.activity).toLocaleString()}</TooltipPopup>
                        </Tooltip>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </ComboboxItem>
            </div>
          );
        }}
      </ComboboxList>
      <div className="shrink-0 border-t px-3 py-2 text-muted-foreground text-3xs">
        Tab complete · ↵ open · ⌫ up ·{" "}
        {shortcutLabelForCommand(keybindings, "projectPicker.nextMachine")} machine ·{" "}
        {shortcutLabelForCommand(keybindings, "projectPicker.allMachines")} all
      </div>
    </>
  );
  return (
    <Combobox
      inline={inline}
      items={items}
      filteredItems={items}
      autoHighlight
      open={open}
      onOpenChange={changeOpen}
      value={selected}
      itemToStringLabel={(item) => item.label}
      isItemEqualToValue={(a, b) => a.value === b.value}
      onItemHighlighted={(item) => {
        highlighted.current = item ?? null;
      }}
      onValueChange={(item, details) => {
        details.cancel();
        if (item) choose(item);
      }}
    >
      {inline ? (
        <div className="flex max-h-[min(34rem,76vh)] min-h-0 flex-col overflow-hidden">
          {content}
        </div>
      ) : (
        <>
          <Tooltip>
            <TooltipTrigger
              render={
                <ComboboxTrigger
                  ref={triggerRef}
                  render={<InlineButton tone="picker" />}
                  data-draft-project-trigger=""
                  className="pointer-events-auto min-w-0 max-w-full align-baseline"
                />
              }
            >
              <DraftProjectName value={label} singleLine truncateStart={truncateStart} />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {label} · {shortcutLabelForCommand(keybindings, "projectPicker.open")}
            </TooltipPopup>
          </Tooltip>
          <ComboboxPopup align="center" className="w-[28rem] overflow-hidden">
            {content}
          </ComboboxPopup>
        </>
      )}
    </Combobox>
  );
}

function PickerPath({ path }: { readonly path: string }) {
  const split = Math.max(0, path.length - 18);
  return (
    <>
      <span className="truncate">{path.slice(0, split)}</span>
      <span className="shrink-0">{path.slice(split)}</span>
    </>
  );
}
