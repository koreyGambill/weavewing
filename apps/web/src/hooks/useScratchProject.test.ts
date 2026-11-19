import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { createScratchProjectActions } from "./useScratchProject";

const local = "local" as EnvironmentId;
const remote = "remote" as EnvironmentId;
const other = "other" as EnvironmentId;

function scratchEnvironment(environmentId: EnvironmentId, scratchWorkspaceRoot: string | null) {
  return {
    environmentId,
    connection: { phase: "connected" },
    serverConfig: { scratchWorkspaceRoot },
  } as never;
}

function actions(
  primary: EnvironmentId | null,
  localRoot: string | null,
  remoteRoot: string | null = "/remote/scratch",
  preferred: EnvironmentId | null = null,
) {
  const environments = [
    scratchEnvironment(local, localRoot),
    scratchEnvironment(remote, remoteRoot),
    scratchEnvironment(other, "/other/scratch"),
  ];
  return createScratchProjectActions({
    environments: () => environments,
    primaryEnvironmentId: () => primary,
    preferredEnvironmentId: () => preferred,
    defaultProject: () => null,
    projects: () => [],
    projectOrder: () => [],
    lastUsedProjectKey: () => null,
    registry: AtomRegistry.make(),
    handleNewThread: async () => null,
  });
}

describe("scratchEnvironmentId", () => {
  it("prefers the primary environment over the one on screen", () => {
    expect(actions(local, "/local/scratch").scratchEnvironmentId(remote)).toBe(local);
    expect(actions(local, "/local/scratch").scratchEnvironmentId(null)).toBe(local);
  });

  it("falls back when the primary environment offers no scratch root", () => {
    expect(actions(local, null).scratchEnvironmentId(remote)).toBe(remote);
    expect(actions(null, null).scratchEnvironmentId(remote)).toBe(remote);
    expect(actions(null, null, null).scratchEnvironmentId(remote)).toBe(other);
    expect(actions(local, null).scratchEnvironmentId(null)).toBeNull();
  });

  it("uses the preferred machine over the primary and the one on screen", () => {
    expect(
      actions(local, "/local/scratch", "/remote/scratch", remote).scratchEnvironmentId(other),
    ).toBe(remote);
  });

  it("does not fall back to the primary when the preferred machine has no scratch root", () => {
    const scratch = actions(local, "/local/scratch", null, remote);
    expect(scratch.scratchEnvironmentChoice(local)).toEqual({
      kind: "preferred-unavailable",
      environmentId: remote,
    });
    expect(scratch.scratchEnvironmentId(local)).toBeNull();
  });

  it("ignores a preferred machine that is no longer saved", () => {
    expect(
      actions(
        local,
        "/local/scratch",
        "/remote/scratch",
        "removed" as EnvironmentId,
      ).scratchEnvironmentId(remote),
    ).toBe(local);
  });
});

describe("default place consumers", () => {
  it("New thread opens, and its tooltip names, the place the resolver gives", async () => {
    const repo = { environmentId: remote, projectId: "repo" as ProjectId };
    const recent = { environmentId: local, projectId: "recent" as ProjectId };
    const opened: unknown[] = [];
    const scratch = createScratchProjectActions({
      // The default project's machine is offline and no machine offers a default folder.
      environments: () =>
        [
          { ...(scratchEnvironment(local, null) as object), label: "Local" },
          {
            ...(scratchEnvironment(remote, null) as object),
            label: "Remote",
            connection: { phase: "disconnected" },
          },
        ] as never,
      primaryEnvironmentId: () => local,
      preferredEnvironmentId: () => null,
      defaultProject: () => repo,
      projects: () =>
        [
          { environmentId: remote, id: repo.projectId, title: "repo", workspaceRoot: "/repo" },
          { environmentId: local, id: recent.projectId, title: "recent", workspaceRoot: "/recent" },
        ] as never,
      projectOrder: () => [],
      lastUsedProjectKey: () => null,
      registry: AtomRegistry.make(),
      handleNewThread: async (projectRef) => {
        opened.push(projectRef);
        return null;
      },
    });
    const place = scratch.defaultPlace();
    expect(place).toEqual({
      kind: "project",
      projectRef: recent,
      unavailable: "Remote is offline",
    });
    expect(scratch.defaultPlaceLabel(place)).toBe("recent");
    await scratch.startDefaultPlace();
    expect(opened).toEqual([recent]);
  });
});
