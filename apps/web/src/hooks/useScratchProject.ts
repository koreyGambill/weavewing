import { RegistryContext, useAtomValue } from "@effect/atom-react";
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
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom, type AtomRegistry } from "effect/reactivity";
import { useContext } from "react";

import { openCommandPalette } from "~/commandPaletteBus";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import {
  type EnvironmentPresentation,
  environmentsAtom,
  readEnvironments,
  readPrimaryEnvironmentId,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "~/state/environments";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";
import {
  readPreferredEnvironmentId,
  usePreferredEnvironmentId,
} from "~/state/preferredEnvironment";
import { projectEnvironment } from "~/state/projects";
import { type NewThreadHandler, useNewThreadHandler } from "./useHandleNewThread";

function reportScratchFailure(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

type ScratchEnvironment = Pick<EnvironmentPresentation, "connection" | "serverConfig"> & {
  readonly environmentId: EnvironmentId;
};

interface ScratchLookupInput {
  readonly environments: () => Iterable<ScratchEnvironment>;
  readonly primaryEnvironmentId: () => EnvironmentId | null;
  readonly preferredEnvironmentId: () => EnvironmentId | null;
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
      fallback: () => {
        const primary = input.primaryEnvironmentId();
        if (primary !== null && scratchWorkspaceRootFor(primary) !== null) return primary;
        if (fallback !== null && scratchWorkspaceRootFor(fallback) !== null) return fallback;
        const offering = [...input.environments()].filter(
          (entry) => scratchWorkspaceRootFor(entry.environmentId) !== null,
        );
        return offering.length === 1 ? (offering[0]?.environmentId ?? null) : null;
      },
    });

  const scratchEnvironmentId = (fallback: EnvironmentId | null): EnvironmentId | null =>
    chosenEnvironmentId(scratchEnvironmentChoice(fallback));

  return {
    scratchWorkspaceRootFor,
    scratchWorkspaceLabelFor,
    scratchEnvironmentChoice,
    scratchEnvironmentId,
  };
}

export function createScratchProjectActions(
  input: ScratchLookupInput & {
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

  // The palette's default-folder row lets the user pick another machine.
  const startScratchChoice = (choice: WorkEnvironmentChoice<EnvironmentId>) => {
    if (choice.kind === "none") return;
    if (choice.kind === "preferred-unavailable") openCommandPalette({ open: "new-thread-in" });
    else void startScratchThread(choice.environmentId);
  };

  return {
    ...lookup,
    openScratchProject,
    startScratchThread,
    startScratchChoice,
  };
}

// A string, so components re-render only when the label itself changes.
const defaultFolderLabelAtom = Atom.family((key: string) => {
  const [fallback, preferred] = JSON.parse(key) as [EnvironmentId | null, EnvironmentId | null];
  return Atom.make((get) => {
    const environments = get(environmentsAtom);
    const primary = get(primaryEnvironmentIdAtom);
    const lookup = createScratchLookup({
      environments: () => environments,
      primaryEnvironmentId: () => primary,
      preferredEnvironmentId: () => preferred,
    });
    const choice = lookup.scratchEnvironmentChoice(fallback);
    return choice.kind === "none"
      ? null
      : (lookup.scratchWorkspaceLabelFor(choice.environmentId) ?? "the default folder");
  });
});

/** Null when no machine offers a default folder. */
export function useDefaultFolderLabel(fallback: EnvironmentId | null): string | null {
  const preferred = usePreferredEnvironmentId();
  return useAtomValue(defaultFolderLabelAtom(JSON.stringify([fallback, preferred])));
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
    registry,
    handleNewThread,
  });
}

export function useScratchProject() {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const preferredEnvironmentId = usePreferredEnvironmentId();
  const registry = useContext(RegistryContext);
  const handleNewThread = useNewThreadHandler();
  return createScratchProjectActions({
    environments: () => environments,
    primaryEnvironmentId: () => primaryEnvironmentId,
    preferredEnvironmentId: () => preferredEnvironmentId,
    registry,
    handleNewThread,
  });
}
