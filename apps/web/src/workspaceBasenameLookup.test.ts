import { describe, expect, it } from "vite-plus/test";

import {
  agentWorkingDirectories,
  authoredFileLinkSuffix,
  fileLinkShownPath,
  filterFileLinkCandidates,
  findFileLinkCandidates,
  isNoisyFileLinkMatch,
  verifyRelativeFileLink,
} from "@t3tools/client-runtime/workspace-basename-lookup";

describe("fileLinkShownPath", () => {
  it("keeps the position exactly as the agent wrote it", () => {
    expect(authoredFileLinkSuffix("./notes.md#L4-L8")).toBe("#L4-L8");
    expect(authoredFileLinkSuffix("src/a.ts:12:3")).toBe(":12:3");
    expect(authoredFileLinkSuffix("src/a.ts:4-8")).toBe(":4-8");
    expect(authoredFileLinkSuffix("src/a.ts")).toBe("");
    expect(fileLinkShownPath("./notes.md#L4-L8", "/code/notes.md")).toBe("/code/notes.md#L4-L8");
  });

  it("shows the link as written until a read finds the file", () => {
    expect(fileLinkShownPath("./notes.md#L4-L8", null)).toBe("./notes.md#L4-L8");
    expect(fileLinkShownPath("/code/x.ts#L2", null)).toBe("/code/x.ts#L2");
  });
});

describe("verifyRelativeFileLink", () => {
  const kinds = (byPath: Record<string, "file" | "directory">) => {
    const reads: Array<string> = [];
    return {
      reads,
      kindOf: (path: string) => {
        reads.push(path);
        return Promise.resolve(byPath[path] ?? null);
      },
    };
  };

  it("confirms only a file at the literal path under the thread root", async () => {
    const host = kinds({ "/code/src/a.ts": "file", "/code/src/dir.ts": "directory" });
    expect(await verifyRelativeFileLink({ linkPath: "src/a.ts", root: "/code", ...host })).toBe(
      "/code/src/a.ts",
    );
    expect(await verifyRelativeFileLink({ linkPath: "./src/a.ts", root: "/code", ...host })).toBe(
      "/code/src/a.ts",
    );
    expect(
      await verifyRelativeFileLink({ linkPath: "src/dir.ts", root: "/code", ...host }),
    ).toBeNull();
    expect(
      await verifyRelativeFileLink({ linkPath: "src/missing.ts", root: "/code", ...host }),
    ).toBeNull();
  });

  it("never looks anywhere but the literal path", async () => {
    const host = kinds({ "/code/weavewing/src/a.ts": "file" });
    expect(
      await verifyRelativeFileLink({ linkPath: "src/a.ts", root: "/code", ...host }),
    ).toBeNull();
    expect(host.reads).toEqual(["/code/src/a.ts"]);
  });

  it("reads nothing for an absolute or home link", async () => {
    const host = kinds({ "/code/src/a.ts": "file" });
    expect(
      await verifyRelativeFileLink({ linkPath: "/code/src/a.ts", root: "/code", ...host }),
    ).toBeNull();
    expect(await verifyRelativeFileLink({ linkPath: "~/a.ts", root: "/code", ...host })).toBeNull();
    expect(host.reads).toEqual([]);
  });

  it("treats a failed read as unconfirmed", async () => {
    expect(
      await verifyRelativeFileLink({
        linkPath: "src/a.ts",
        root: "/code",
        kindOf: () => Promise.reject(new Error("offline")),
      }),
    ).toBeNull();
  });
});

describe("findFileLinkCandidates", () => {
  const search =
    (byRoot: Record<string, { entries: ReadonlyArray<string>; truncated?: boolean } | null>) =>
    (root: string) => {
      const result = byRoot[root];
      return Promise.resolve(
        result === null || result === undefined
          ? result === null
            ? null
            : { entries: [], truncated: false }
          : {
              entries: result.entries.map((path) => ({ path, kind: "file" })),
              truncated: result.truncated ?? false,
            },
      );
    };

  it("lists every file of that name across the roots, whole-path then shallow matches first", async () => {
    const found = await findFileLinkCandidates({
      linkPath: "docs/README.md",
      roots: ["/code", "/code/weavewing", "/code"],
      search: search({
        "/code": {
          entries: [
            "a/README.md",
            "b/docs/README.md",
            "b/docs/README.mdx",
            "a/node_modules/x/README.md",
            "c/readme.md",
          ],
        },
        "/code/weavewing": { entries: ["README.md", "docs/README.md"] },
      }),
    });
    expect(found).toEqual({
      candidates: [
        { path: "/code/b/docs/README.md", matchesPath: true, hidden: false },
        { path: "/code/weavewing/docs/README.md", matchesPath: true, hidden: false },
        { path: "/code/a/README.md", matchesPath: false, hidden: false },
        { path: "/code/weavewing/README.md", matchesPath: false, hidden: false },
        { path: "/code/a/node_modules/x/README.md", matchesPath: false, hidden: true },
      ],
      complete: true,
    });
  });

  it("marks the list incomplete when a search was cut off or failed", async () => {
    const truncated = await findFileLinkCandidates({
      linkPath: "README.md",
      roots: ["/code", "/work"],
      search: search({ "/code": { entries: ["a/README.md"], truncated: true } }),
    });
    expect(truncated).toEqual({
      candidates: [{ path: "/code/a/README.md", matchesPath: false, hidden: false }],
      complete: false,
    });
    const failed = await findFileLinkCandidates({
      linkPath: "README.md",
      roots: ["/code", "/work"],
      search: search({ "/code": { entries: ["a/README.md"] }, "/work": null }),
    });
    expect(failed.complete).toBe(false);
    expect(failed.candidates).toHaveLength(1);
  });

  it("hides git-ignored matches and lists a file any root sees outside the noise", async () => {
    const found = await findFileLinkCandidates({
      linkPath: "README.md",
      roots: ["/code", "/code/app"],
      search: (root) =>
        Promise.resolve({
          entries:
            root === "/code"
              ? [
                  { path: "app/.hidden/README.md", kind: "file" },
                  { path: "app/gen/README.md", kind: "file", ignored: true },
                ]
              : [{ path: ".hidden/README.md", kind: "file" }],
          truncated: false,
        }),
    });
    expect(found.candidates).toEqual([
      { path: "/code/app/.hidden/README.md", matchesPath: false, hidden: true },
      { path: "/code/app/gen/README.md", matchesPath: false, hidden: true },
    ]);
  });
});

