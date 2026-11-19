import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";
import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  type PickerAddTarget,
  completePickerFolder,
  isProjectPickerPath,
  pickerAddProjectTarget,
  pickerRecentProjects,
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
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  CircleHelpIcon,
  FolderGit2Icon,
  FolderOpenIcon,
  GlobeIcon,
  SettingsIcon,
} from "lucide-react";
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
import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironmentsPermittedBy, useEnvironmentsWithScope } from "~/state/session";
import { sourceControlEnvironment } from "~/state/sourceControl";
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
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuItemDetail,
  MenuItemLabel,
  MenuPopup,
  MenuTrigger,
} from "../ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { searchableSetting } from "../settings/settingsSearch";
import {
  settingsScopeEnvironmentLabel,
  settingsScopeEnvironmentLabels,
} from "../settings/settingsScopeAxis";
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
  readonly scratchEnvironmentId?: EnvironmentId;
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
  defaultPlace,
  currentEnvironmentId,
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
  readonly onStartWithoutProject?: (environmentId: EnvironmentId) => void;
  readonly defaultFolderLabel?: (environmentId: EnvironmentId | null) => string | null;
  readonly onAddProject: (step: "folder" | "clone", environmentId: EnvironmentId) => void;
  /** Whether this draft is at the default place, and how to make its place the default. */
  readonly defaultPlace?: { readonly current: boolean; readonly makeDefault: () => void };
  /** The machine the new thread uses, when it can differ from `environmentId`. */
  readonly currentEnvironmentId?: EnvironmentId | null;
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
  const cloneable = useEnvironmentsPermittedBy(
    environments,
    sourceControlEnvironment.startProjectClone.permissionAtom,
  );
  const navigate = useNavigate();
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
  const scope = allMachines ? null : (environmentId ?? "");
  const ranked = rankPickerProjects(available, scope, query);
  const currentKey = activeProjectRef ? scopedProjectKey(activeProjectRef) : null;
  // Frozen while open so pinning never moves a row under the pointer.
  const ordered = useOrderWhileOpen(
    pickerRecentProjects(available, scope),
    (item) => item.key,
    open,
  );
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
            ? (allMachines
                ? connected.map((env) => env.environmentId).filter((id) => operable.has(id))
                : environmentId
                  ? [environmentId]
                  : []
              ).flatMap((id) => {
                const folder = defaultFolderLabel(id);
                if (!folder) return [];
                const env = environments.find((candidate) => candidate.environmentId === id);
                return [
                  {
                    value: `scratch:${id}`,
                    scratchEnvironmentId: id,
                    label:
                      allMachines && env
                        ? `Start in ${folder} on ${settingsScopeEnvironmentLabel(env, environments)}`
                        : `Start in ${folder}`,
                  },
                ];
              })
            : []),
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
  const cycleMachine = useStableCallback(() => {
    const index = connected.findIndex((env) => env.environmentId === environmentId);
    const next = connected[(index + 1) % connected.length];
    if (!next) return;
    setAllMachines(false);
    onEnvironmentChange(next.environmentId);
    inputRef.current?.focus();
  });
  const addProject = (step: "folder" | "clone", target: EnvironmentId) => {
    if (busy) return;
    if (!inline) changeOpen(false);
    onAddProject(step, target);
  };
  const addMachines = connected.map((env) => ({
    environmentId: env.environmentId,
    canAddProject: operable.has(env.environmentId),
    canWriteSourceControl: cloneable.has(env.environmentId),
  }));
  const threadEnvironmentId =
    currentEnvironmentId === undefined ? environmentId : currentEnvironmentId;
  const machineLabel = (id: EnvironmentId) => {
    const env = environments.find((candidate) => candidate.environmentId === id);
    return {
      ...(env ? settingsScopeEnvironmentLabels(env, environments) : { primary: id, secondary: "" }),
      detail: id === threadEnvironmentId ? "current" : id === environmentId ? "selected" : null,
    };
  };
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
    [open, cycleMachine, inline, routeTarget, setAllMachines],
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
    } else if (item.scratchEnvironmentId) {
      onStartWithoutProject?.(item.scratchEnvironmentId);
      changeOpen(false);
    }
  };
  const selected = activeProjectRef
    ? (items.find((item) => item.value === scopedProjectKey(activeProjectRef)) ?? null)
    : null;
  const content = (
    <>
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
              // Programmatic query changes do not trigger Base UI's autoHighlight.
              const completion =
                pathMode && event.key === "Tab" && !event.shiftKey
                  ? item?.path && (item.completionName || highlightChosen.current)
                    ? item.completionName
                    : items.find((entry) => entry.path && entry.completionName)?.completionName
                  : undefined;
              if (completion) {
                event.preventDefault();
                event.stopPropagation();
                event.preventBaseUIHandler?.();
                highlighted.current = null;
                setQuery(completePickerFolder(browseQuery, completion));
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
          <p className="py-2">
            {pathMode
              ? "No matching folders."
              : query.trim()
                ? "No matching projects."
                : "No recent projects. Type to search, or open a folder."}
          </p>
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
                {pathMode ? (
                  <FolderOpenIcon className="size-4 shrink-0" />
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
                        <span className={cn("truncate", projectRow && "max-w-full shrink-0")}>
                          {item.label}
                        </span>
                        {projectRow && path ? (
                          // Narrow popups give the title this room; the tooltip still shows the path.
                          <span className="flex min-w-0 flex-1 overflow-hidden font-mono text-muted-foreground text-xs @max-[24rem]/picker:hidden">
                            <PickerPath path={path} />
                          </span>
                        ) : null}
                      </>
                    )}
                  </TooltipTrigger>
                  <TooltipPopup>
                    {projectRow && item.path ? (
                      <>
                        <div>{item.label}</div>
                        <div className="font-mono text-muted-foreground">{item.path}</div>
                      </>
                    ) : (
                      (item.path ?? item.label)
                    )}
                  </TooltipPopup>
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
                      render={
                        <span className="shrink-0 text-muted-foreground text-3xs @max-[19rem]/picker:hidden" />
                      }
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
      <div className="@container/picker-footer flex shrink-0 items-center gap-1 border-t px-2 py-1.5">
        {(["folder", "clone"] as const).map((step) => (
          <AddProjectButton
            key={step}
            step={step}
            target={pickerAddProjectTarget({
              step,
              allMachines,
              selectedEnvironmentId: environmentId,
              machines: addMachines,
              first: [threadEnvironmentId, environmentId],
            })}
            machineLabel={machineLabel}
            onChoose={(target) => addProject(step, target)}
          />
        ))}
        <div className="ms-auto">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost-toggle"
                  size="xs"
                  aria-pressed={allMachines}
                  onClick={() => {
                    setAllMachines((all) => !all);
                    inputRef.current?.focus();
                  }}
                />
              }
            >
              <GlobeIcon />
              <span className="@max-[24rem]/picker-footer:sr-only">All machines</span>
            </TooltipTrigger>
            <TooltipPopup side="top">Search every connected machine</TooltipPopup>
          </Tooltip>
        </div>
        <Popover>
          <PopoverTrigger
            render={<Button variant="ghost" size="icon-xs" aria-label="Picker help" />}
          >
            <CircleHelpIcon />
          </PopoverTrigger>
          <PopoverPopup side="top" padding="compact" width="md">
            <PickerHelp
              keys={[
                ["↑ ↓", "Move"],
                ["↵", "Open"],
                ["Tab", "Complete a folder"],
                ["⌫", "Go up a folder"],
                [shortcutLabelForCommand(keybindings, "thread.pin"), "Pin or unpin"],
                [shortcutLabelForCommand(keybindings, "projectPicker.nextMachine"), "Next machine"],
                [shortcutLabelForCommand(keybindings, "projectPicker.allMachines"), "All machines"],
              ]}
            />
          </PopoverPopup>
        </Popover>
        <Popover>
          <PopoverTrigger
            render={<Button variant="ghost" size="icon-xs" aria-label="Picker settings" />}
          >
            <SettingsIcon />
          </PopoverTrigger>
          <PopoverPopup side="top" align="end" padding="compact" width="sm">
            <div className="flex flex-col items-start gap-1 text-sm">
              {defaultPlace === undefined ? null : defaultPlace.current ? (
                <p className="px-2 py-1 text-muted-foreground text-xs">
                  New threads start here by default.
                </p>
              ) : (
                <Button variant="ghost" size="sm" onClick={defaultPlace.makeDefault}>
                  Make this the default place
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  changeOpen(false);
                  void navigate({
                    to: "/settings/threads",
                    hash: searchableSetting("default-folder").id,
                  });
                }}
              >
                Default folder settings…
              </Button>
            </div>
          </PopoverPopup>
        </Popover>
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
        <div className="@container/picker flex max-h-[min(34rem,76vh)] min-h-0 flex-col overflow-hidden">
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
            size="tall"
            className="@container/picker w-[min(28rem,calc(100vw-2rem))] overflow-hidden"
          >
            {content}
          </ComboboxPopup>
        </>
      )}
    </Combobox>
  );
}

