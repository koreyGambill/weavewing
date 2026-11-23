import { describe, expect, it } from "vite-plus/test";

import { decideFileLinkTap, isAbsoluteLinkDestination } from "./fileLinkTap";

describe("decideFileLinkTap", () => {
  const reader = (kinds: ReadonlyArray<string | null | Error>) => {
    const reads: Array<string> = [];
    let next = 0;
    return {
      reads,
      readKind: (path: string) => {
        reads.push(path);
        const kind = kinds[next++] ?? null;
        return kind instanceof Error ? Promise.reject(kind) : Promise.resolve(kind);
      },
    };
  };
  const tap = (href: string, readKind: (path: string) => Promise<string | null>) =>
    decideFileLinkTap({ href, fullPath: "/repo/notes.md", canRead: true, readKind });

  it("reads a relative link afresh on every tap, so a miss is never reused", async () => {
    const host = reader([null, "file"]);
    expect(await tap("notes.md", host.readKind)).toBe("missing");
    expect(await tap("notes.md", host.readKind)).toBe("open");
    expect(host.reads).toEqual(["/repo/notes.md", "/repo/notes.md"]);
  });

  it("treats a folder as missing and opens the literal path when the read fails", async () => {
    expect(await tap("notes.md", reader(["directory"]).readKind)).toBe("missing");
    expect(await tap("notes.md", reader([new Error("offline")]).readKind)).toBe("open");
  });

  it("opens an absolute link without reading it", async () => {
    const host = reader(["file"]);
    expect(await tap("/repo/notes.md", host.readKind)).toBe("open");
    expect(await tap("file:///repo/notes.md", host.readKind)).toBe("open");
    expect(host.reads).toEqual([]);
  });
});

describe("isAbsoluteLinkDestination", () => {
  it("tells absolute image links from relative ones", () => {
    expect(isAbsoluteLinkDestination("/repo/shot.png")).toBe(true);
    expect(isAbsoluteLinkDestination("<C:\\repo\\shot.png>")).toBe(true);
    expect(isAbsoluteLinkDestination("file:///repo/shot.png")).toBe(true);
    expect(isAbsoluteLinkDestination("./shot.png")).toBe(false);
    expect(isAbsoluteLinkDestination("../shot.png")).toBe(false);
  });
});
