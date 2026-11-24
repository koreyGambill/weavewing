import { describe, expect, it } from "vite-plus/test";

import {
  commitThreadTarget,
  joinSegments,
  splitGenerated,
  watcherErrors,
} from "./agentContext.logic";

describe("splitGenerated", () => {
  it("keeps generated blocks apart and restores the file byte for byte", () => {
    for (const [text, ranges, generated] of [
      ["# Rules\n<!-- a -->\nindex\n<!-- /a -->\ntail\n", [{ startLine: 2, endLine: 4 }], [1]],
      ["<!-- a -->\n<!-- /a -->\n", [{ startLine: 1, endLine: 2 }], [0]],
      ["<!-- a -->\n<!-- /a -->", [{ startLine: 1, endLine: 2 }], [0]],
      ["plain\n", [], []],
    ] as const) {
      const segments = splitGenerated(text, ranges);
      expect(joinSegments(segments), text).toBe(text);
      expect(
        segments.flatMap((segment, index) => (segment.generated ? [index] : [])),
        text,
      ).toEqual(generated);
    }
  });
});

describe("watcherErrors", () => {
  it("names the first problem with each watcher", () => {
    expect(
      watcherErrors([
        { label: "overwing", kind: "command", match: "overwing search" },
        { label: " ", kind: "command", match: "x" },
        { label: "vault", kind: "tool", match: "" },
        { label: "regex", kind: "tool", match: "mcp__(a|b)" },
        { label: "long", kind: "command", match: "a b c d e f g h i" },
      ]),
    ).toEqual([
      null,
      "Add a label.",
      "Add words to match.",
      "Use letters, digits, _ . : - and * for any run of characters.",
      "Use at most 8 words.",
    ]);
  });
});

describe("commitThreadTarget", () => {
  const projects = [
    { id: "app", workspaceRoot: "/code/app" },
    { id: "dotfiles", workspaceRoot: "/home/me/dotfiles/" },
    { id: "vault", workspaceRoot: "/home/me/vault", archivedAt: "2026-11-01T00:00:00.000Z" },
  ];

  it("starts the thread in the checkout, project or new project that holds the repository", () => {
    const checkout = { projectId: "app", worktreePath: "/worktrees/app-1" };
    expect(commitThreadTarget("/worktrees/app-1", projects, checkout)).toEqual({
      projectId: "app",
      worktreePath: "/worktrees/app-1",
      unarchive: false,
    });
    expect(commitThreadTarget("/home/me/dotfiles", projects, checkout)).toEqual({
      projectId: "dotfiles",
      worktreePath: null,
      unarchive: false,
    });
    // The server still holds an archived project's folder, so it comes back instead of a new one.
    expect(commitThreadTarget("/home/me/vault", projects, undefined)).toEqual({
      projectId: "vault",
      worktreePath: null,
      unarchive: true,
    });
    expect(commitThreadTarget("/code/notes", projects, undefined)).toBeNull();
  });
});