const ADD_PROJECT_ACTIONS = {
  folder: { label: "Open folder", hint: "Add a folder as a project", Icon: FolderOpenIcon },
  clone: { label: "Clone repo", hint: "Clone a repository as a project", Icon: FolderGit2Icon },
} as const;

function AddProjectButton({
  step,
  target,
  machineLabel,
  onChoose,
}: {
  readonly step: "folder" | "clone";
  readonly target: PickerAddTarget<EnvironmentId>;
  readonly machineLabel: (id: EnvironmentId) => {
    readonly primary: string;
    readonly secondary: string;
    readonly detail: string | null;
  };
  readonly onChoose: (environmentId: EnvironmentId) => void;
}) {
  const { label, hint, Icon } = ADD_PROJECT_ACTIONS[step];
  const body = (
    <>
      <Icon />
      <span className="@max-[19rem]/picker-footer:sr-only">{label}</span>
    </>
  );
  if (target.kind !== "choose") {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="xs"
              // Stays focusable so the tooltip can say why it is unavailable.
              aria-disabled={target.kind === "none" || undefined}
              onClick={() => {
                if (target.kind === "machine") onChoose(target.environmentId);
              }}
            />
          }
        >
          {body}
        </TooltipTrigger>
        <TooltipPopup side="top">
          {target.kind === "none"
            ? target.reason
            : `${hint} on ${fullMachineLabel(machineLabel(target.environmentId))}`}
        </TooltipPopup>
      </Tooltip>
    );
  }
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger render={<MenuTrigger render={<Button variant="ghost" size="xs" />} />}>
          {body}
        </TooltipTrigger>
        <TooltipPopup side="top">{hint} on a chosen machine</TooltipPopup>
      </Tooltip>
      <MenuPopup side="top" align="start">
        <MenuGroup>
          <MenuGroupLabel>{label} on</MenuGroupLabel>
          {target.environmentIds.map((id) => {
            const machine = machineLabel(id);
            return (
              <MenuItem key={id} onClick={() => onChoose(id)}>
                <MenuItemLabel>{machine.primary}</MenuItemLabel>
                {/* The address tells same-named machines apart, so it never truncates. */}
                {machine.secondary ? (
                  <span className="shrink-0 text-muted-foreground text-xs">
                    {machine.secondary}
                  </span>
                ) : null}
                {machine.detail ? <MenuItemDetail>{machine.detail}</MenuItemDetail> : null}
              </MenuItem>
            );
          })}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

function fullMachineLabel({ primary, secondary }: { primary: string; secondary: string }) {
  return secondary ? `${primary} · ${secondary}` : primary;
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

function PickerHelp({
  keys,
}: {
  readonly keys: ReadonlyArray<readonly [string | null | undefined, string]>;
}) {
  return (
    <div className="flex flex-col gap-2 text-xs">
      <p>
        Type a name to search projects on this machine, or turn on All machines to search every
        machine. Start with ~ or / to browse folders. Change the machine with the machine button
        beside the folder.
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        {keys.map(([key, action]) =>
          key ? (
            <div key={action} className="contents">
              <dt className="font-mono text-muted-foreground">{key}</dt>
              <dd>{action}</dd>
            </div>
          ) : null,
        )}
      </dl>
    </div>
  );
}
