// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import type {
  OutsideWorkspaceEditGrant,
  ProjectAllowOutsideEditsInput,
  ProjectRevokeOutsideEditsInput,
  FilesystemEntryMetadata,
  FilesystemGetMetadataInput,
  FilesystemGetMetadataResult,
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { isHostPath, isNetworkPath } from "@t3tools/shared/path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { makeIsServerInternalPath, makeIsServerStatePath } from "../auth/serverInternalPaths.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  InstructionFileAllowlist,
  credentialLocations,
  isCredentialPath,
} from "../threadInsights/InstructionFileAllowlist.ts";
import * as KnownWorkspaces from "./KnownWorkspaces.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";
import { fileHeaderMimeType } from "./fileHeaderMimeType.ts";
import { toWslDrivePath } from "./wslDrivePath.ts";

const PROJECT_READ_FILE_MAX_BYTES = 1024 * 1024;

// NTFS reaches .git through trailing dots/spaces, stream suffixes and GIT~1; compare uppercased names.
const isGitMetadataName = (segment: string) => {
  const name = (segment.split(":")[0] ?? "").replace(/[. ]+$/, "").toUpperCase();
  return name === ".GIT" || name === "GIT~1";
};

export class WorkspaceFileSystemOperationError extends Schema.TaggedError<WorkspaceFileSystemOperationError>()(
  "WorkspaceFileSystemOperationError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
    operationPath: Schema.String,
    operation: Schema.Literals([
      "realpath-workspace-root",
      "realpath-target",
      "open",
      "stat",
      "read",
      "close",
      "make-directory",
      "write-file",
    ]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Workspace file operation '${this.operation}' failed at '${this.operationPath}' for resolved path '${this.resolvedPath}' (requested as '${this.relativePath}' in '${this.workspaceRoot}').`;
  }
}

export class WorkspaceFilePathEscapeError extends Schema.TaggedError<WorkspaceFilePathEscapeError>()(
  "WorkspaceFilePathEscapeError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedWorkspaceRoot: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace file '${this.relativePath}' resolves outside workspace root '${this.workspaceRoot}': ${this.resolvedPath}`;
  }
}

export class WorkspacePathNotFileError extends Schema.TaggedError<WorkspacePathNotFileError>()(
  "WorkspacePathNotFileError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace path '${this.relativePath}' in '${this.workspaceRoot}' is not a file: ${this.resolvedPath}`;
  }
}

export class WorkspaceBinaryFileError extends Schema.TaggedError<WorkspaceBinaryFileError>()(
  "WorkspaceBinaryFileError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace file '${this.relativePath}' in '${this.workspaceRoot}' is binary and cannot be previewed as text.`;
  }
}

export const WorkspaceFileSystemError = Schema.Union([
  WorkspaceFileSystemOperationError,
  WorkspaceFilePathEscapeError,
  WorkspacePathNotFileError,
  WorkspaceBinaryFileError,
]);
export type WorkspaceFileSystemError = typeof WorkspaceFileSystemError.Type;

/**
 * `grantedEdits` lets outside edit grants apply. Only sessions that may run host commands get
 * it: a grant can make shell or git config writable, which runs code.
 */
export interface OutsideEditOptions {
  readonly grantedEdits?: boolean;
}

export class WorkspaceFileSystem extends Context.Service<
  WorkspaceFileSystem,
  {
    readonly getMetadata: (
      input: FilesystemGetMetadataInput,
    ) => Effect.Effect<FilesystemGetMetadataResult>;

    readonly readFile: (
      input: ProjectReadFileInput,
      options?: OutsideEditOptions,
    ) => Effect.Effect<
      ProjectReadFileResult,
      WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
    /**
     * Writes inside a known workspace, or to an existing host file on the instruction file
     * allowlist or covered by an outside edit grant.
     */
    readonly writeFile: (
      input: ProjectWriteFileInput,
      options?: OutsideEditOptions,
    ) => Effect.Effect<
      ProjectWriteFileResult,
      | WorkspaceFileSystemError
      | WorkspacePaths.WorkspacePathOutsideRootError
      | KnownWorkspaces.UnknownWorkspaceError
    >;
    /** Grants edits to one host file, or to every host file while `cwd` is the workspace. */
    readonly allowOutsideEdits: (
      input: ProjectAllowOutsideEditsInput,
    ) => Effect.Effect<
      OutsideWorkspaceEditGrant,
      | WorkspaceFileSystemError
      | WorkspacePaths.WorkspacePathOutsideRootError
      | KnownWorkspaces.UnknownWorkspaceError
    >;
    readonly revokeOutsideEdits: (input: ProjectRevokeOutsideEditsInput) => Effect.Effect<void>;
  }
