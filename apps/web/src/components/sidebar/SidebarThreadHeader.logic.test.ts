import { describe, expect, it } from "vite-plus/test";
import { resolveNewThreadButtons } from "./SidebarThreadHeader.logic";

describe("resolveNewThreadButtons", () => {
  it("names the default place and the current project with their keys", () => {
    expect(
      resolveNewThreadButtons({
        defaultPlaceLabel: "~/code",
        currentProjectLabel: "weavewing",
        newThreadShortcut: "Ctrl+N",
        newThreadInProjectShortcut: "Ctrl+Shift+N",
      }),
    ).toEqual({
      defaultPlace: { label: "New thread in ~/code", tooltip: "New thread in ~/code (Ctrl+N)" },
      currentProject: {
        label: "New thread in weavewing",
        tooltip: "New thread in weavewing (Ctrl+Shift+N)",
      },
    });
  });

  it("says the current-project button starts at the default place when nothing is open", () => {
    expect(
      resolveNewThreadButtons({
        defaultPlaceLabel: "~/code",
        currentProjectLabel: null,
        newThreadShortcut: "Ctrl+N",
        newThreadInProjectShortcut: null,
      }).currentProject,
    ).toEqual({
      label: "New thread in current project",
      tooltip: "No current project, so this starts in ~/code",
    });
  });

  it("drops the place when no default place is known", () => {
    expect(
      resolveNewThreadButtons({
        defaultPlaceLabel: null,
        currentProjectLabel: null,
        newThreadShortcut: undefined,
        newThreadInProjectShortcut: "Ctrl+Shift+N",
      }),
    ).toEqual({
      defaultPlace: { label: "New thread", tooltip: "New thread" },
      currentProject: {
        label: "New thread in current project",
        tooltip: "No current project, so this starts a new thread (Ctrl+Shift+N)",
      },
    });
  });
});
