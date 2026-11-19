import type { WorkEnvironmentChoice } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId, ScopedProjectRef } from "@t3tools/contracts";

export type DefaultPlace =
  | {
      readonly kind: "project";
      readonly projectRef: ScopedProjectRef;
      readonly notice: string | null;
    }
  | {
      readonly kind: "scratch";
      readonly environmentId: EnvironmentId;
      readonly notice: string | null;
    }
  | { readonly kind: "none" };

interface PlaceProject {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
  readonly title: string;
  readonly archivedAt?: string | null | undefined;
}

/**
 * What "Make this the default place" saves on this device. A project is kept as a project, so a
 * folder the server refuses as the default folder, such as one inside a Git repository, never
 * becomes one.
 */
export function defaultPlaceUpdate(place: {
  readonly projectRef: ScopedProjectRef;
  readonly isScratch: boolean;
}): {
  readonly preferredEnvironmentId: EnvironmentId;
  readonly defaultProject: ScopedProjectRef | null;
} {
  return {
    preferredEnvironmentId: place.projectRef.environmentId,
    defaultProject: place.isScratch ? null : place.projectRef,
  };
}

/**
 * Where a new thread starts: the default project, else the default folder on the preferred
 * machine, else another machine's default folder, else a recent project. Every step past the
 * first usable choice says why, so no entry point falls back silently.
 */
export function resolveDefaultPlace(input: {
  readonly defaultProject: ScopedProjectRef | null;
  readonly projects: ReadonlyArray<PlaceProject>;
  readonly isConnected: (environmentId: EnvironmentId) => boolean;
  readonly scratchChoice: WorkEnvironmentChoice<EnvironmentId>;
  readonly fallbackScratchEnvironmentId: EnvironmentId | null;
  readonly fallbackProject: ScopedProjectRef | null;
  readonly environmentLabel: (environmentId: EnvironmentId) => string;
}): DefaultPlace {
  let reason: string | null = null;
  if (input.defaultProject !== null) {
    const ref = input.defaultProject;
    const project = input.projects.find(
      (candidate) =>
        candidate.environmentId === ref.environmentId && candidate.id === ref.projectId,
    );
    if (
      project !== undefined &&
      project.archivedAt == null &&
      input.isConnected(ref.environmentId)
    ) {
      return { kind: "project", projectRef: ref, notice: null };
    }
    reason =
      project === undefined
        ? "Your default project no longer exists"
        : project.archivedAt != null
          ? "Your default project is archived"
          : `${input.environmentLabel(ref.environmentId)} is offline`;
  }
  const choice = input.scratchChoice;
  if (choice.kind === "chosen") {
    return {
      kind: "scratch",
      environmentId: choice.environmentId,
      notice: reason === null ? null : `${reason}, so this thread starts in the default folder.`,
    };
  }
  if (choice.kind === "preferred-unavailable") {
    reason ??= `${input.environmentLabel(choice.environmentId)} has no usable default folder`;
    if (input.fallbackScratchEnvironmentId !== null) {
      return {
        kind: "scratch",
        environmentId: input.fallbackScratchEnvironmentId,
        notice: `${reason}, so this thread starts on ${input.environmentLabel(input.fallbackScratchEnvironmentId)}.`,
      };
    }
  }
  const fallback = input.fallbackProject;
  const fallbackProject =
    fallback === null
      ? undefined
      : input.projects.find(
          (candidate) =>
            candidate.environmentId === fallback.environmentId &&
            candidate.id === fallback.projectId &&
            candidate.archivedAt == null &&
            input.isConnected(candidate.environmentId),
        );
  if (fallback !== null && fallbackProject !== undefined) {
    return {
      kind: "project",
      projectRef: fallback,
      notice:
        reason === null ? null : `${reason}, so this thread starts in ${fallbackProject.title}.`,
    };
  }
  return { kind: "none" };
}
