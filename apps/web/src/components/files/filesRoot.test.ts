import { describe, expect, it } from "vite-plus/test";

import {
  filesTabRoot,
  newFilesTabRoot,
  filesRootBrowsePath,
  filesSearchRoot,
  latestRequest,
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
  ])("asks a POSIX environment to resolve %j as %j", (input, partialPath) => {
    expect(filesRootBrowsePath(input, false)).toBe(partialPath);
  });

  it.each([
    ["Tools", "./Tools/"],
    ["..\\Tools", "..\\Tools/"],
    ["\\Tools", "\\Tools/"],
    ["C:Tools", "C:Tools/"],
    ["C:\\Tools", "C:\\Tools/"],
    ["C:\\", "C:\\"],
    ["//server/share", "//server/share/"],
    ["\\\\server\\share", "\\\\server\\share/"],
    ["~\\Documents", "~\\Documents/"],
  ])("asks a Windows environment to resolve %j as %j", (input, partialPath) => {
    expect(filesRootBrowsePath(input, true)).toBe(partialPath);
  });

  it("takes only the latest of overlapping requests", () => {
    const begin = latestRequest();
    const first = begin();
    const second = begin();
    expect([first(), second()]).toEqual([false, true]);
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
  const resolvePath = (partialPath: string, cwd: string) => {
    const expanded = partialPath.replace(/^~(?=$|[\\/])/, "/home/u");
    const resolved = new URL(expanded, `file://${cwd}/`).pathname;
    return resolved.length > 1 ? resolved.replace(/\/+$/, "") : resolved;
  };
  const resolveFolder = async (partialPath: string, cwd: string) => ({
    path: resolvePath(partialPath, cwd),
  });
  const resolve = (input: string) =>
    resolveFilesRoot(input, { workspaceRoot, windows: false, resolveFolder });

  it.each([
    { input: "..", root: "/home/u", search: null },
    { input: "src", root: "/home/u/repo/src", search: "/home/u/repo/src" },
    { input: "~", root: "/home/u", search: null },
    { input: "~/", root: "/home/u", search: null },
    { input: "~/repo/src", root: "/home/u/repo/src", search: "/home/u/repo/src" },
    { input: "~/repo", root: null, search: workspaceRoot },
    { input: "/tmp/logs/", root: "/tmp/logs", search: null },
  ])("stores $input as $root and searches $search", async ({ input, root, search }) => {
    const stored = await resolve(input);
    expect(stored).toBe(root);
    expect(filesSearchRoot(stored ?? workspaceRoot, workspaceRoot)).toBe(search);
    if (stored !== null && stored !== undefined) {
      expect(parentHostFolder(stored)).toBe(resolvePath(`${stored}/..`, "/"));
    }
  });

  it("ignores an empty path", async () => {
    expect(await resolve("  ")).toBeUndefined();
  });

  it.each([
    { name: "a link into the workspace", input: "/home/u/link", root: "/ws/src" },
    { name: "a workspace folder by its real path", input: "/real/ws/src", root: "/ws/src" },
    { name: "the workspace by its real path", input: "/real/ws", root: null },
    { name: "a workspace link that leaves it", input: "/ws/out", root: "/elsewhere" },
  ])("classifies $name by real path", async ({ input, root }) => {
    const realPaths: Record<string, string> = {
      "/ws": "/real/ws",
      "/home/u/link": "/real/ws/src",
      "/real/ws/src": "/real/ws/src",
      "/real/ws": "/real/ws",
      "/ws/out": "/elsewhere",
    };
    const stored = await resolveFilesRoot(input, {
      workspaceRoot: "/ws",
      windows: false,
      resolveFolder: async (partialPath) => {
        const path = partialPath.replace(/\/$/, "");
        return { path, realPath: realPaths[path] ?? path };
      },
    });
    expect(stored).toBe(root);
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
