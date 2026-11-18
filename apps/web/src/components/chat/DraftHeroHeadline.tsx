import type { DraftId } from "~/composerDraftStore";
import { composerDraftHasUserContent, useComposerDraftStore } from "~/composerDraftStore";
import { type EnvironmentId, type ScopedProjectRef } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { useAtomValue } from "@effect/atom-react";
import { useRef } from "react";

import { openCommandPalette } from "~/commandPaletteBus";
import { shortcutLabelForCommand } from "~/keybindings";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useScratchProject } from "~/hooks/useScratchProject";
import { isTriagePrompt } from "@t3tools/shared/triagePrompt";
import { useClientSettings } from "~/hooks/useSettings";
import { seedDraftModelSelection } from "~/lib/seedDraftModelSelection";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import { useProjects, waitForProject } from "~/state/entities";
import { getAddProjectInitialQuery } from "@t3tools/client-runtime/operations/projects";
import { useEnvironments } from "~/state/environments";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { InlineButton } from "../ui/button";
import { DraftProjectName } from "./DraftProjectName";
import { DraftHeroProjectHeading } from "./DraftHeroProjectHeading";
import { TriageDraftHero } from "./TriageDraftHero";
import { DraftProjectPicker } from "./DraftProjectPicker";

interface DraftHeroHeadlineProps {
  readonly draftId: DraftId | null;
  readonly onEnvironmentChange: (environmentId: EnvironmentId) => void;
  readonly activeProjectRef: ScopedProjectRef | null;
  readonly activeProjectTitle: string | null;
}

