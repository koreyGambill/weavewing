// @effect-diagnostics nodeBuiltinImport:off - Git's lock protocol needs exclusive create and rename.
import * as NodeFSP from "node:fs/promises";

import * as Schema from "effect/Schema";

/**
 * The index as it stood before a commit staged anything, so a failed commit can put it back
 * byte for byte, whatever a hook staged or rewrote. Null when the repository has no index yet.
 */
export async function snapshotIndex(indexPath: string): Promise<Buffer | null> {
  return NodeFSP.readFile(indexPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

export class IndexLockedError extends Schema.TaggedError<IndexLockedError>()("IndexLockedError", {
  message: Schema.String,
}) {}

/**
 * Writes the snapshot back the way Git writes an index: through `index.lock`, created
 * exclusively, then renamed over. A lock that already exists belongs to another Git process
 * and is left alone.
 */
export async function restoreIndex(indexPath: string, snapshot: Buffer | null): Promise<void> {
  const lockPath = `${indexPath}.lock`;
  const lock = await NodeFSP.open(lockPath, "wx").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST")
      throw new IndexLockedError({
        message: `${lockPath} exists, so another Git process may be running.`,
      });
    throw error;
  });
  let written = false;
  try {
    if (snapshot !== null) {
      await lock.writeFile(snapshot);
      await lock.sync();
    }
    await lock.close();
    if (snapshot === null) await NodeFSP.rm(indexPath, { force: true });
    else await NodeFSP.rename(lockPath, indexPath);
    written = true;
  } finally {
    await lock.close().catch(() => undefined);
    if (!written || snapshot === null) await NodeFSP.rm(lockPath, { force: true });
  }
}

export const indexLocked = (indexPath: string) =>
  NodeFSP.access(`${indexPath}.lock`).then(
    () => true,
    () => false,
  );
