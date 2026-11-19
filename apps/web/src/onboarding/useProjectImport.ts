import type { EnvironmentId, ProjectId, ScopedProjectRef } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { AuthOrchestrationOperateScope, CommandId } from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import type { ImportCandidate } from "../components/onboarding/ImportCandidateList";
import { newProjectId } from "../lib/utils";
import { agentSessionImport } from "../state/agentSessions";
import { readProjects, useProjects, waitForProject } from "../state/entities";
import { projectEnvironment } from "../state/projects";
import { readEnvironmentScope, useEnvironmentsWithScope } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";
import {
  isNewOnboardingProject,
  partitionOnboardingProjects,
  onboardingProjectKey,
  resolveOnboardingLandingProject,
  resolveOnboardingProjectId,
} from "./projectImport.logic";
import type { useProjectScans } from "./useProjectScans";
import type { WelcomeImportSelection } from "./welcomeState";

const IMPORT_PERMISSION_MESSAGE = "This connection cannot import projects or thread history.";

// Creates the selected projects, then imports each one's agent history. Owns retry state so a
// second Start resumes instead of recreating projects.
export function useProjectImport({
  scans,
  importSelection,
  onImportSelectionChange,
  isImporting,
  setIsImporting,
  holdPageRef,
  onDone,
}: {
  readonly scans: ReturnType<typeof useProjectScans>;
  readonly importSelection: WelcomeImportSelection | null;
  readonly onImportSelectionChange: (next: WelcomeImportSelection) => void;
  readonly isImporting: boolean;
  readonly setIsImporting: (value: boolean) => void;
  // Blocks leaving the page; onDone releases it before landing.
  readonly holdPageRef: { current: boolean };
  readonly onDone: (
    projectRef?: ScopedProjectRef,
    importWarning?: string,
    importedThreadCount?: number,
  ) => Promise<boolean>;
}) {
  const writableEnvironments = useEnvironmentsWithScope(scans, AuthOrchestrationOperateScope);
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const importThreads = useAtomCommand(agentSessionImport, { reportFailure: false });
  const importWarningRef = useRef("");
  // Per project, so a retry that skips finished projects still counts their threads.
  const importedThreadsRef = useRef(new Map<string, number>());
  const importedProjectsRef = useRef(new Map<string, ScopedProjectRef>());
  const projectsWithImportedHistoryRef = useRef(new Map<string, ScopedProjectRef>());
  const lastImportSelectionRef = useRef<ReadonlyArray<string>>([]);
  const projectAttemptsRef = useRef(
    new Map<string, { readonly projectId: ProjectId; readonly commandId: CommandId }>(),
  );
  const importGenerationRef = useRef(0);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- bumps the import generation on mount and unmount so in-flight imports drop stale results
  useEffect(() => {
    importGenerationRef.current += 1;
    return () => {
      importGenerationRef.current += 1;
    };
  }, []);

  const { available: candidates, recent: recentActive } = partitionOnboardingProjects(
    scans.flatMap((scan) =>
      (scan.data?.candidates ?? []).map((candidate) => ({
        ...candidate,
        environmentId: scan.environmentId,
        key: onboardingProjectKey(scan.environmentId, candidate.path),
      })),
    ),
  );
  // Projects already in T3 Code stay in the list, but reopening the page does not import their
  // history again unless the user picks them. The scan can be 30 s old, so the live list decides.
  const projects = useProjects();
  const isNewProject = isNewOnboardingProject(projects);
  const isNew = (candidate: ImportCandidate) => isNewProject(candidate.environmentId, candidate);
  const recent = recentActive.filter(isNew);
  const recentKeys = new Set(recent.map((candidate) => candidate.key));
  const knownKeys = new Set(importSelection?.knownKeys);
  const pickedKeys = new Set(importSelection?.keys);
  const selected = importSelection?.optedOut
    ? []
    : candidates.filter((candidate) =>
        knownKeys.has(candidate.key)
          ? pickedKeys.has(candidate.key)
          : recentKeys.has(candidate.key),
      );
  const selectedKeys = new Set(selected.map((candidate) => candidate.key));
  const setSelectedKeys = (keys: ReadonlySet<string>, { optedOut = false } = {}) =>
    onImportSelectionChange({
      knownKeys: candidates.map((candidate) => candidate.key),
      keys: [...keys],
      optedOut,
    });

  const canWrite = scans.every((scan) => writableEnvironments.has(scan.environmentId));
  const canImport = selected.every((candidate) =>
    writableEnvironments.has(candidate.environmentId),
  );
  const visibleImportError = canWrite && canImport ? "" : IMPORT_PERMISSION_MESSAGE;

  const importedThreadTotal = () =>
    lastImportSelectionRef.current.reduce(
      (total, key) => total + (importedThreadsRef.current.get(key) ?? 0),
      0,
    );

  const finishAfterImport = () => {
    const projectRef = resolveOnboardingLandingProject(
      lastImportSelectionRef.current,
      projectsWithImportedHistoryRef.current,
      importedProjectsRef.current,
    );
    // Busy until setup is saved, so Start cannot run the import again meanwhile.
    setIsImporting(true);
    if (projectRef === undefined) {
      void onDone(undefined, importWarningRef.current, importedThreadTotal()).then((completed) => {
        if (!completed) setIsImporting(false);
      });
      return;
    }
    holdPageRef.current = true;
    const importGeneration = importGenerationRef.current;
    // waitForProject gives up after its timeout, so a project that never reaches the client
    // still finishes setup, just without landing in it.
    void waitForProject(projectRef)
      .then(
        () => projectRef,
        () => undefined,
      )
      .then(async (landing) => {
        if (importGeneration !== importGenerationRef.current) {
          holdPageRef.current = false;
          return;
        }
        const completed = await onDone(landing, importWarningRef.current, importedThreadTotal());
        if (!completed) setIsImporting(false);
      });
  };

  const runImport = async (selection: typeof candidates) => {
    if (isImporting) return;
    const hasAccess = () =>
      selection.every((candidate) =>
        readEnvironmentScope(candidate.environmentId, AuthOrchestrationOperateScope),
      );
    // The permission message shows from the session's scopes.
    const stopForDeniedAccess = () => setIsImporting(false);
    if (!hasAccess()) {
      stopForDeniedAccess();
      return;
    }
    setIsImporting(true);
    importWarningRef.current = "";
    lastImportSelectionRef.current = selection.map((candidate) => candidate.key);
    const importGeneration = importGenerationRef.current;
    const importedThreads = importedThreadsRef.current;
    const importedProjects = importedProjectsRef.current;
    const projectAttempts = projectAttemptsRef.current;
    let importedProjectsCount =
      importedProjects.size > 0
        ? selection.filter((candidate) => importedProjects.has(candidate.key)).length
        : 0;
    let skippedThreadCount = 0;
    const refreshEnvironments = new Set<EnvironmentId>();
    // Resolves false when the run stopped early: a newer run, an unmount, or lost access.
    const importEach = async () => {
      for (const candidate of selection) {
        const { environmentId } = candidate;
        if (importGeneration !== importGenerationRef.current) return false;
        if (!hasAccess()) {
          stopForDeniedAccess();
          return false;
        }
        if (importedProjects.has(candidate.key)) continue;
        let projectId = resolveOnboardingProjectId(readProjects(), environmentId, candidate);
        if (projectId === null) {
          let attempt = projectAttempts.get(candidate.key);
          if (attempt === undefined) {
            const nextProjectId = newProjectId();
            attempt = {
              projectId: nextProjectId,
              commandId: CommandId.make(`onboarding:project:create:${nextProjectId}`),
            };
            projectAttempts.set(candidate.key, attempt);
          }
          projectId = attempt.projectId;
          const result = await createProject({
            environmentId,
            input: {
              projectId,
              commandId: attempt.commandId,
              title: candidate.title,
              workspaceRoot: candidate.path,
              createWorkspaceRootIfMissing: false,
              defaultModelSelection: null,
            },
          });
          if (importGeneration !== importGenerationRef.current) return false;
          if (result._tag !== "Success") {
            if (!isAtomCommandInterrupted(result)) {
              projectAttempts.delete(candidate.key);
              refreshEnvironments.add(environmentId);
            }
            continue;
          }
        }

        if (!hasAccess()) {
          stopForDeniedAccess();
          return false;
        }
        const threadImportResult = await importThreads({
          environmentId,
          input: { projectId, expectedWorkspaceRoot: candidate.path },
        });
        if (importGeneration !== importGenerationRef.current) return false;
        if (threadImportResult._tag === "Success") {
          importedThreads.set(
            candidate.key,
            (importedThreads.get(candidate.key) ?? 0) + threadImportResult.value.importedCount,
          );
          skippedThreadCount += threadImportResult.value.skippedCount;
          if (threadImportResult.value.importedCount > 0) {
            projectsWithImportedHistoryRef.current.set(
              candidate.key,
              scopeProjectRef(environmentId, projectId),
            );
          }
          if (threadImportResult.value.skippedCount === 0) {
            importedProjectsCount += 1;
            importedProjects.set(candidate.key, scopeProjectRef(environmentId, projectId));
          }
        } else if (!isAtomCommandInterrupted(threadImportResult)) {
          projectAttempts.delete(candidate.key);
          refreshEnvironments.add(environmentId);
        }
      }
      return true;
    };
    holdPageRef.current = true;
    const completed = await importEach().finally(() => {
      holdPageRef.current = false;
    });
    if (!completed) return;
    for (const scan of scans) {
      if (refreshEnvironments.has(scan.environmentId)) scan.refresh();
    }
    setIsImporting(false);
    const importedThreadCount = importedThreadTotal();
    if (importedProjectsCount < selection.length) {
      if (importedThreadCount > 0 && skippedThreadCount > 0) {
        importWarningRef.current = `Imported ${importedThreadCount} ${importedThreadCount === 1 ? "thread" : "threads"}. ${skippedThreadCount} ${skippedThreadCount === 1 ? "thread" : "threads"} could not be imported.`;
      } else if (skippedThreadCount > 0) {
        importWarningRef.current = `${skippedThreadCount} ${skippedThreadCount === 1 ? "thread could" : "threads could"} not be imported.`;
      } else if (importedThreadCount > 0) {
        importWarningRef.current = `Imported ${importedThreadCount} ${importedThreadCount === 1 ? "thread" : "threads"}. Some thread history could not be imported.`;
      } else {
        importWarningRef.current = "Could not import thread history.";
      }
    }
    finishAfterImport();
  };

  return {
    canWrite,
    candidates,
    isNew,
    recent,
    selected,
    selectedKeys,
    setSelectedKeys,
    visibleImportError,
    runImport,
    finishAfterImport,
  };
}
