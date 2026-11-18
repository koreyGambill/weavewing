import { describe, expect, it } from "vite-plus/test";
import {
  isProjectPickerPath,
  projectPickerPathLabel,
  rankPickerProjects,
  pickerProjectSections,
} from "./projectPicker.logic.ts";
import { ensureBrowseDirectoryPath, getBrowseParentPath } from "./state/projects.ts";

const projects = [
  {
    key: "wsl:spark",
    environmentId: "wsl",
    title: "sparkwing",
    workspaceRoot: "/home/me/code/sparkwing",
    pinned: true,
    activity: 1,
  },
  {
    key: "win:spark",
    environmentId: "win",
    title: "sparkwing",
    workspaceRoot: "C:\\Users\\me\\sparkwing",
    pinned: false,
    activity: 20,
  },
  {
    key: "wsl:other",
    environmentId: "wsl",
    title: "other",
    workspaceRoot: "/home/me/code/overwing",
    pinned: false,
    activity: 10,
  },
];

describe("project picker", () => {
  it("scopes before ranking and matches fuzzy names and paths", () => {
    expect(rankPickerProjects(projects, "wsl", "sprkwng").map((p) => p.key)).toEqual(["wsl:spark"]);
    expect(rankPickerProjects(projects, null, "spark").map((p) => p.key)).toEqual([
      "win:spark",
      "wsl:spark",
    ]);
    expect(rankPickerProjects(projects, "wsl", "code/ov").map((p) => p.key)).toEqual(["wsl:other"]);
    expect(rankPickerProjects(projects, "wsl", "nothing")).toEqual([]);
  });

  it("keeps pinned and five recent rows in place when expanding", () => {
    const many = [
      ...projects,
      ...Array.from({ length: 8 }, (_, i) => ({ ...projects[2]!, key: `wsl:${i}`, activity: i })),
    ];
    const collapsed = pickerProjectSections(rankPickerProjects(many, "wsl", ""));
    expect(collapsed.pinned.map((p) => p.key)).toEqual(["wsl:spark"]);
    expect(collapsed.recent.map((p) => p.activity)).toEqual([10, 7, 6, 5, 4]);
    expect(collapsed.more.map((p) => p.activity)).toEqual([3, 2, 1, 0]);
  });

  it.each([
    "~",
    "~/code/sp",
    "/home/me/",
    "./code",
    "../",
    ".",
    "C:\\Users\\me",
    "D:/code/",
    "\\\\server\\share",
  ])("recognizes folder query %s", (path) => {
    expect(isProjectPickerPath(path)).toBe(true);
  });

  it.each(["sparkwing", "code/overwing", "c", "repo.name"])(
    "keeps project query %s in name search",
    (query) => {
      expect(isProjectPickerPath(query)).toBe(false);
    },
  );

  it("uses only the destination machine's home and keeps Windows separators", () => {
    expect(projectPickerPathLabel("/home/me/code/sparkwing", "/home/me")).toBe("~/code/sparkwing");
    expect(projectPickerPathLabel("/home/mean/code", "/home/me")).toBe("/home/mean/code");
    expect(projectPickerPathLabel("C:\\Users\\Me\\code\\sparkwing", "c:\\users\\me")).toBe(
      "~\\code\\sparkwing",
    );
    expect(ensureBrowseDirectoryPath("C:\\code\\sparkwing")).toBe("C:\\code\\sparkwing\\");
    expect(getBrowseParentPath("~/code/sparkwing/")).toBe("~/code/");
    expect(getBrowseParentPath("C:\\code\\sparkwing\\")).toBe("C:\\code\\");
    expect(getBrowseParentPath("/")).toBeNull();
  });
});
