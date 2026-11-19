import { describe, expect, it } from "vite-plus/test";

import {
  filesTabRoot,
  newFilesTabRoot,
  parentHostFolder,
  resolveTypedFilesRoot,
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
    ["src/lib", "/repo/src/lib"],
    ["/tmp/logs/", "/tmp/logs"],
    ["~/notes", "~/notes"],
    [".", null],
    ["/repo", null],
  ])("reads typed root %j as %j", (input, root) => {
    expect(resolveTypedFilesRoot(input, "/repo")).toBe(root);
  });

  it.each([
    ["/repo/src/app.ts", "src/app.ts"],
    ["/elsewhere/app.ts", "/elsewhere/app.ts"],
    ["src/app.ts", "src/app.ts"],
  ])("opens %j as %j", (path, opened) => {
    expect(workspacePathOf(path, "/repo")).toBe(opened);
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
