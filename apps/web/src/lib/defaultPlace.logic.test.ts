import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { defaultPlaceUpdate, resolveDefaultPlace } from "./defaultPlace.logic";

const WSL = EnvironmentId.make("wsl");
const WIN = EnvironmentId.make("win");
const repo = { environmentId: WSL, projectId: ProjectId.make("repo") };
const recent = { environmentId: WIN, projectId: ProjectId.make("recent") };
const projects = [
  { environmentId: WSL, id: repo.projectId, title: "weavewing", archivedAt: null },
  { environmentId: WIN, id: recent.projectId, title: "recent", archivedAt: null },
];
const base = {
  defaultProject: null,
  projects,
  isConnected: () => true,
  scratchChoice: { kind: "chosen", environmentId: WSL } as const,
  fallbackScratchEnvironmentId: null,
  fallbackProject: null,
  environmentLabel: (id: EnvironmentId) => (id === WSL ? "WSL" : "Windows"),
};

describe("default place", () => {
  it.each([
    {
      state: "stored default project usable",
      input: { defaultProject: repo },
      expected: { kind: "project", projectRef: repo, unavailable: null },
    },
    {
      state: "default folder usable",
      input: {},
      expected: { kind: "scratch", environmentId: WSL, unavailable: null },
    },
    {
      state: "default project's machine offline",
      input: { defaultProject: repo, isConnected: (id: EnvironmentId) => id !== WSL },
      expected: { kind: "scratch", environmentId: WSL, unavailable: "WSL is offline" },
    },
    {
      state: "default project deleted",
      input: { defaultProject: repo, projects: [projects[1]!] },
      expected: {
        kind: "scratch",
        environmentId: WSL,
        unavailable: "the default project no longer exists",
      },
    },
    {
      state: "default project archived",
      input: {
        defaultProject: repo,
        projects: [{ ...projects[0]!, archivedAt: "2026-11-01T00:00:00.000Z" }, projects[1]!],
      },
      expected: {
        kind: "scratch",
        environmentId: WSL,
        unavailable: "the default project is archived",
      },
    },
    {
      state: "default folder refused",
      input: {
        scratchChoice: { kind: "preferred-unavailable", environmentId: WSL } as const,
        fallbackProject: recent,
      },
      expected: {
        kind: "project",
        projectRef: recent,
        unavailable: "the default folder on WSL can't be used",
      },
    },
    {
      state: "preferred machine offline",
      input: {
        isConnected: (id: EnvironmentId) => id !== WSL,
        scratchChoice: { kind: "preferred-unavailable", environmentId: WSL } as const,
        fallbackScratchEnvironmentId: WIN,
      },
      expected: { kind: "scratch", environmentId: WIN, unavailable: "WSL is offline" },
    },
    {
      state: "nothing usable",
      input: { scratchChoice: { kind: "none" } as const },
      expected: { kind: "none" },
    },
  ])("$state", ({ input, expected }) => {
    expect(resolveDefaultPlace({ ...base, ...input })).toEqual(expected);
  });

  it("saves a project as the default project and a default folder as just its machine", () => {
    expect(defaultPlaceUpdate({ projectRef: repo, isScratch: false })).toEqual({
      preferredEnvironmentId: WSL,
      defaultProject: repo,
    });
    expect(defaultPlaceUpdate({ projectRef: repo, isScratch: true })).toEqual({
      preferredEnvironmentId: WSL,
      defaultProject: null,
    });
  });
});