export function DraftHeroHeadline({
  draftId,
  activeProjectRef,
  activeProjectTitle,
  onEnvironmentChange,
}: DraftHeroHeadlineProps) {
  const projects = useProjects();
  const { environments } = useEnvironments();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const setLogicalProjectDraftThreadId = useComposerDraftStore(
    (store) => store.setLogicalProjectDraftThreadId,
  );
  const getComposerDraft = useComposerDraftStore((store) => store.getComposerDraft);
  // A boolean, so typing in a draft does not re-render the hero.
  const isTriageDraftPrompt = useComposerDraftStore((store) =>
    draftId ? isTriagePrompt(store.getComposerDraft(draftId)?.prompt ?? "") : false,
  );
  const {
    scratchEnvironmentId,
    scratchWorkspaceRootFor,
    scratchWorkspaceLabelFor,
    openScratchProject,
  } = useScratchProject();
  const openProjectDraft = useNewThreadHandler();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const environmentLabelById = new Map(
    environments.map((environment) => [environment.environmentId, environment.label]),
  );
  const hasResolvedProject = activeProjectTitle !== null;
  const canChooseProject = projects.some((project) => !project.archivedAt);
  const activeProject =
    activeProjectRef === null
      ? null
      : (projects.find(
          (project) =>
            project.environmentId === activeProjectRef.environmentId &&
            project.id === activeProjectRef.projectId,
        ) ?? null);
  const scratchTargetEnvironmentId = scratchEnvironmentId(activeProjectRef?.environmentId ?? null);
  const scratchWorkspaceRoot = scratchWorkspaceRootFor(scratchTargetEnvironmentId);
  const isScratchDraft =
    activeProject !== null &&
    isScratchProject(activeProject, scratchWorkspaceRootFor(activeProject.environmentId));
  const scratchDraftLabel = (() => {
    if (!isScratchDraft) return null;
    // An older No project home can sit in another folder than the current default.
    const folder =
      activeProject.workspaceRoot === scratchWorkspaceRootFor(activeProject.environmentId)
        ? (scratchWorkspaceLabelFor(activeProject.environmentId) ?? activeProject.workspaceRoot)
        : activeProject.workspaceRoot;
    const connected = environments.filter(
      (environment) => environment.connection.phase === "connected",
    );
    const machine = environmentLabelById.get(activeProject.environmentId);
    return connected.length > 1 && machine ? `${folder} on ${machine}` : folder;
  })();
  const projectTriggerLabel = scratchDraftLabel ?? activeProjectTitle;

  // The picker can change the draft's target while the no-project home is
  // still being opened; a stale continuation must not retarget it again. Picking
  // a project clears the pending request, and the draft session is compared
  // against the store when the scratch project arrives.
  const pendingScratchRef = useRef<symbol | null>(null);
  const draftTargetKey = () => {
    const session = draftId ? useComposerDraftStore.getState().getDraftSession(draftId) : null;
    return session
      ? `${session.environmentId}:${session.projectId}:${session.logicalProjectKey}`
      : null;
  };
  // Retargeting an empty draft would overwrite the project's draft and strand browser tabs.
  const selectProject = (project: (typeof projects)[number], logicalProjectKey: string) => {
    if (!draftId) {
      return;
    }
    pendingScratchRef.current = null;
    const projectRef = scopeProjectRef(project.environmentId, project.id);
    if (!composerDraftHasUserContent(getComposerDraft(draftId))) {
      void openProjectDraft(projectRef);
      return;
    }
    setLogicalProjectDraftThreadId(
      logicalProjectKey,
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
    const environmentId = activeProjectRef?.environmentId ?? scratchTargetEnvironmentId;
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
        const project = await waitForProject(projectRef, 5_000);
        selectProject(
          project,
          deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings),
        );
      },
    });
  };
  const startScratch = async (): Promise<boolean> => {
    if (scratchTargetEnvironmentId === null || isScratchDraft) {
      return false;
    }
    const request = Symbol("scratch");
    pendingScratchRef.current = request;
    const requestedTarget = draftTargetKey();
    const project = await openScratchProject(scratchTargetEnvironmentId);
    if (!project || pendingScratchRef.current !== request || draftTargetKey() !== requestedTarget) {
      return false;
    }
    pendingScratchRef.current = null;
    selectProject(project, deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings));
    return true;
  };

  const projectSelector = (
    <DraftProjectPicker
      draftId={draftId}
      activeProjectRef={activeProjectRef}
      environmentId={activeProjectRef?.environmentId ?? scratchTargetEnvironmentId}
      label={projectTriggerLabel ?? "Choose a project"}
      truncateStart={scratchDraftLabel !== null}
      onSelect={(project) =>
        selectProject(
          project,
          deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings),
        )
      }
      onEnvironmentChange={onEnvironmentChange}
      onAddProject={openAddProject}
    />
  );

  const noProjectShortcut = shortcutLabelForCommand(keybindings, "chat.newWithoutProject");
  const orStartWithoutProject =
    scratchWorkspaceRoot !== null && !isScratchDraft && (hasResolvedProject || canChooseProject) ? (
      <Tooltip>
        <TooltipTrigger
          render={
            <InlineButton
              tone="muted"
              className="pointer-events-auto inline-flex min-w-0 max-w-full"
              onClick={() =>
                void startScratch().then((started) => {
                  if (started) {
                    document.querySelector<HTMLElement>("[data-draft-project-trigger]")?.focus();
                  }
                })
              }
            />
          }
        >
          <span className="shrink-0 whitespace-pre">or start in </span>
          <DraftProjectName
            value={scratchWorkspaceLabelFor(scratchTargetEnvironmentId) ?? ""}
            truncateStart
          />
        </TooltipTrigger>
        {noProjectShortcut ? <TooltipPopup side="bottom">{noProjectShortcut}</TooltipPopup> : null}
      </Tooltip>
    ) : null;

  if (isScratchDraft && isTriageDraftPrompt) {
    const environment = environments.find(
      (entry) => entry.environmentId === activeProject.environmentId,
    );
    return (
      <TriageDraftHero
        machineLabel={environment?.label ?? null}
        serverVersion={environment?.serverConfig?.environment.serverVersion ?? null}
      />
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col items-center">
      {hasResolvedProject && !isScratchDraft ? (
        <DraftHeroProjectHeading projectName={activeProjectTitle ?? "Choose a project"}>
          {projectSelector}
        </DraftHeroProjectHeading>
      ) : (
        <h1 className="w-full text-center font-normal text-2xl text-foreground tracking-tight sm:text-3xl">
          {isScratchDraft ? (
            <>What should we work on?</>
          ) : canChooseProject ? (
            <>{projectSelector} to start</>
          ) : (
            <>Add a project to start</>
          )}
        </h1>
      )}
      {scratchWorkspaceRoot === null ? null : (
        <p className="mt-2 flex h-6 w-full items-center justify-center text-sm">
          {isScratchDraft ? projectSelector : orStartWithoutProject}
        </p>
      )}
    </div>
  );
}
