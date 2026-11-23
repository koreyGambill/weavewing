// @effect-diagnostics nodeBuiltinImport:off - lstat and readlink one component at a time is the point.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { isNetworkPath } from "@t3tools/shared/path";

const MAX_LINK_HOPS = 40;

/**
 * `realpath` without ever touching a network path: links are read one component at a time, and
 * a link whose target is a network path is refused before it is followed, since opening one makes
 * Windows sign in to its host with the user's NTLM credentials. Missing trailing components are
 * kept as written. Null for a network path, a link loop, or a component that cannot be read.
 */
export async function localRealPath(absolutePath: string): Promise<string | null> {
  if (isNetworkPath(absolutePath) || !NodePath.isAbsolute(absolutePath)) return null;
  const components = (value: string) =>
    value
      .slice(NodePath.parse(value).root.length)
      .split(/[\\/]+/u)
      .filter((part) => part !== "" && part !== ".");
  let resolved = NodePath.parse(absolutePath).root;
  const pending = components(absolutePath);
  let hops = 0;
  while (pending.length > 0) {
    const part = pending.shift()!;
    if (part === "..") {
      resolved = NodePath.dirname(resolved);
      continue;
    }
    const next = NodePath.join(resolved, part);
    const stat = await NodeFSP.lstat(next).catch((error: NodeJS.ErrnoException) =>
      error.code === "ENOENT" || error.code === "ENOTDIR" ? undefined : null,
    );
    if (stat === null) return null;
    if (stat === undefined) return NodePath.join(next, ...pending);
    if (!stat.isSymbolicLink()) {
      resolved = next;
      continue;
    }
    if (++hops > MAX_LINK_HOPS) return null;
    const target = await NodeFSP.readlink(next).catch(() => null);
    if (target === null || isNetworkPath(target)) return null;
    if (NodePath.isAbsolute(target)) resolved = NodePath.parse(target).root;
    pending.unshift(...components(target));
  }
  return resolved;
}
