// @effect-diagnostics nodeBuiltinImport:off - O_NOFOLLOW, nlink and inode checks need node:fs.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

/** The file is no longer the one the caller checked: another write replaced or changed it. */
export class HostFileChangedError extends Schema.TaggedError<HostFileChangedError>()(
  "HostFileChangedError",
  { message: Schema.String },
) {}

/**
 * Replaces a host file via a temp file in its folder (in place when the folder is read-only).
 * The file must stay the single-link regular file at `realPath`, in the same folder, until the
 * write. Node lacks `renameat`, so a swap between the last check and the rename stays possible.
 */
export async function replaceHostFile(
  realPath: string,
  contents: string,
  options?: {
    /** SHA-256 of the file's UTF-8 text, checked on the handle the save replaces. */
    readonly expectedSha256?: string;
  },
): Promise<void> {
  const handle = await NodeFSP.open(
    realPath,
    NodeFS.constants.O_RDONLY |
      (NodeFS.constants.O_NONBLOCK ?? 0) |
      (NodeFS.constants.O_NOFOLLOW ?? 0),
  );
  let temp: string | null = null;
  try {
    const opened = await handle.stat();
    const unchanged = async () => {
      const [current, resolved] = await Promise.all([
        NodeFSP.stat(realPath),
        NodeFSP.realpath(realPath),
      ]);
      if (
        !opened.isFile() ||
        opened.nlink !== 1 ||
        current.nlink !== 1 ||
        resolved !== realPath ||
        current.dev !== opened.dev ||
        current.ino !== opened.ino
      ) {
        throw new HostFileChangedError({
          message: "The file changed or is not a single regular file.",
        });
      }
    };
    await unchanged();
    if (options?.expectedSha256 !== undefined) {
      const current = await handle.readFile();
      const hash = NodeCrypto.createHash("sha256")
        .update(current.toString("utf8"), "utf8")
        .digest("hex");
      if (hash !== options.expectedSha256)
        throw new HostFileChangedError({ message: "The file changed since it was opened." });
    }
    const mode = opened.mode & 0o7777;
    const folder = NodePath.dirname(realPath);
    const folderBefore = await NodeFSP.stat(folder);
    const name = NodePath.join(
      folder,
      `.${NodePath.basename(realPath)}.${NodeCrypto.randomUUID()}.t3-save`,
    );
    const output = await NodeFSP.open(
      name,
      NodeFS.constants.O_WRONLY |
        NodeFS.constants.O_CREAT |
        NodeFS.constants.O_EXCL |
        (NodeFS.constants.O_NOFOLLOW ?? 0),
      mode,
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EACCES" || error.code === "EPERM") return null;
      throw error;
    });
    if (output === null) {
      // The folder takes no new entries, so rewrite the checked file in place.
      const inPlace = await NodeFSP.open(
        realPath,
        NodeFS.constants.O_WRONLY |
          (NodeFS.constants.O_NONBLOCK ?? 0) |
          (NodeFS.constants.O_NOFOLLOW ?? 0),
      );
      try {
        await unchanged();
        // The opened file itself, last: a hard link made after the open aliases it.
        const target = await inPlace.stat();
        if (
          !target.isFile() ||
          target.nlink !== 1 ||
          target.dev !== opened.dev ||
          target.ino !== opened.ino
        ) {
          throw new HostFileChangedError({
            message: "The file changed or is not a single regular file.",
          });
        }
        await inPlace.truncate(0);
        await inPlace.writeFile(contents);
        await inPlace.sync();
      } finally {
        await inPlace.close();
      }
      return;
    }
    temp = name;
    let written: NodeFS.Stats;
    try {
      await output.writeFile(contents);
      // The umask may have narrowed the mode the open asked for.
      await output.chmod(mode);
      await output.sync();
      written = await output.stat();
    } finally {
      await output.close();
    }
    await unchanged();
    // Node has no renameat, so the rename resolves the folder path again: check that it is
    // still the folder the temp file was written in, as late as possible.
    const [folderNow, realFolder, tempNow] = await Promise.all([
      NodeFSP.stat(folder),
      NodeFSP.realpath(folder),
      NodeFSP.lstat(temp),
    ]);
    if (
      realFolder !== folder ||
      folderNow.dev !== folderBefore.dev ||
      folderNow.ino !== folderBefore.ino ||
      tempNow.dev !== written.dev ||
      tempNow.ino !== written.ino
    ) {
      throw new Error("The folder changed while saving.");
    }
    await NodeFSP.rename(temp, realPath);
    temp = null;
    // Best effort: the rename already replaced the file; this only makes it durable sooner.
    await NodeFSP.open(folder, NodeFS.constants.O_RDONLY)
      .then((directory) => directory.sync().finally(() => directory.close()))
      .catch(() => undefined);
  } finally {
    await handle.close();
    if (temp !== null) await NodeFSP.rm(temp, { force: true });
  }
}
