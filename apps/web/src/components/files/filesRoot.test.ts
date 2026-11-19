import { describe, expect, it } from "vite-plus/test";

import {
  filesTabRoot,
  newFilesTabRoot,
  filesRootBrowsePath,
  filesSearchRoot,
  parentHostFolder,
  resolveFilesRoot,
  workspacePathOf,
} from "./filesRoot";

describe("parentHostFolder", () => {
  it.each([
    ["/repo/src", "/repo"],
    ["/repo/src/", "/repo"],
    ["/repo", "/"],
    ["/", null],
    ["C:\\repo\\src", "C:\\repo"],
    ["C:\\repo", "C:\\"],
    ["C:\\", null],
    ["~/code", "~/"],
    ["\\\\server\\share", null],
  ])("goes up from %j to %j", (path, parent) => {
    expect(parentHostFolder(path)).toBe(parent);
  });
});

describe("files tab roots", () => {
  it.each([
    ["/repo", null],
    ["/repo/", null],
    ["/repo/src", "/repo/src"],
    ["/elsewhere", "/elsewhere"],
  ])("stores %j as %j", (root, stored) => {
    expect(filesTabRoot(root, "/repo")).toBe(stored);
  });

  it.each([
    ["src", "./src/"],
    ["..", "../"],
    ["~", "~"],
    ["~/", "~/"],
    ["~\\Documents", "~\\Documents/"],
    ["C:\\Users", "C:\\Users/"],
    ["/tmp/logs/", "/tmp/logs/"],
  ])("asks the environment to resolve %j as %j", (input, partialPath) => {
    expect(filesRootBrowsePath(input)).toBe(partialPath);
  });

  it.each([
    ["/repo/src/app.ts", "src/app.ts"],
    ["/elsewhere/app.ts", "/elsewhere/app.ts"],
    ["src/app.ts", "src/app.ts"],
  ])("opens %j as %j", (path, opened) => {
    expect(workspacePathOf(path, "/repo")).toBe(opened);
  });
});

describe("resolveFilesRoot", () => {
  const workspaceRoot = "/home/u/repo";
  // Mirrors the server's browse resolution: `~` expands to home, explicit relatives use cwd.
  const resolveFolder = async (partialPath: string, cwd: string) => {
    const expanded = partialPath.replace(/^~(?=$|[\\/])/, "/home/u");
    const resolved = new URL(expanded, `file://${cwd}/`).pathname;
    return resolved.length > 1 ? resolved.replace(/\/+$/, "") : resolved;
  };

  it.each([
    { input: "..", root: "/home/u", search: null },
    { input: "src", root: "/home/u/repo/src", search: "/home/u/repo/src" },
    { input: "~", root: "/home/u", search: null },
    { input: "~/", root: "/home/u", search: null },
    { input: "~/repo/src", root: "/home/u/repo/src", search: "/home/u/repo/src" },
    { input: "~/repo", root: null, search: workspaceRoot },
    { input: "/tmp/logs/", root: "/tmp/logs", search: null },
  ])("stores $input as $root and searches $search", async ({ input, root, search }) => {
    const stored = await resolveFilesRoot(input, workspaceRoot, resolveFolder);
    expect(stored).toBe(root);
    expect(filesSearchRoot(stored ?? workspaceRoot, workspaceRoot)).toBe(search);
    if (stored !== null && stored !== undefined) {
      expect(parentHostFolder(stored)).toBe(await resolveFolder(`${stored}/..`, "/"));
    }
  });

  it("ignores an empty path", async () => {
    expect(await resolveFilesRoot("  ", workspaceRoot, resolveFolder)).toBeUndefined();
  });
});

describe("newFilesTabRoot", () => {
  const entryKinds = new Map([
    ["lib", "directory"],
    ["lib/util", "directory"],
    ["lib/util/a.ts", "file"],
    ["README.md", "file"],
  ] as const);

  it.each([
    { selected: ["lib/util/"], focused: null, root: "/repo/src/lib/util" },
    { selected: ["lib/util/a.ts"], focused: null, root: "/repo/src/lib/util" },
    { selected: ["README.md"], focused: null, root: "/repo/src" },
    { selected: [], focused: "lib/", root: "/repo/src/lib" },
    { selected: [], focused: null, root: "/repo/src" },
  ])(
    "starts at $root for selection $selected and focus $focused",
    ({ selected, focused, root }) => {
      expect(
        newFilesTabRoot({
          treeRoot: "/repo/src",
          selectedPaths: selected,
          focusedPath: focused,
          entryKinds,
        }),
      ).toBe(root);
    },
  );
});
