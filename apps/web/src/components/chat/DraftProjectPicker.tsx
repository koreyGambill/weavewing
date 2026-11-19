import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";
import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  completePickerFolder,
  isProjectPickerPath,
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
import { ArrowLeftIcon, FolderGit2Icon, FolderOpenIcon, StarIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import type { DraftId } from "~/composerDraftStore";
import {
  focusDraftProjectPicker,
  openDraftProjectPicker,
  projectPickerAllMachinesAtom,
  registerDraftProjectPicker,
} from "~/draftProjectPicker";
import { useThreadRouteTarget } from "~/hooks/useThreadRouteTarget";
import { isCommandPaletteOpen } from "~/commandPaletteBus";
import { useProjectPin } from "~/hooks/useProjectGroupUpdate";
import { useOrderWhileOpen } from "~/hooks/useOrderWhileOpen";
import { useStableCallback } from "~/hooks/useStableCallback";
import { shortcutLabelForCommand } from "~/keybindings";
import { cn, newProjectId } from "~/lib/utils";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { registerCommands } from "~/shortcuts/dispatcher";
import { useEnvironments } from "~/state/environments";
import { useProjects, useThreadShells, waitForProject } from "~/state/entities";
import { projectEnvironment } from "~/state/projects";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { usePreferredEnvironmentId } from "~/state/preferredEnvironment";
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
import { ComposerControl } from "./ComposerControl";
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
  defaultEnvironmentId = null,
  defaultPlace,
  trigger,
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
  /** Whether this draft is at the default place, and how to make its place the default. */
  readonly defaultPlace?: { readonly current: boolean; readonly makeDefault: () => void };
  /** The machine new threads start on when no preference names one. */
  readonly defaultEnvironmentId?: EnvironmentId | null;
  /** Replaces the project-name trigger, as the where-line under the composer does. */
  readonly trigger?: {
    readonly content: ReactNode;
    readonly ariaLabel: string;
    readonly className?: string;
  };
}) {
  const projects = useProjects();
  const threads = useThreadShells();
  const { environments } = useEnvironments();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const [open, setOpen] = useState(inline);
  const routeTarget = useThreadRouteTarget();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [query, setQuery] = useState("");
  const allMachines = useAtomValue(projectPickerAllMachinesAtom);
  const setAllMachines = useAtomSet(projectPickerAllMachinesAtom);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const highlighted = useRef<PickerItem | null>(null);
  // An arrowed-to "Start in this folder" row keeps Tab from drilling; the opening highlight does not.
  const highlightChosen = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestRef = useRef<symbol | null>(null);
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const { canPinProjectGroup, toggleProjectGroupPin } = useProjectPin();
  const operable = useEnvironmentsWithScope(environments, AuthOrchestrationOperateScope);
  const preferredEnvironmentId = usePreferredEnvironmentId() ?? defaultEnvironmentId;
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
  // Pinned first, then by recency; frozen while open so pinning never moves a row under the pointer.
  const ordered = useOrderWhileOpen(
    [
      ...defaultRanked.filter((entry) => entry.pinned),
      ...defaultRanked.filter((entry) => !entry.pinned),
    ],
    (item) => item.key,
    open,
  );
  const currentKey = activeProjectRef ? scopedProjectKey(activeProjectRef) : null;
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
          ...ordered.map((entry) => projectItem(entry)),
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
      if (!(event.target instanceof Element)) return;
      const column = event.target.closest("[data-chat-column], [data-tile-content]");
      if (!column) return;
      if (column === triggerRef.current?.closest("[data-chat-column]")) {
        focusDraftProjectPicker(draftId);
      } else if (!column.querySelector("[data-draft-project-trigger]")) {
        focusDraftProjectPicker(null);
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
              !openDraftProjectPicker(routeTarget?.kind === "draft" ? routeTarget.draftId : null)
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
    [open, cycleMachine, inline, routeTarget],
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
    if (pathMode && item.path) {
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
      {/* One line: search takes the width, the machine controls sit at its right. */}
      <div className="flex shrink-0 items-end gap-1 pe-2">
        {onBack ? (
          <div className="ps-2 pb-1">
            <InlineButton tone="muted" aria-label="Back" onClick={onBack}>
              <ArrowLeftIcon className="size-4" />
            </InlineButton>
          </div>
        ) : null}
        <div className="min-w-0 flex-1">
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
              const item = items.find((entry) => entry.value === highlighted.current?.value);
              if (pathMode && event.key === "Tab" && !event.shiftKey) {
                event.preventDefault();
                event.stopPropagation();
                event.preventBaseUIHandler?.();
                // Programmatic query changes do not trigger Base UI's autoHighlight.
                const target =
                  item?.path && (item.completionName || highlightChosen.current)
                    ? item
                    : items.find((entry) => entry.path && entry.completionName);
                if (target?.completionName) {
                  highlighted.current = null;
                  setQuery(completePickerFolder(browseQuery, target.completionName));
                }
              } else if (pathMode && event.key === "Enter" && !item) {
                event.preventDefault();
                event.stopPropagation();
                event.preventBaseUIHandler?.();
                const first = items.find(
                  (entry) => entry.path && entry.environmentId && operable.has(entry.environmentId),
                );
                if (first) choose(first);
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
                        environments.find(
                          (env) => env.environmentId === item.project?.environmentId,
                        )?.label ?? null,
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
        </div>
        {/* A one-column grid lets the select shrink, so a long machine name truncates. */}
        <div className="grid w-24 min-w-0 shrink grid-cols-[minmax(0,1fr)] pb-1 sm:w-36">
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
              {environments.map((env) => (
                <SelectItem
                  key={env.environmentId}
                  value={env.environmentId}
                  disabled={!connectedIds.has(env.environmentId)}
                >
                  <span className="inline-flex items-center gap-1.5">
                    {env.label}
                    {env.environmentId === preferredEnvironmentId ? (
                      <StarIcon aria-label="Default" className="size-3" />
                    ) : null}
                    {connectedIds.has(env.environmentId) ? null : (
                      <span className="text-muted-foreground">offline</span>
                    )}
                  </span>
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
        <div className="shrink-0 pb-1">
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
      </div>
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
          const machineLabel = item.environmentId
            ? environments.find((env) => env.environmentId === item.environmentId)?.label
            : undefined;
          const group = item.project
            ? {
                memberProjects: [{ ...item.project, environmentLabel: machineLabel ?? null }],
                pinned: Boolean(item.project.pinnedAt),
              }
            : null;
          const projectRow = !pathMode && item.project !== undefined;
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
                <Tooltip>
                  <TooltipTrigger
                    render={<span className="flex min-w-0 flex-1 items-baseline gap-2 text-sm" />}
                  >
                    {pathMode && path ? (
                      <span className="flex min-w-0 flex-1">
                        <PickerPath path={path} />
                      </span>
                    ) : (
                      <>
                        <span className={cn("truncate", projectRow && "max-w-[50%] shrink-0")}>
                          {item.label}
                        </span>
                        {projectRow && path ? (
                          <span className="flex min-w-0 flex-1 overflow-hidden font-mono text-muted-foreground text-xs">
                            <PickerPath path={path} />
                          </span>
                        ) : null}
                      </>
                    )}
                  </TooltipTrigger>
                  <TooltipPopup>{item.path ?? item.label}</TooltipPopup>
                </Tooltip>
                {pathMode && item.path ? (
                  <span className="shrink-0 text-muted-foreground text-xs">
                    {item.project ? "project" : "add project"}
                  </span>
                ) : null}
                {allMachines && machineLabel ? (
                  <span className="max-w-24 shrink-0 truncate rounded bg-muted px-1 text-muted-foreground text-3xs">
                    {machineLabel}
                  </span>
                ) : null}
                {item.current ? (
                  <span className="shrink-0 text-muted-foreground text-3xs">current</span>
                ) : null}
                {projectRow && item.activity ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={<span className="shrink-0 text-muted-foreground text-3xs" />}
                    >
                      {formatRelativeTimeLabel(new Date(item.activity).toISOString())}
                    </TooltipTrigger>
                    <TooltipPopup>{new Date(item.activity).toLocaleString()}</TooltipPopup>
                  </Tooltip>
                ) : null}
                {projectRow ? (
                  // The pin slot is always reserved so rows line up and never shift.
                  <span className="flex h-5 w-5 shrink-0 items-center justify-end">
                    {group && canPinProjectGroup(group) ? (
                      <ProjectPinButton
                        name={item.label}
                        pinned={group.pinned}
                        shortcutLabel={shortcutLabelForCommand(keybindings, "thread.pin")}
                        onToggle={() => toggleProjectGroupPin(group)}
                      />
                    ) : null}
                  </span>
                ) : null}
              </ComboboxItem>
            </div>
          );
        }}
      </ComboboxList>
      {defaultPlace !== undefined ? (
        <div className="flex shrink-0 items-center gap-2 border-t px-3 py-1.5 text-muted-foreground text-xs">
          <StarIcon className="size-3 shrink-0" aria-hidden="true" />
          {defaultPlace.current ? (
            <span className="min-w-0 truncate">This is your default place for new threads</span>
          ) : (
            <InlineButton tone="muted" onClick={defaultPlace.makeDefault}>
              Make this the default place
            </InlineButton>
          )}
        </div>
      ) : null}
      <div className="shrink-0 truncate border-t px-3 py-2 text-muted-foreground text-3xs">
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
      // The first row is ready on open, so Enter alone starts there.
      autoHighlight="always"
      open={open}
      onOpenChange={changeOpen}
      value={selected}
      itemToStringLabel={(item) => item.label}
      isItemEqualToValue={(a, b) => a.value === b.value}
      onItemHighlighted={(item, details) => {
        highlighted.current = item ?? null;
        highlightChosen.current = details.reason === "keyboard" || details.reason === "pointer";
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
                trigger ? (
                  <ComboboxTrigger
                    ref={triggerRef}
                    render={<ComposerControl size="xs" />}
                    data-draft-project-trigger=""
                    data-composer-context-control
                    aria-label={trigger.ariaLabel}
                    className={trigger.className}
                  />
                ) : (
                  <ComboboxTrigger
                    ref={triggerRef}
                    render={<InlineButton tone="picker" />}
                    data-draft-project-trigger=""
                    className="pointer-events-auto min-w-0 max-w-full align-baseline"
                  />
                )
              }
            >
              {trigger ? (
                trigger.content
              ) : (
                <DraftProjectName value={label} singleLine truncateStart={truncateStart} />
              )}
            </TooltipTrigger>
            <TooltipPopup side="top">
              {label} · {shortcutLabelForCommand(keybindings, "projectPicker.open")}
            </TooltipPopup>
          </Tooltip>
          <ComboboxPopup
            align={trigger ? "start" : "center"}
            // The where-line returns the keyboard to the composer instead of its trigger.
            {...(trigger ? { finalFocus: false } : {})}
            className="w-[min(28rem,calc(100vw-2rem))] overflow-hidden"
          >
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
      <span className="shrink-[100] truncate">{path.slice(0, split)}</span>
      {/* Right-to-left only moves the ellipsis to the start, so a squeezed tail keeps its end. */}
      <span className="min-w-0 truncate [direction:rtl]">
        <span dir="ltr">{path.slice(split)}</span>
      </span>
    </>
  );
}
