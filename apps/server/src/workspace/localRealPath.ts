// @effect-diagnostics nodeBuiltinImport:off - lstat and readlink one component at a time is the point.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { isNetworkPath } from "@t3tools/shared/path";

const MAX_LINK_HOPS = 40;

/**
 * `realpath` that never touches a network path, which makes Windows sign in to its host with
 * NTLM: the normalized path is lstat'd a component at a time, and a link restarts the walk at
 * its normalized target. Components below a missing one are kept. Null on any refusal.
 */
export async function localRealPath(absolutePath: string): Promise<string | null> {
  if (!NodePath.isAbsolute(absolutePath)) return null;
  let target = NodePath.resolve(absolutePath);
  for (let hops = 0; hops <= MAX_LINK_HOPS; hops++) {
    if (isNetworkPath(target)) return null;
    const root = NodePath.parse(target).root;
    const parts = target
      .slice(root.length)
      .split(/[\\/]+/u)
      .filter((part) => part !== "");
    let resolved = root;
    let link: string | null = null;
    for (const [index, part] of parts.entries()) {
      const next = NodePath.join(resolved, part);
      const stat = await NodeFSP.lstat(next).catch((error: NodeJS.ErrnoException) =>
        error.code === "ENOENT" || error.code === "ENOTDIR" ? undefined : null,
      );
      if (stat === null) return null;
      if (stat === undefined) return NodePath.join(next, ...parts.slice(index + 1));
      if (stat.isSymbolicLink()) {
        const linkTarget = await NodeFSP.readlink(next).catch(() => null);
        if (linkTarget === null || isNetworkPath(linkTarget)) return null;
        link = NodePath.resolve(resolved, linkTarget, ...parts.slice(index + 1));
        break;
      }
      resolved = next;
    }
    if (link === null) return resolved;
    target = link;
  }
  return null;
}
