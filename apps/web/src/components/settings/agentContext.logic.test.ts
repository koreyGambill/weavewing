import { describe, expect, it } from "vite-plus/test";

import {
  commitPaths,
  initialExclusions,
  joinSegments,
  leftUncommitted,
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

describe("commit selection", () => {
  const dirty = [
    { path: "renamed.md", origPath: "notes.md", untracked: false, secret: false },
    { path: "scratch.txt", untracked: true, secret: false },
    { path: ".env", untracked: true, secret: true },
  ];
  const repo = { root: "/repo", head: null, branch: "main", dirty, dirtyCount: 5 };

  it("commits both sides of a rename and leaves secret-looking files unchecked", () => {
    const excluded = initialExclusions(dirty);
    expect([...excluded]).toEqual([".env"]);
    expect(
      commitPaths(
        "/repo",
        dirty.filter((file) => !excluded.has(file.path)),
      ),
    ).toEqual(["/repo/renamed.md", "/repo/notes.md", "/repo/scratch.txt"]);
  });

  it("names what stays uncommitted, including files past the listing cap", () => {
    expect(leftUncommitted(repo, new Set(["renamed.md", ".env"]))).toEqual([
      "notes.md → renamed.md",
      ".env",
      "2 more not listed",
    ]);
  });
});