describe("isNoisyFileLinkMatch", () => {
  it("flags dependency, build, cache and dot folders under the searched root", () => {
    for (const path of [
      "node_modules/x/README.md",
      "a/.git/README.md",
      "vendor/x/README.md",
      "dist/README.md",
      "a/build/README.md",
      ".next/README.md",
      ".venv/lib/README.md",
      "target/README.md",
      ".cache/README.md",
      "a/.github/README.md",
    ]) {
      expect(isNoisyFileLinkMatch(path, false), path).toBe(true);
    }
  });

  it("keeps ordinary folders, dot files and names that only contain a noise word", () => {
    for (const path of ["README.md", "docs/README.md", ".env.md", "builder/README.md"]) {
      expect(isNoisyFileLinkMatch(path, false), path).toBe(false);
    }
    expect(isNoisyFileLinkMatch("docs/README.md", true)).toBe(true);
  });
});

describe("filterFileLinkCandidates", () => {
  const candidates = [
    { path: "/code/weavewing/README.md", matchesPath: false, hidden: false },
    { path: "/code/bitwing/README.md", matchesPath: false, hidden: false },
    { path: "/code/weavewing/node_modules/x/README.md", matchesPath: false, hidden: true },
  ];

  it("lists visible candidates and counts the hidden ones", () => {
    expect(filterFileLinkCandidates(candidates, "", false)).toEqual({
      listed: candidates.slice(0, 2),
      hiddenCount: 1,
    });
    expect(filterFileLinkCandidates(candidates, "", true).listed).toEqual(candidates);
  });

  it("narrows by a case-insensitive substring of the path, hidden count included", () => {
    expect(filterFileLinkCandidates(candidates, "  WeaveWing ", false)).toEqual({
      listed: [candidates[0]],
      hiddenCount: 1,
    });
    expect(filterFileLinkCandidates(candidates, "bitwing", false)).toEqual({
      listed: [candidates[1]],
      hiddenCount: 0,
    });
  });
});

describe("agentWorkingDirectories", () => {
  const directories = (...commands: ReadonlyArray<string>) =>
    agentWorkingDirectories(
      [...commands, "the reply", "cd /work/later"].map((input, index) => ({
        sourceThreadId: "thread",
        sourceItemId: `item-${index}`,
        item: { type: "command_execution", input },
      })),
      { sourceThreadId: "thread", sourceItemId: `item-${commands.length}` },
    );

  it("lists the folders commands above the reply changed into, the latest first", () => {
    expect(
      directories(
        "cd /work/repo-c && cd /work/repo-b && git diff",
        "git status",
        `/bin/zsh -lc "cd '/work/my repo'; ls"`,
        "cd -P /work/repo-a # not this; cd /work/commented",
        "cd /work/repo-c\npwd",
      ),
    ).toEqual(["/work/repo-c", "/work/repo-a", "/work/my repo", "/work/repo-b"]);
  });

  it("skips operands only the shell can resolve and words that are not the command", () => {
    expect(
      directories(
        "cd docs && cd ../other && cd ~/repo && cd $ROOT/x && cd /work/*/src",
        "abcd /work/a; echo cd /work/b; git -C /work/c status; cd /work/d",
        `echo "cd /work/g"; echo 'x; cd /work/h' && grep -c "cd /work/i" notes`,
        "echo bash -c 'cd /work/j'; cd -",
        "cat <<EOF > notes\ncd /work/k\nEOF",
        "cd /work/e\\ f && cd `pwd`/x",
      ),
    ).toEqual(["/work/d"]);
  });
});
