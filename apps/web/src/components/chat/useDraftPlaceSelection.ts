import type { DraftId } from "~/composerDraftStore";
import { composerDraftHasUserContent, useComposerDraftStore } from "~/composerDraftStore";
import type { ScopedProjectRef } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { useRef } from "react";

import { openCommandPalette } from "~/commandPaletteBus";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useScratchProject } from "~/hooks/useScratchProject";
import { useClientSettings } from "~/hooks/useSettings";
import { seedDraftModelSelection } from "~/lib/seedDraftModelSelection";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import { type useProjects, waitForProject } from "~/state/entities";
import { getAddProjectInitialQuery } from "@t3tools/client-runtime/operations/projects";
import { useEnvironments } from "~/state/environments";

type Project = ReturnType<typeof useProjects>[number];

/** Moves an unsent draft to another project, folder or machine, keeping what was typed. */
export function useDraftPlaceSelection(input: {
  readonly draftId: DraftId | null;
  readonly activeProjectRef: ScopedProjectRef | null;
}) {
  const { draftId, activeProjectRef } = input;
  const { environments } = useEnvironments();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const setLogicalProjectDraftThreadId = useComposerDraftStore(
    (store) => store.setLogicalProjectDraftThreadId,
  );
  const getComposerDraft = useComposerDraftStore((store) => store.getComposerDraft);
  const scratch = useScratchProject();
  const openProjectDraft = useNewThreadHandler();
  // Picking a place while the default folder is still opening must not be undone when it lands.
  const pendingScratchRef = useRef<symbol | null>(null);
  const draftTargetKey = () => {
    const session = draftId ? useComposerDraftStore.getState().getDraftSession(draftId) : null;
    return session
      ? `${session.environmentId}:${session.projectId}:${session.logicalProjectKey}`
      : null;
  };

  // Retargeting an empty draft would overwrite the project's draft and strand browser tabs.
  const selectProject = (project: Project) => {
    if (!draftId) return;
    pendingScratchRef.current = null;
    const projectRef = scopeProjectRef(project.environmentId, project.id);
    if (!composerDraftHasUserContent(getComposerDraft(draftId))) {
      void openProjectDraft(projectRef);
      return;
    }
    setLogicalProjectDraftThreadId(
      deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings),
      projectRef,
      draftId,
      project.environmentId !== activeProjectRef?.environmentId
        ? { environmentSelection: "manual", loadBalancedEnvironmentId: null }
        : undefined,
    );
    seedDraftModelSelection(draftId, projectRef);
  };

  // The folder becomes a project; this draft, typed content included, moves into it.
  const openAddProject = (step?: "folder" | "clone") => {
    const environmentId =
      activeProjectRef?.environmentId ??
      scratch.scratchEnvironmentId(activeProjectRef?.environmentId ?? null);
    const settings = environments.find((environment) => environment.environmentId === environmentId)
      ?.serverConfig?.settings;
    openCommandPalette({
      open: "add-project",
      ...(step && environmentId
        ? {
            addProjectStart:
              step === "folder"
                ? {
                    step,
                    environmentId,
                    query: getAddProjectInitialQuery(settings?.addProjectBaseDirectory),
                  }
                : { step, environmentId },
          }
        : {}),
      onProjectReady: async (projectRef) => {
        pendingScratchRef.current = null;
        if (!draftId) {
          await openProjectDraft(projectRef);
          return;
        }
        selectProject(await waitForProject(projectRef, 5_000));
      },
    });
  };

  /** The default folder on the default machine, for "Use default place". */
  const defaultEnvironmentId = scratch.scratchEnvironmentId(
    activeProjectRef?.environmentId ?? null,
  );
  const moveToDefaultPlace = async () => {
    if (defaultEnvironmentId === null) return;
    const request = Symbol("default-place");
    pendingScratchRef.current = request;
    const requestedTarget = draftTargetKey();
    const project = await scratch.openScratchProject(defaultEnvironmentId);
    if (!project || pendingScratchRef.current !== request || draftTargetKey() !== requestedTarget) {
      return;
    }
    selectProject(project);
  };

  return {
    selectProject,
    openAddProject,
    moveToDefaultPlace,
    defaultEnvironmentId,
    scratchWorkspaceRootFor: scratch.scratchWorkspaceRootFor,
  };
}
