// @effect-diagnostics nodeBuiltinImport:off - The fixture needs real symlinks on disk.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { localRealPath } from "./localRealPath.ts";

describe("localRealPath", () => {
  it("never steps past a missing component into a network link", async () => {
    await using root = await NodeFSP.mkdtempDisposable(NodePath.join(NodeOS.tmpdir(), "t3-real-"));
    await NodeFSP.symlink("//fileserver/share", NodePath.join(root.path, "share"));
    // Joined by hand: `path.join` would fold the `..` away before the walk sees it.
    const sep = NodePath.sep;
    expect(await localRealPath(`${root.path}${sep}missing${sep}..${sep}share${sep}a.ts`)).toBe(
      null,
    );
    expect(await localRealPath(NodePath.join(root.path, "missing", "a.ts"))).toBe(
      NodePath.join(await NodeFSP.realpath(root.path), "missing", "a.ts"),
    );
  });

  it.skipIf(NodePath.sep !== "/")(
    "keeps a backslash as a filename character on POSIX",
    async () => {
      await using root = await NodeFSP.mkdtempDisposable(
        NodePath.join(NodeOS.tmpdir(), "t3-real-"),
      );
      const file = NodePath.join(await NodeFSP.realpath(root.path), "docs\\name.md");
      await NodeFSP.writeFile(file, "doc\n");
      expect(await localRealPath(file)).toBe(file);
    },
  );

  it("checks a link target's components the same way", async () => {
    await using root = await NodeFSP.mkdtempDisposable(NodePath.join(NodeOS.tmpdir(), "t3-real-"));
    await NodeFSP.symlink("//fileserver/share", NodePath.join(root.path, "share"));
    await NodeFSP.symlink("nowhere/../share", NodePath.join(root.path, "detour"));
    expect(await localRealPath(NodePath.join(root.path, "detour", "a.ts"))).toBe(null);
  });
});
