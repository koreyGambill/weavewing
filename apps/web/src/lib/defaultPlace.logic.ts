import type { WorkEnvironmentChoice } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId, ScopedProjectRef } from "@t3tools/contracts";

export type DefaultPlace =
  | {
      readonly kind: "project";
      readonly projectRef: ScopedProjectRef;
      /** Why the stored default could not be used; null when this is the stored default. */
      readonly unavailable: string | null;
    }
  | {
      readonly kind: "scratch";
      readonly environmentId: EnvironmentId;
      readonly unavailable: string | null;
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
 * machine, else another machine's default folder, else a recent project. `unavailable` says why
 * the stored default could not be used, so every place that shows the result can say so.
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
  let unavailable: string | null = null;
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
      return { kind: "project", projectRef: ref, unavailable: null };
    }
    unavailable =
      project === undefined
        ? "the default project no longer exists"
        : project.archivedAt != null
          ? "the default project is archived"
          : `${input.environmentLabel(ref.environmentId)} is offline`;
  }
  const choice = input.scratchChoice;
  if (choice.kind === "chosen") {
    return { kind: "scratch", environmentId: choice.environmentId, unavailable };
  }
  if (choice.kind === "preferred-unavailable") {
    const machine = input.environmentLabel(choice.environmentId);
    unavailable ??= input.isConnected(choice.environmentId)
      ? `the default folder on ${machine} can't be used`
      : `${machine} is offline`;
    if (input.fallbackScratchEnvironmentId !== null) {
      return { kind: "scratch", environmentId: input.fallbackScratchEnvironmentId, unavailable };
    }
  }
  const fallback = input.fallbackProject;
  const usable =
    fallback !== null &&
    input.projects.some(
      (candidate) =>
        candidate.environmentId === fallback.environmentId &&
        candidate.id === fallback.projectId &&
        candidate.archivedAt == null &&
        input.isConnected(candidate.environmentId),
    );
  return fallback !== null && usable
    ? { kind: "project", projectRef: fallback, unavailable }
    : { kind: "none" };
}
