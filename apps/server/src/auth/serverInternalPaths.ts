// @effect-diagnostics nodeBuiltinImport:off - Effect's realPath keeps the requested letter case.
import * as NodeFSP from "node:fs/promises";

import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ServerConfig from "../config.ts";
import { isWithinRoot } from "../workspace/KnownWorkspaces.ts";

/** Builds a check for the server's own state files, which client file reads do not serve. */
export const makeIsServerInternalPath = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  // Native realpath returns the on-disk letter case.
  const realPath = (value: string) =>
    Effect.promise(() => NodeFSP.realpath(value).catch(() => path.resolve(value)));
  return Effect.fn("ServerInternalPaths.isServerInternalPath")(function* (filePath: string) {
    const [file, stateDir, secretsDir] = yield* Effect.all(
      [realPath(filePath), realPath(config.stateDir), realPath(config.secretsDir)],
      { concurrency: "unbounded" },
    );
    return (
      isWithinRoot(path, file, secretsDir) ||
      (path.dirname(file) === stateDir && path.basename(file).includes(".sqlite")) ||
      // macOS does not resolve `/dev/fd/N` to the open file's path.
      isWithinRoot(path, file, "/dev/fd")
    );
  });
});

/**
 * Builds a check for files under a T3 home: this server's, and the default `~/.t3` that a dev
 * server's worktree home sits beside. Grants never make these writable, since the settings file
 * holds the grants themselves. Compares case-insensitively to err toward blocking.
 */
export const makeIsServerStatePath = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const realPath = (value: string) =>
    Effect.promise(() => NodeFSP.realpath(value).catch(() => path.resolve(value)));
  const within = (file: string, root: string) => {
    const relative = path.relative(root.toLowerCase(), file.toLowerCase());
    return (
      relative === "" ||
      (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
  };
  return Effect.fn("ServerInternalPaths.isServerStatePath")(function* (filePath: string) {
    const home = yield* HostProcess.HomeDirectory;
    const roots = [config.baseDir, config.stateDir, path.join(home, ".t3")];
    const resolved = yield* Effect.forEach([filePath, ...roots], realPath, {
      concurrency: "unbounded",
    });
    const [file, ...realRoots] = resolved;
    return [...roots, ...realRoots].some(
      (root) => within(path.resolve(filePath), root) || (file !== undefined && within(file, root)),
    );
  });
});
