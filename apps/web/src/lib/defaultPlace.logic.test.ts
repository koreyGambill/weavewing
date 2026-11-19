import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { defaultPlaceUpdate, resolveDefaultPlace } from "./defaultPlace.logic";

const WSL = EnvironmentId.make("wsl");
const WIN = EnvironmentId.make("win");
const repo = { environmentId: WSL, projectId: ProjectId.make("repo") };
const other = { environmentId: WIN, projectId: ProjectId.make("other") };
const projects = [
  { environmentId: WSL, id: repo.projectId, title: "weavewing", archivedAt: null },
  { environmentId: WIN, id: other.projectId, title: "other", archivedAt: null },
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
  it("makes a project inside a Git repository the default project, never the default folder", () => {
    expect(defaultPlaceUpdate({ projectRef: repo, isScratch: false })).toEqual({
      preferredEnvironmentId: WSL,
      defaultProject: repo,
    });
    expect(defaultPlaceUpdate({ projectRef: repo, isScratch: true })).toEqual({
      preferredEnvironmentId: WSL,
      defaultProject: null,
    });
    // Ctrl+N then opens that project.
    expect(resolveDefaultPlace({ ...base, defaultProject: repo })).toEqual({
      kind: "project",
      projectRef: repo,
      notice: null,
    });
  });

  it("starts in the next usable place when the default folder is refused", () => {
    expect(
      resolveDefaultPlace({
        ...base,
        scratchChoice: { kind: "preferred-unavailable", environmentId: WSL },
        fallbackProject: other,
      }),
    ).toEqual({
      kind: "project",
      projectRef: other,
      notice: "WSL has no usable default folder, so this thread starts in other.",
    });
  });

  it("falls back to the default folder when the default project was archived", () => {
    expect(
      resolveDefaultPlace({
        ...base,
        defaultProject: repo,
        projects: [{ ...projects[0]!, archivedAt: "2026-11-01T00:00:00.000Z" }, projects[1]!],
      }),
    ).toEqual({
      kind: "scratch",
      environmentId: WSL,
      notice: "Your default project is archived, so this thread starts in the default folder.",
    });
  });

  it("names an offline default project and its machine", () => {
    expect(
      resolveDefaultPlace({ ...base, defaultProject: repo, isConnected: (id) => id !== WSL }),
    ).toMatchObject({ kind: "scratch", notice: expect.stringContaining("WSL is offline") });
  });

  it("reports nothing usable rather than guessing", () => {
    expect(resolveDefaultPlace({ ...base, scratchChoice: { kind: "none" } })).toEqual({
      kind: "none",
    });
  });
});
