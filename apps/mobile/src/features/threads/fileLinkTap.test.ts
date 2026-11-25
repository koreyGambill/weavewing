import { describe, expect, it } from "vite-plus/test";

import { decideFileLinkTap, decideMediaLinkTap, isAbsoluteLinkDestination } from "./fileLinkTap";

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

describe("decideMediaLinkTap", () => {
  const tapMedia = (href: string, kinds: ReadonlyArray<string | null>) => {
    const reads: Array<string> = [];
    let next = 0;
    const readKind = (path: string) => {
      reads.push(path);
      return Promise.resolve(kinds[next++] ?? null);
    };
    return {
      reads,
      tap: () => decideMediaLinkTap({ href, mediaPath: "/repo/shots", canRead: true, readKind }),
    };
  };

  it("reads a relative media link afresh on every tap, so a cached folder is never reused", async () => {
    const media = tapMedia("./shots", ["directory", "file"]);
    expect(await media.tap()).toBe("folder");
    expect(await media.tap()).toBe("preview");
    expect(media.reads).toEqual(["/repo/shots", "/repo/shots"]);
  });

  it("previews an absolute media link without reading it", async () => {
    const media = tapMedia("/repo/shots", ["directory"]);
    expect(await media.tap()).toBe("preview");
    expect(media.reads).toEqual([]);
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
