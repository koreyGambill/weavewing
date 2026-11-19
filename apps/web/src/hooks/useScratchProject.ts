import { RegistryContext } from "@effect/atom-react";
import {
  chooseWorkEnvironment,
  chosenEnvironmentId,
  scopeProjectRef,
  type WorkEnvironmentChoice,
} from "@t3tools/client-runtime/environment";
import {
  availableScratchWorkspaceRoot,
  scratchWorkspaceLabel,
} from "@t3tools/client-runtime/operations/projects";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";
import type { AtomRegistry } from "effect/reactivity";
import { useContext } from "react";

import { openCommandPalette } from "~/commandPaletteBus";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import {
  type EnvironmentPresentation,
  readEnvironments,
  readPrimaryEnvironmentId,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "~/state/environments";
import {
  readPreferredEnvironmentId,
  usePreferredEnvironmentId,
} from "~/state/preferredEnvironment";
import { projectEnvironment } from "~/state/projects";
import {
  LAST_USED_PROJECT_STORAGE_KEY,
  lastUsedProjectKeySchema,
  type NewThreadHandler,
  readLastUsedProjectKey,
  resolveDefaultProjectRef,
  useNewThreadHandler,
} from "./useHandleNewThread";
import { useLocalStorage } from "./useLocalStorage";
import { getClientSettings, useClientSettings } from "./useSettings";
import { type DefaultPlace, resolveDefaultPlace } from "~/lib/defaultPlace.logic";
import { readProjects, useProjects } from "~/state/entities";
import { useUiStateStore } from "~/uiStateStore";

function reportScratchFailure(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

type ScratchEnvironment = Pick<EnvironmentPresentation, "connection" | "serverConfig" | "label"> & {
  readonly environmentId: EnvironmentId;
};

interface ScratchLookupInput {
  readonly environments: () => Iterable<ScratchEnvironment>;
  readonly primaryEnvironmentId: () => EnvironmentId | null;
  readonly preferredEnvironmentId: () => EnvironmentId | null;
}

/** What the default place is worked out from, read when it is asked for. */
interface DefaultPlaceSources {
  readonly defaultProject: () => ScopedProjectRef | null;
  readonly projects: () => ReadonlyArray<EnvironmentProject>;
  readonly projectOrder: () => readonly string[];
  readonly lastUsedProjectKey: () => string | null;
}

function createScratchLookup(input: ScratchLookupInput) {
  const environmentFor = (environmentId: EnvironmentId | null) => {
    let environment: ScratchEnvironment | undefined;
    for (const entry of input.environments()) {
      if (entry.environmentId === environmentId) environment = entry;
    }
    return environment;
  };
  const scratchWorkspaceRootFor = (environmentId: EnvironmentId | null): string | null => {
    const environment = environmentFor(environmentId);
    return availableScratchWorkspaceRoot(environment?.connection.phase, environment?.serverConfig);
  };
  const scratchWorkspaceLabelFor = (environmentId: EnvironmentId | null): string | null =>
    scratchWorkspaceRootFor(environmentId) === null
      ? null
      : scratchWorkspaceLabel(environmentFor(environmentId)?.serverConfig);

  // Without a preference the primary (local) environment wins; `fallback` only applies when it
  // offers no scratch root.
  const scratchEnvironmentChoice = (
    fallback: EnvironmentId | null,
  ): WorkEnvironmentChoice<EnvironmentId> =>
    chooseWorkEnvironment({
      preferred: input.preferredEnvironmentId(),
      isKnown: (environmentId) =>
        [...input.environments()].some((entry) => entry.environmentId === environmentId),
      isUsable: (environmentId) => scratchWorkspaceRootFor(environmentId) !== null,
      fallback: () => fallbackScratchEnvironmentId(fallback),
    });

  const fallbackScratchEnvironmentId = (fallback: EnvironmentId | null): EnvironmentId | null => {
    const primary = input.primaryEnvironmentId();
    if (primary !== null && scratchWorkspaceRootFor(primary) !== null) return primary;
    if (fallback !== null && scratchWorkspaceRootFor(fallback) !== null) return fallback;
    const offering = [...input.environments()].filter(
      (entry) => scratchWorkspaceRootFor(entry.environmentId) !== null,
    );
    return offering.length === 1 ? (offering[0]?.environmentId ?? null) : null;
  };

  const scratchEnvironmentId = (fallback: EnvironmentId | null): EnvironmentId | null =>
    chosenEnvironmentId(scratchEnvironmentChoice(fallback));

  return {
    environmentFor,
    scratchWorkspaceRootFor,
    scratchWorkspaceLabelFor,
    scratchEnvironmentChoice,
    scratchEnvironmentId,
    fallbackScratchEnvironmentId,
  };
}

export function createScratchProjectActions(
  input: ScratchLookupInput &
    DefaultPlaceSources & {
      readonly registry: AtomRegistry.AtomRegistry;
      readonly handleNewThread: NewThreadHandler;
    },
) {
  const lookup = createScratchLookup(input);

  const openScratchProject = async (
    environmentId: EnvironmentId,
    failureTitle = "Could not open the default folder",
  ): Promise<EnvironmentProject | null> => {
    const command = projectEnvironment.openScratch;
    const result = await runAtomCommand(
      input.registry,
      command,
      { environmentId, input: {} },
      { label: command.label, reportFailure: false, reportDefect: true },
    );
    if (result._tag === "Success") return result.value;
    if (!isAtomCommandInterrupted(result)) {
      reportScratchFailure(failureTitle, squashAtomCommandFailure(result));
    }
    return null;
  };

  const startScratchThread = async (environmentId: EnvironmentId) => {
    const project = await openScratchProject(environmentId);
    if (project) {
      await input
        .handleNewThread(scopeProjectRef(project.environmentId, project.id))
        .catch((error: unknown) =>
          reportScratchFailure("Could not start a thread in the default folder", error),
        );
    }
  };

  /**
   * Opens a new thread in the default place and says so whenever it had to fall back, so no
   * entry point lands somewhere else silently. Resolves false when nothing usable is left.
   */
  // The one place the default place is worked out; every entry point and indicator reads it.
  const defaultPlace = (): DefaultPlace => {
    const projects = input.projects();
    const isConnected = (environmentId: EnvironmentId) =>
      lookup.environmentFor(environmentId)?.connection.phase === "connected";
    return resolveDefaultPlace({
      defaultProject: input.defaultProject(),
      projects,
      isConnected,
      scratchChoice: lookup.scratchEnvironmentChoice(null),
      fallbackScratchEnvironmentId: lookup.fallbackScratchEnvironmentId(null),
      fallbackProject: resolveDefaultProjectRef(
        projects.filter((project) => project.isScratch !== true),
        input.projectOrder(),
        input.lastUsedProjectKey(),
        true,
        null,
        isConnected,
      ),
      environmentLabel: (environmentId) =>
        lookup.environmentFor(environmentId)?.label ?? "Your default machine",
    });
  };

  /** How to name a resolved place: its project, or its machine's default folder. */
  const defaultPlaceLabel = (place: DefaultPlace): string | null =>
    place.kind === "project"
      ? (input
          .projects()
          .find(
            (project) =>
              project.environmentId === place.projectRef.environmentId &&
              project.id === place.projectRef.projectId,
          )?.title ?? null)
      : place.kind === "scratch"
        ? (lookup.scratchWorkspaceLabelFor(place.environmentId) ?? "the default folder")
        : null;

  /** Opens a new thread in the default place: the opened draft, or null when nothing usable is left. */
  const openDefaultPlace = async (options?: { readonly replace?: boolean }) => {
    const place = defaultPlace();
    if (place.kind === "none") return null;
    const projectRef =
      place.kind === "project"
        ? place.projectRef
        : await openScratchProject(place.environmentId).then((project) =>
            project ? scopeProjectRef(project.environmentId, project.id) : null,
          );
    if (projectRef === null) return null;
    return input
      .handleNewThread(projectRef, options?.replace ? { replace: true } : undefined)
      .catch((error: unknown) => {
        reportScratchFailure("Could not start a new thread", error);
        return null;
      });
  };

  /** New thread: opens the default place, or the project picker when nothing usable is left. */
  const startDefaultPlace = async (options?: { readonly replace?: boolean }): Promise<boolean> => {
    if (defaultPlace().kind === "none") {
      openCommandPalette({ open: "new-thread-in" });
      return false;
    }
    return (await openDefaultPlace(options)) !== null;
  };

  return {
    ...lookup,
    openScratchProject,
    startScratchThread,
    defaultPlace,
    defaultPlaceLabel,
    openDefaultPlace,
    startDefaultPlace,
  };
}

/** The machine and folder default-folder work starts in, as new threads pick it; null when none. */
export function useDefaultFolder(): {
  readonly environmentId: EnvironmentId;
  readonly root: string;
  readonly label: string;
  readonly machine: string;
} | null {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const preferredEnvironmentId = usePreferredEnvironmentId();
  const lookup = createScratchLookup({
    environments: () => environments,
    primaryEnvironmentId: () => primaryEnvironmentId,
    preferredEnvironmentId: () => preferredEnvironmentId,
  });
  const environmentId = lookup.scratchEnvironmentId(null);
  const root = lookup.scratchWorkspaceRootFor(environmentId);
  const environment = environments.find((entry) => entry.environmentId === environmentId);
  if (environmentId === null || root === null || !environment) return null;
  return {
    environmentId,
    root,
    label: lookup.scratchWorkspaceLabelFor(environmentId) ?? root,
    machine: environment.label,
  };
}

/** Scratch actions that read environments when called, for handlers outside render. */
export function readScratchProjectActions(
  registry: AtomRegistry.AtomRegistry,
  handleNewThread: NewThreadHandler,
) {
  return createScratchProjectActions({
    environments: readEnvironments,
    primaryEnvironmentId: readPrimaryEnvironmentId,
    preferredEnvironmentId: readPreferredEnvironmentId,
    defaultProject: () => getClientSettings().defaultProject,
    projects: readProjects,
    projectOrder: () => useUiStateStore.getState().projectOrder,
    lastUsedProjectKey: readLastUsedProjectKey,
    registry,
    handleNewThread,
  });
}

export function useScratchProject() {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const preferredEnvironmentId = usePreferredEnvironmentId();
  const defaultProject = useClientSettings((settings) => settings.defaultProject);
  const projects = useProjects();
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const [lastUsedProjectKey] = useLocalStorage(
    LAST_USED_PROJECT_STORAGE_KEY,
    null,
    lastUsedProjectKeySchema,
  );
  const registry = useContext(RegistryContext);
  const handleNewThread = useNewThreadHandler();
  return createScratchProjectActions({
    environments: () => environments,
    primaryEnvironmentId: () => primaryEnvironmentId,
    preferredEnvironmentId: () => preferredEnvironmentId,
    defaultProject: () => defaultProject,
    projects: () => projects,
    projectOrder: () => projectOrder,
    lastUsedProjectKey: () => lastUsedProjectKey,
    registry,
    handleNewThread,
  });
}

/** The default place right now, and how to name it, for indicators that show it. */
export function useDefaultPlace() {
  const scratch = useScratchProject();
  const place = scratch.defaultPlace();
  return { place, label: scratch.defaultPlaceLabel(place) };
}
