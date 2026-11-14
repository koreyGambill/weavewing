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
import type { EnvironmentId } from "@t3tools/contracts";
import type { AtomRegistry } from "effect/reactivity";
import { useContext } from "react";

import { openCommandPalette } from "~/commandPaletteBus";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import {
  type EnvironmentPresentation,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "~/state/environments";
import { usePreferredEnvironmentId } from "~/state/preferredEnvironment";
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

export function createScratchProjectActions(input: {
  readonly environments: () => Iterable<ScratchEnvironment>;
  readonly primaryEnvironmentId: () => EnvironmentId | null;
  readonly preferredEnvironmentId: () => EnvironmentId | null;
  readonly registry: AtomRegistry.AtomRegistry;
  readonly handleNewThread: NewThreadHandler;
}) {
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
    scratchWorkspaceRootFor,
    scratchWorkspaceLabelFor,
    scratchEnvironmentChoice,
    scratchEnvironmentId,
    openScratchProject,
    startScratchThread,
    startScratchChoice,
  };
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
