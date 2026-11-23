import { describe, expect, it } from "vite-plus/test";

import {
  authoredFileLinkSuffix,
  fileLinkShownPath,
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