>()("t3/workspace/WorkspaceFileSystem") {}

const UTF8_BOM = "\uFEFF";

async function startsWithUtf8Bom(filePath: string): Promise<boolean> {
  const handle = await NodeFSP.open(
    filePath,
    // O_NONBLOCK keeps a FIFO with no writer from hanging the save.
    NodeFS.constants.O_RDONLY |
      (NodeFS.constants.O_NOFOLLOW ?? 0) |
      (NodeFS.constants.O_NONBLOCK ?? 0),
  ).catch(() => null);
  if (!handle) return false;
  try {
    const { bytesRead, buffer } = await handle.read(Buffer.alloc(3), 0, 3, 0);
    return bytesRead === 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
  } catch {
    return false;
  } finally {
    await handle.close();
  }
}

/** @public */
export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const knownWorkspaces = yield* KnownWorkspaces.KnownWorkspaces;
  const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
  const isServerInternalPath = yield* makeIsServerInternalPath;
  const isServerStatePath = yield* makeIsServerStatePath;
  const instructionFiles = yield* Effect.serviceOption(InstructionFileAllowlist);
  const serverSettings = yield* Effect.serviceOption(ServerSettingsService);
  const grantUpdates = yield* Semaphore.make(1);

  /**
   * Whether the Files tile may edit a host file: null when nothing can make it writable,
   * otherwise its real path and what grants the edit, if anything does yet.
   */
  const hostEditAccess = Effect.fn("WorkspaceFileSystem.hostEditAccess")(function* (
    cwd: string,
    requestedPath: string,
    grantedEdits: boolean,
  ) {
    if (!isHostPath(requestedPath)) return null;
    const home = yield* HostProcess.HomeDirectory;
    const hostPath = expandHomePath(requestedPath, home);
    if (!path.isAbsolute(hostPath) || isNetworkPath(hostPath)) return null;
    if (!(yield* knownWorkspaces.assertContains(cwd).pipe(Effect.isSuccess))) return null;
    // As workspace reads and writes resolve it: `..` first, then links.
    const workspaceRoot = yield* Effect.promise(() =>
      NodeFSP.realpath(path.resolve(cwd)).catch(() => null),
    );
    if (workspaceRoot === null) return null;
    const realPath = yield* Effect.promise(() => NodeFSP.realpath(hostPath).catch(() => null));
    // A symlinked home folder resolves away the prefix the real path is checked against.
    const realHome = yield* Effect.promise(() => NodeFSP.realpath(home).catch(() => home));
    // Where credential locations lead, such as a ~/.aws linked to /mnt/c/Users/<user>/.aws.
    const realCredentials = yield* Effect.promise(() =>
      Promise.all(
        credentialLocations(home).map((location) => NodeFSP.realpath(location).catch(() => null)),
      ),
    );
    const inRealCredential = (file: string) =>
      realCredentials.some((location) => {
        if (location === null) return false;
        const relative = path.relative(location.toLowerCase(), file.toLowerCase());
        return (
          relative === "" ||
          (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
        );
      });
    if (
      realPath === null ||
      isCredentialPath(hostPath, home) ||
      isCredentialPath(path.resolve(hostPath), home) ||
      inRealCredential(realPath) ||
      isCredentialPath(realPath, home) ||
      isCredentialPath(realPath, realHome) ||
      (yield* isServerInternalPath(realPath)) ||
      (yield* isServerStatePath(hostPath)) ||
      // The path as named too: a `.git/config` symlink resolves away the `.git`.
      (yield* Effect.promise(() =>
        Promise.all([isInGitFolder(realPath), isInGitFolder(path.resolve(hostPath))]).then(
          ([real, named]) => real || named,
          () => true,
        ),
      ))
    )
      return null;
    // A hard link aliases another file, which may be a credential.
    const links = yield* Effect.promise(() =>
      NodeFSP.lstat(realPath).then(
        (stat) => (stat.isFile() ? stat.nlink : 0),
        () => 0,
      ),
    );
    if (links !== 1) return null;
    if (
      Option.isSome(instructionFiles) &&
      (yield* instructionFiles.value.editablePath(cwd, hostPath)) === realPath
    )
      return { realPath, workspaceRoot, grant: "allowlist" as const };
    if (Option.isNone(serverSettings)) return null;
    if (!grantedEdits) return { realPath, workspaceRoot, grant: null };
    const grants = yield* serverSettings.value.getSettings.pipe(
      Effect.map((settings) => settings.outsideWorkspaceEditGrants),
      Effect.orElseSucceed((): ReadonlyArray<OutsideWorkspaceEditGrant> => []),
    );
    const fileGrant = grants.find((grant) => grant.kind === "file" && grant.path === realPath);
    if (fileGrant !== undefined) return { realPath, workspaceRoot, grant: fileGrant };
    const workspaceGrant = grants.find(
      (grant) => grant.kind === "workspace" && grant.path === workspaceRoot,
    );
    if (workspaceGrant !== undefined) return { realPath, workspaceRoot, grant: workspaceGrant };
    return { realPath, workspaceRoot, grant: null };
  });

  /** The real path of a host file the Files tile may edit, or null. */
  const editableHostPath = Effect.fn("WorkspaceFileSystem.editableHostPath")(function* (
    cwd: string,
    requestedPath: string,
    grantedEdits: boolean,
  ) {
    const access = yield* hostEditAccess(cwd, requestedPath, grantedEdits);
    return access?.grant ? access.realPath : null;
  });

  const updateOutsideEditGrants = (
    update: (
      grants: ReadonlyArray<OutsideWorkspaceEditGrant>,
    ) => ReadonlyArray<OutsideWorkspaceEditGrant>,
  ) =>
    Option.isNone(serverSettings)
      ? Effect.die(new Error("Outside edit grants need server settings."))
      : grantUpdates.withPermits(1)(
          serverSettings.value.getSettings.pipe(
            Effect.flatMap((settings) =>
              serverSettings.value.updateSettings({
                outsideWorkspaceEditGrants: update(settings.outsideWorkspaceEditGrants),
              }),
            ),
            Effect.orDie,
          ),
        );

  /**
   * Replaces a host file via a temp file in its folder (in place when the folder is read-only).
   * The file must stay the single-link regular file at `realPath`, in the same folder, until the
   * write. Node lacks `renameat`, so a swap between the last check and the rename stays possible.
   */
  const writeHostFile = Effect.fn("WorkspaceFileSystem.writeHostFile")(function* (
    input: ProjectWriteFileInput,
    realPath: string,
  ) {
    yield* Effect.tryPromise({
      try: async () => {
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
              throw new Error("The file changed or is not a single regular file.");
            }
          };
          await unchanged();
          const mode = opened.mode & 0o7777;
          const folder = path.dirname(realPath);
          const folderBefore = await NodeFSP.stat(folder);
          const name = path.join(
            folder,
            `.${path.basename(realPath)}.${NodeCrypto.randomUUID()}.t3-save`,
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
                throw new Error("The file changed or is not a single regular file.");
              }
              await inPlace.truncate(0);
              await inPlace.writeFile(input.contents);
              await inPlace.sync();
            } finally {
              await inPlace.close();
            }
            return;
          }
          temp = name;
          let written: NodeFS.Stats;
          try {
            await output.writeFile(input.contents);
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
      },
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: realPath,
          operationPath: realPath,
          operation: "write-file",
          cause,
        }),
    });
  });
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const toHostPath = (requestedPath: string) =>
    toWslDrivePath(requestedPath).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

  const metadataForPath = Effect.fnUntraced(function* (requestedPath: string) {
    const expandedPath = expandHomePath(
      yield* toHostPath(requestedPath),
      yield* HostProcess.HomeDirectory,
    );
    // Chips ask as soon as an agent's message renders, and touching a network
    // path makes Windows sign in to its host with the user's NTLM credentials.
    if (!path.isAbsolute(expandedPath) || isNetworkPath(expandedPath)) return null;
    const stat = yield* fileSystem.stat(expandedPath).pipe(Effect.option);
    // Server state files answer like missing paths, as readFile refuses them.
    if (stat._tag === "None" || (yield* isServerInternalPath(expandedPath))) return null;
    if (stat.value.type === "Directory") return { kind: "directory" } as const;
    if (stat.value.type !== "File") return { kind: "other" } as const;
    let mimeType: string | undefined;
    if (path.extname(expandedPath) === "" && stat.value.size > 0) {
      mimeType = yield* Effect.tryPromise({
        try: async () => {
          const handle = await NodeFSP.open(
            expandedPath,
            NodeFS.constants.O_RDONLY | NodeFS.constants.O_NONBLOCK,
          );
          try {
            if (!(await handle.stat()).isFile()) return undefined;
            const buffer = Buffer.alloc(512);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            return fileHeaderMimeType(buffer.subarray(0, bytesRead));
          } finally {
            await handle.close();
          }
        },
        catch: () => undefined,
      }).pipe(Effect.orElseSucceed(() => undefined));
    }
    return {
      kind: "file",
      byteLength: Number(stat.value.size),
      ...(mimeType === undefined ? {} : { mimeType }),
    } satisfies FilesystemEntryMetadata;
  });

  const getMetadata: WorkspaceFileSystem["Service"]["getMetadata"] = Effect.fn(
    "WorkspaceFileSystem.getMetadata",
  )(function* (input) {
    const paths = [...new Set(input.paths)];
    const entries = yield* Effect.forEach(paths, metadataForPath, { concurrency: 8 });
    const byPath = new Map(paths.map((value, index) => [value, entries[index] ?? null]));
    return { entries: input.paths.map((value) => byPath.get(value) ?? null) };
  });

  /** Both paths must already be real paths. */
  const isInsideRealRoot = (realWorkspaceRoot: string, realPath: string) => {
    const relative = path.relative(realWorkspaceRoot, realPath);
    return !(
      relative.startsWith(`..${path.sep}`) ||
      relative === ".." ||
      path.isAbsolute(relative)
    );
  };

  // Reject Git folders, including renamed bare repos whose config/hooks can execute; paths must be normalized.
  // Stop at linked worktrees' .git files since worktrees can sit inside bare repos.
  const isInGitFolder = async (absolutePath: string) => {
    if (absolutePath.split(path.sep).some(isGitMetadataName)) return true;
    for (let folder = path.dirname(absolutePath); ; folder = path.dirname(folder)) {
      const [head, commondir, objects, refs, dotGit] = await Promise.all(
        ["HEAD", "commondir", "objects", "refs", ".git"].map((name) =>
          NodeFSP.lstat(path.join(folder, name)).catch((error: NodeJS.ErrnoException) => {
            // Any other failure leaves the folder unknown, so the write is refused.
            if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
            throw error;
          }),
        ),
      );
      // Git recognizes HEAD with commondir or objects/refs as a repository.
      if (head && (commondir || (objects && refs))) return true;
      if (dotGit?.isFile() || path.dirname(folder) === folder) return false;
    }
  };

  /**
   * Workspace-relative paths must stay inside the root, symlinks included. An
   * absolute or `~/` path reads a host file in place, such as a report an agent
   * wrote to a temp directory; it gets no root check. A network path does, since
   * Windows signs in to its host with the user's NTLM credentials.
   */
  const resolveReadTarget = Effect.fn("WorkspaceFileSystem.resolveReadTarget")(function* (
    input: ProjectReadFileInput,
  ) {
    const requestedPath = input.relativePath;
    const hostPath =
      requestedPath.startsWith("~/") || requestedPath.startsWith("~\\")
        ? expandHomePath(requestedPath, yield* HostProcess.HomeDirectory)
        : yield* toHostPath(requestedPath);
    if (
      isNetworkPath(hostPath) &&
      !KnownWorkspaces.isWithinRoot(path, path.resolve(hostPath), path.resolve(input.cwd))
    ) {
      return yield* new WorkspacePaths.WorkspacePathOutsideRootError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
      });
    }
    if (path.isAbsolute(hostPath)) {
      // Native realpath hands Windows a `\\?\` path as written, `..` included,
      // so a network path must be the resolved one the check above approved.
      // Others keep POSIX `link/..` semantics, which resolving first would change.
      const absolutePath = isNetworkPath(hostPath) ? path.resolve(hostPath) : hostPath;
      const realTargetPath = yield* Effect.tryPromise({
        try: () => NodeFSP.realpath(absolutePath),
        catch: (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: absolutePath,
            operationPath: absolutePath,
            operation: "realpath-target",
            cause,
          }),
      }).pipe(
        Effect.catchIf(
          (error) =>
            input.allowMissing === true && (error.cause as NodeJS.ErrnoException).code === "ENOENT",
          () => Effect.succeed(null),
        ),
      );
      return { relativePath: requestedPath, realTargetPath };
    }

    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });

    const realWorkspaceRoot = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(path.resolve(input.cwd)),
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: target.absolutePath,
          operationPath: input.cwd,
          operation: "realpath-workspace-root",
          cause,
        }),
    });
    const resolved = yield* Effect.tryPromise({
      try: async () => {
        let candidate = target.absolutePath;
        for (;;) {
          try {
            return {
              realTargetPath: path.join(
                await NodeFSP.realpath(candidate),
                path.relative(candidate, target.absolutePath),
              ),
              exists: candidate === target.absolutePath,
            };
          } catch (error) {
            if (!input.allowMissing || (error as NodeJS.ErrnoException).code !== "ENOENT") {
              throw error;
            }
            // Like writes, missing reads must check the nearest existing ancestor.
            // An existing entry that cannot resolve is a dangling link, not absence.
            const exists = await NodeFSP.lstat(candidate).then(
              () => true,
              (cause: NodeJS.ErrnoException) => {
                if (cause.code !== "ENOENT") throw cause;
                return false;
              },
            );
            if (exists || path.dirname(candidate) === candidate) throw error;
            candidate = path.dirname(candidate);
          }
        }
      },
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: target.absolutePath,
          operationPath: target.absolutePath,
          operation: "realpath-target",
          cause,
        }),
    });
    if (!isInsideRealRoot(realWorkspaceRoot, resolved.realTargetPath)) {
      return yield* new WorkspaceFilePathEscapeError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedWorkspaceRoot: realWorkspaceRoot,
        resolvedPath: resolved.realTargetPath,
      });
    }
    return {
      relativePath: target.relativePath,
      realTargetPath: resolved.exists ? resolved.realTargetPath : null,
    };
  });

  const readFile: WorkspaceFileSystem["Service"]["readFile"] = Effect.fn(
    "WorkspaceFileSystem.readFile",
  )(function* (input, options) {
    const target = yield* resolveReadTarget(input);
    const absentResult = {
      relativePath: target.relativePath,
      contents: "",
      byteLength: 0,
      truncated: false,
      exists: false,
    };
    const realTargetPath = target.realTargetPath;
    if (realTargetPath === null) return absentResult;
    if (yield* isServerInternalPath(realTargetPath)) {
      return yield* new WorkspacePaths.WorkspacePathOutsideRootError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
      });
    }

    const result = yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        // Non-blocking opens prevent FIFO hangs before stat rejects them; Windows lacks the flag.
        try: () =>
          NodeFSP.open(
            realTargetPath,
            NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NONBLOCK ?? 0),
          ),
        catch: (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: realTargetPath,
            operationPath: realTargetPath,
            operation: "open",
            cause,
          }),
      }).pipe(
        Effect.catchIf(
          (error) =>
            input.allowMissing === true && (error.cause as NodeJS.ErrnoException).code === "ENOENT",
          () => Effect.succeed(null),
        ),
      ),
      (handle) =>
        Effect.gen(function* () {
          if (handle === null) return absentResult;
          const stat = yield* Effect.tryPromise({
            try: () => handle.stat(),
            catch: (cause) =>
              new WorkspaceFileSystemOperationError({
                workspaceRoot: input.cwd,
                relativePath: input.relativePath,
                resolvedPath: realTargetPath,
                operationPath: realTargetPath,
                operation: "stat",
                cause,
              }),
          });
          if (!stat.isFile()) {
            return yield* new WorkspacePathNotFileError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: realTargetPath,
            });
          }

          const bytesToRead = Math.min(stat.size, PROJECT_READ_FILE_MAX_BYTES);
          const buffer = Buffer.alloc(bytesToRead);
          let offset = 0;
          while (offset < bytesToRead) {
            const { bytesRead } = yield* Effect.tryPromise({
              try: () => handle.read(buffer, offset, bytesToRead - offset, offset),
              catch: (cause) =>
                new WorkspaceFileSystemOperationError({
                  workspaceRoot: input.cwd,
                  relativePath: input.relativePath,
                  resolvedPath: realTargetPath,
                  operationPath: realTargetPath,
                  operation: "read",
                  cause,
                }),
            });
            if (bytesRead <= 0) break;
            offset += bytesRead;
          }
          const fileBytes = buffer.subarray(0, offset);
          const truncated = stat.size > PROJECT_READ_FILE_MAX_BYTES;
          const binaryFileError = () =>
            new WorkspaceBinaryFileError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: realTargetPath,
            });
          if (fileBytes.includes(0)) return yield* binaryFileError();
          // Fatal decoding rejects invalid UTF-8, since U+FFFD contents would corrupt the file on save.
          // Streaming decode drops a character the byte limit split, instead of rejecting it.
          const contents = yield* Effect.try({
            try: () =>
              new TextDecoder("utf-8", { fatal: true }).decode(fileBytes, { stream: truncated }),
            catch: binaryFileError,
          });
          return { relativePath: target.relativePath, contents, byteLength: stat.size, truncated };
        }),
      (handle) =>
        handle === null
          ? Effect.void
          : Effect.tryPromise({
              try: () => handle.close(),
              catch: (cause) =>
                new WorkspaceFileSystemOperationError({
                  workspaceRoot: input.cwd,
                  relativePath: input.relativePath,
                  resolvedPath: realTargetPath,
                  operationPath: realTargetPath,
                  operation: "close",
                  cause,
                }),
            }),
    );
    if ("exists" in result || !isHostPath(input.relativePath)) return result;
    const access = yield* hostEditAccess(
      input.cwd,
      input.relativePath,
      options?.grantedEdits === true,
    );
    if (access === null || access.realPath !== realTargetPath) return result;
    if (access.grant === null) return { ...result, canGrantEdit: true };
    return access.grant === "allowlist"
      ? { ...result, writable: true }
      : { ...result, writable: true, editGrant: access.grant };
  });

  // Resolve existing ancestors and reject dangling links so creation cannot follow symlinks outside root.
  const resolveWriteTarget = Effect.fn("WorkspaceFileSystem.resolveWriteTarget")(function* (
    input: ProjectWriteFileInput,
  ) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });
    const realWorkspaceRoot = yield* Effect.tryPromise({
      // Resolve `..` in cwd the way the relative path was resolved, before following links.
      try: () => NodeFSP.realpath(path.resolve(input.cwd)),
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: target.absolutePath,
          operationPath: input.cwd,
          operation: "realpath-workspace-root",
          cause,
        }),
    });

    // Split the host path, not the display relativePath: on POSIX `\` is a file name character.
    const segments = path.relative(input.cwd, target.absolutePath).split(path.sep);
    const realTargetPath = yield* Effect.tryPromise({
      try: async () => {
        for (let depth = segments.length; depth > 0; depth--) {
          const candidate = path.join(realWorkspaceRoot, ...segments.slice(0, depth));
          try {
            return path.join(await NodeFSP.realpath(candidate), ...segments.slice(depth));
          } catch (error) {
            // Only a missing entry is skipped; one that exists but cannot resolve is a dangling link.
            const exists = await NodeFSP.lstat(candidate).then(
              () => true,
              () => false,
            );
            if ((error as NodeJS.ErrnoException).code !== "ENOENT" || exists) throw error;
          }
        }
        return path.join(realWorkspaceRoot, ...segments);
      },
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: target.absolutePath,
          operationPath: target.absolutePath,
          operation: "realpath-target",
          cause,
        }),
    });
    // The path as named is checked too: a `.git/config` symlink resolves away the `.git`.
    const namedTargetPath = path.join(realWorkspaceRoot, ...segments);
    const inGitFolder = Effect.fn("WorkspaceFileSystem.inGitFolder")((checkedPath: string) =>
      Effect.tryPromise({
        try: () => isInGitFolder(checkedPath),
        catch: (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: realTargetPath,
            operationPath: checkedPath,
            operation: "stat",
            cause,
          }),
      }),
    );
    if (
      !isInsideRealRoot(realWorkspaceRoot, realTargetPath) ||
      (yield* inGitFolder(realTargetPath)) ||
      (yield* inGitFolder(namedTargetPath))
    ) {
      return yield* new WorkspaceFilePathEscapeError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedWorkspaceRoot: realWorkspaceRoot,
        resolvedPath: realTargetPath,
      });
    }
    return { relativePath: target.relativePath, realTargetPath };
  });

  const writeFile: WorkspaceFileSystem["Service"]["writeFile"] = Effect.fn(
    "WorkspaceFileSystem.writeFile",
  )(function* (input, options) {
    yield* knownWorkspaces.assertContains(input.cwd);
    if (isHostPath(input.relativePath)) {
      const realPath = yield* editableHostPath(
        input.cwd,
        input.relativePath,
        options?.grantedEdits === true,
      );
      if (realPath === null) {
        return yield* new WorkspacePaths.WorkspacePathOutsideRootError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
        });
      }
      yield* writeHostFile(input, realPath);
      return { relativePath: input.relativePath };
    }
    const target = yield* resolveWriteTarget(input);
    const realTargetPath = target.realTargetPath;
    const replacesFile = yield* fileSystem
      .exists(realTargetPath)
      .pipe(Effect.orElseSucceed(() => false));
    // readFile decodes the BOM away, so an editor save would otherwise drop it from the file.
    const keepsBom =
      replacesFile &&
      !input.contents.startsWith(UTF8_BOM) &&
      (yield* Effect.promise(() => startsWithUtf8Bom(realTargetPath)));
    const contents = keepsBom ? UTF8_BOM + input.contents : input.contents;

    yield* fileSystem.makeDirectory(path.dirname(realTargetPath), { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: realTargetPath,
            operationPath: path.dirname(realTargetPath),
            operation: "make-directory",
            cause,
          }),
      ),
    );
    yield* Effect.tryPromise({
      // A symlink swapped in after the check is not followed. Windows lacks O_NOFOLLOW.
      try: () =>
        NodeFSP.writeFile(realTargetPath, contents, {
          flag:
            NodeFS.constants.O_WRONLY |
            NodeFS.constants.O_CREAT |
            NodeFS.constants.O_TRUNC |
            (NodeFS.constants.O_NOFOLLOW ?? 0),
        }),
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: realTargetPath,
          operationPath: realTargetPath,
          operation: "write-file",
          cause,
        }),
    });
    // Editor autosave overwrites existing files, which leaves the indexed paths unchanged, and
    // fff's watcher applies the new contents on its own. A forced rescan re-walks the whole
    // workspace, and the save would wait for it.
    if (!replacesFile) {
      yield* workspaceEntries.refresh(input.cwd);
    }
    return { relativePath: target.relativePath };
  });

  const allowOutsideEdits: WorkspaceFileSystem["Service"]["allowOutsideEdits"] = Effect.fn(
    "WorkspaceFileSystem.allowOutsideEdits",
  )(function* (input) {
    yield* knownWorkspaces.assertContains(input.cwd);
    // The RPC already requires the scopes that let grants apply.
    const access = yield* hostEditAccess(input.cwd, input.relativePath, true);
    if (access === null) {
      return yield* new WorkspacePaths.WorkspacePathOutsideRootError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
      });
    }
    const grantPath = input.scope === "file" ? access.realPath : access.workspaceRoot;
    const grant: OutsideWorkspaceEditGrant = { kind: input.scope, path: grantPath };
    yield* updateOutsideEditGrants((grants) =>
      grants.some((entry) => entry.kind === grant.kind && entry.path === grant.path)
        ? grants
        : [...grants, grant],
    );
    return grant;
  });

  const revokeOutsideEdits: WorkspaceFileSystem["Service"]["revokeOutsideEdits"] = Effect.fn(
    "WorkspaceFileSystem.revokeOutsideEdits",
  )(function* ({ grant }) {
    yield* updateOutsideEditGrants((grants) =>
      grants.filter((entry) => entry.kind !== grant.kind || entry.path !== grant.path),
    );
  });

  return WorkspaceFileSystem.of({
    getMetadata,
    readFile,
    writeFile,
    allowOutsideEdits,
    revokeOutsideEdits,
  });
});

export const layer = Layer.effect(WorkspaceFileSystem, make);
