// @effect-diagnostics nodeBuiltinImport:off - FileSystem cannot create a FIFO, and reads spy on native realpath.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";

import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import type { OutsideWorkspaceEditGrant } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as InstructionFileAllowlist from "../threadInsights/InstructionFileAllowlist.ts";
import { makeFakeWslHost } from "../testUtils/fakeWsl.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as KnownWorkspaces from "./KnownWorkspaces.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./WorkspaceFileSystem.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import { vi } from "vite-plus/test";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFSP>();
  return { ...actual, realpath: vi.fn(actual.realpath), open: vi.fn(actual.open) };
});

const injectShortReads = Effect.fn("injectShortReads")(function* (target: string) {
  const native = yield* Effect.promise(() => vi.importActual<typeof NodeFSP>("node:fs/promises"));
  const open = vi.mocked(NodeFSP.open).mockImplementation(async (path, flags, mode) => {
    const handle = await native.open(path, flags, mode);
    if (path === target) {
      const read = handle.read.bind(handle);
      Object.defineProperty(handle, "read", {
        value: (buffer: Uint8Array, offset: number, length: number, position: number) =>
          read(buffer, offset, Math.min(length, 2), position),
      });
    }
    return handle;
  });
  yield* Effect.addFinalizer(() => Effect.sync(() => open.mockImplementation(native.open)));
});

const whitespaceFilePaths =
  HostProcess.Platform.defaultValue() === "win32"
    ? [" report.txt"]
    : [" report.txt", "report.txt ", "\treport.txt\t", " "];

const UNKNOWN_WORKSPACE_PREFIX = "t3code-unknown-workspace-";
const layerKnownWorkspacesTest = Layer.mock(KnownWorkspaces.KnownWorkspaces)({
  assertContains: (cwd) =>
    cwd.includes(UNKNOWN_WORKSPACE_PREFIX)
      ? Effect.fail(new KnownWorkspaces.UnknownWorkspaceError({ cwd }))
      : Effect.void,
});

const layerProject = WorkspaceFileSystem.layer.pipe(
  Layer.provide(layerKnownWorkspacesTest),
  Layer.provide(WorkspacePaths.layer),
  Layer.provide(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
);

const layerTest = Layer.empty.pipe(
  Layer.provideMerge(layerProject),
  Layer.provideMerge(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
  Layer.provideMerge(
    ServerConfig.ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-workspace-files-test-",
    }),
  ),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3code-workspace-files-",
  });
});

const writeTextFile = Effect.fn("writeTextFile")(function* (
  cwd: string,
  relativePath: string,
  contents = "",
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(cwd, relativePath);
  yield* fileSystem
    .makeDirectory(path.dirname(absolutePath), { recursive: true })
    .pipe(Effect.orDie);
  yield* fileSystem.writeFileString(absolutePath, contents).pipe(Effect.orDie);
});

const makeWslHost = Effect.gen(function* () {
  const { mountRoot, underWsl } = yield* makeFakeWslHost;
  const service = yield* underWsl(
    WorkspaceFileSystem.make.pipe(Effect.provide(layerKnownWorkspacesTest)),
  );
  return { mountRoot, service, underWsl };
});

it.layer(layerTest, { excludeTestServices: true })("WorkspaceFileSystemLive", (it) => {
  describe("getMetadata", () => {
    it.effect(
      "reports actual kinds for extensionless files, dotfiles, and dotted directories",
      () =>
        Effect.gen(function* () {
          const service = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const cwd = yield* makeTempDir;
          yield* writeTextFile(cwd, "custom-name", "hello");
          yield* writeTextFile(cwd, ".npmrc", "registry=test");
          yield* fs.makeDirectory(path.join(cwd, "folder.ts"));
          const file = path.join(cwd, "custom-name");
          const result = yield* service.getMetadata({
            paths: [
              file,
              path.join(cwd, ".npmrc"),
              path.join(cwd, "folder.ts"),
              file,
              path.join(cwd, "missing"),
              "relative-path",
            ],
          });
          expect(result.entries).toEqual([
            { kind: "file", byteLength: 5 },
            { kind: "file", byteLength: 13 },
            { kind: "directory" },
            { kind: "file", byteLength: 5 },
            null,
            null,
          ]);
        }),
    );

    it.effect("detects an extensionless script and image without returning their contents", () =>
      Effect.gen(function* () {
        const service = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const script = "#!/usr/bin/env python3\nprint('hello')\n";
        yield* writeTextFile(cwd, "run", script);
        const image = path.join(cwd, "image");
        yield* fs.writeFile(
          image,
          new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        );
        expect(
          (yield* service.getMetadata({ paths: [path.join(cwd, "run"), image] })).entries,
        ).toEqual([
          { kind: "file", byteLength: script.length, mimeType: "text/x-python" },
          { kind: "file", byteLength: 8, mimeType: "image/png" },
        ]);
      }),
    );

    // A file chip for `file://attacker.test/s/a.ts` in an agent's message sent
    // the Windows user's NTLM credentials to attacker.test as it rendered.
    it.effect("never stats a network path", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const statted: Array<string> = [];
        const service = yield* WorkspaceFileSystem.make.pipe(
          Effect.provideService(
            FileSystem.FileSystem,
            FileSystem.FileSystem.of({
              ...fs,
              stat: (requestedPath) => {
                statted.push(requestedPath);
                return fs.stat(requestedPath);
              },
            }),
          ),
          Effect.provide(layerKnownWorkspacesTest),
        );
        const paths = [
          "\\\\attacker.test\\s\\a.ts",
          "//attacker.test/s/a.ts",
          "/\\attacker.test\\s",
        ];
        expect((yield* service.getMetadata({ paths })).entries).toEqual([null, null, null]);
        expect(statted).toEqual([]);
      }),
    );

    it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
      "reports a Windows drive path under WSL as the file it maps to",
      () =>
        Effect.gen(function* () {
          const { mountRoot, service, underWsl } = yield* makeWslHost;
          yield* writeTextFile(mountRoot, "c/Users/me/Documents/notes.md", "# Notes\n");

          const { entries } = yield* underWsl(
            service.getMetadata({
              paths: [
                "C:\\Users\\me\\Documents\\notes.md",
                "C:/Users/me/Documents/notes.md",
                "C:/Users/me/Documents/notes\u0000.md",
              ],
            }),
          );

          expect(entries).toEqual([
            { kind: "file", byteLength: 8 },
            { kind: "file", byteLength: 8 },
            null,
          ]);
        }),
    );
  });

  describe("readFile", () => {
    it.effect("reads UTF-8 files relative to the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/index.ts", "export const answer = 42;\n");

        const result = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "src/index.ts",
        });

        expect(result).toEqual({
          relativePath: "src/index.ts",
          contents: "export const answer = 42;\n",
          byteLength: 26,
          truncated: false,
        });

        const bomContents = "\uFEFFexport const answer = 42;\n";
        yield* writeTextFile(cwd, "bom.ts", bomContents);
        const bomRead = yield* workspaceFileSystem.readFile({ cwd, relativePath: "bom.ts" });
        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "bom.ts",
          contents: bomRead.contents.replace("42", "43"),
        });
        const fs = yield* FileSystem.FileSystem;
        const saved = yield* fs.readFile(`${cwd}/bom.ts`);
        expect([...saved]).toEqual([...new TextEncoder().encode(bomContents.replace("42", "43"))]);

        yield* writeTextFile(cwd, "report.txt", "ordinary file");
        for (const relativePath of whitespaceFilePaths) {
          yield* writeTextFile(cwd, relativePath, "whitespace file");
          const read = yield* workspaceFileSystem.readFile({ cwd, relativePath });
          expect(read.contents).toBe("whitespace file");
          expect(read.relativePath).toBe(relativePath);
        }
      }),
    );

    it.effect("finishes short reads before decoding UTF-8 text", () =>
      Effect.gen(function* () {
        const files = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* makeTempDir;
        const contents = "A café 🐈\n";
        yield* writeTextFile(cwd, "short.txt", contents);
        const target = yield* fs.realPath(`${cwd}/short.txt`);
        yield* injectShortReads(target);
        expect(yield* files.readFile({ cwd, relativePath: "short.txt" })).toEqual({
          relativePath: "short.txt",
          contents,
          byteLength: Buffer.byteLength(contents),
          truncated: false,
        });
      }),
    );

    it.effect("rejects binary bytes delivered after an initial short read", () =>
      Effect.gen(function* () {
        const files = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "short.txt", "ab\0cd");
        const target = yield* fs.realPath(`${cwd}/short.txt`);
        yield* injectShortReads(target);
        const error = yield* files.readFile({ cwd, relativePath: "short.txt" }).pipe(Effect.flip);
        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceBinaryFileError);
      }),
    );

    it.effect("reads host files outside the workspace root by absolute path", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const outsideDir = yield* makeTempDir;
        yield* writeTextFile(outsideDir, "cleanup-report.md", "# Report\n");
        const absolutePath = path.join(outsideDir, "cleanup-report.md");

        const result = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: absolutePath,
        });

        expect(result).toEqual({
          relativePath: absolutePath,
          contents: "# Report\n",
          byteLength: 9,
          truncated: false,
        });

        for (const relativePath of whitespaceFilePaths) {
          yield* writeTextFile(outsideDir, relativePath, "whitespace file");
          const requestedPath = path.join(outsideDir, relativePath);
          const read = yield* workspaceFileSystem.readFile({ cwd, relativePath: requestedPath });
          expect(read.contents).toBe("whitespace file");
          expect(read.relativePath).toBe(requestedPath);
        }
      }),
    );

    it.effect.each(["~/.claude/CLAUDE.md", "~\\.claude/CLAUDE.md"])(
      "reads %s from the server home outside the workspace",
      (relativePath) =>
        Effect.gen(function* () {
          const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const cwd = yield* makeTempDir;
          const home = yield* makeTempDir;
          yield* writeTextFile(home, ".claude/CLAUDE.md", "# Notes\n");
          yield* writeTextFile(cwd, "~/.claude/CLAUDE.md", "Workspace decoy\n");

          const result = yield* workspaceFileSystem
            .readFile({ cwd, relativePath })
            .pipe(Effect.provideService(HostProcess.HomeDirectory, home));

          expect(result).toEqual({
            relativePath,
            contents: "# Notes\n",
            byteLength: 8,
            truncated: false,
          });
        }),
    );

    it.effect("does not read server state files", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const config = yield* ServerConfig.ServerConfig;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(config.secretsDir, "example.bin", "example\n");
        yield* writeTextFile(config.stateDir, "statev2.sqlite", "example\n");

        for (const input of [
          { cwd, relativePath: path.join(config.secretsDir, "example.bin") },
          { cwd: config.stateDir, relativePath: "statev2.sqlite" },
        ]) {
          const error = yield* workspaceFileSystem.readFile(input).pipe(Effect.flip);
          expect(error).toBeInstanceOf(WorkspacePaths.WorkspacePathOutsideRootError);
        }
        const metadata = yield* workspaceFileSystem.getMetadata({
          paths: [
            path.join(config.secretsDir, "example.bin"),
            path.join(config.stateDir, "statev2.sqlite"),
            config.stateDir,
          ],
        });
        expect(metadata.entries).toEqual([null, null, { kind: "directory" }]);
      }),
    );

    it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
      "rejects a FIFO without blocking on open",
      () =>
        Effect.gen(function* () {
          const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const path = yield* Path.Path;
          const cwd = yield* makeTempDir;
          const outsideDir = yield* makeTempDir;
          const fifoPath = path.join(outsideDir, "pipe");
          yield* Effect.promise(
            () =>
              new Promise<void>((resolve, reject) =>
                NodeChildProcess.execFile("mkfifo", [fifoPath], (error) =>
                  error ? reject(error) : resolve(),
                ),
              ),
          );

          const error = yield* workspaceFileSystem
            .readFile({ cwd, relativePath: fifoPath })
            .pipe(Effect.flip);

          expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspacePathNotFileError);
          expect((yield* workspaceFileSystem.getMetadata({ paths: [fifoPath] })).entries).toEqual([
            { kind: "other" },
          ]);
        }),
    );

    it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
      "reads a Windows drive path under WSL from where wslpath mounts it",
      () =>
        Effect.gen(function* () {
          const { mountRoot, service, underWsl } = yield* makeWslHost;
          const cwd = yield* makeTempDir;
          yield* writeTextFile(mountRoot, "c/Users/me/Documents/notes.md", "# Notes\n");

          for (const relativePath of [
            "C:\\Users\\me\\Documents\\notes.md",
            "C:/Users/me/Documents/notes.md",
          ]) {
            const result = yield* underWsl(service.readFile({ cwd, relativePath }));
            expect(result).toMatchObject({ contents: "# Notes\n", truncated: false });
          }
        }),
    );

    it.effect("refuses a network path outside the workspace", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;

        const error = yield* workspaceFileSystem
          .readFile({ cwd: "//nas.test/share/project", relativePath: "//attacker.test/s/a.md" })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspacePaths.WorkspacePathOutsideRootError);
      }),
    );

    // This resolves inside the project, but Windows reads `\\?\` paths as
    // written, so realpath on the raw string signed in to attacker.test.
    it.effect("reads the network path it checked", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.make.pipe(
          Effect.provide(Layer.merge(layerKnownWorkspacesTest, NodePath.layerWin32)),
        );
        // Rejects without touching the filesystem, so a Windows runner never looks the share up.
        const realpath = vi
          .mocked(NodeFSP.realpath)
          .mockClear()
          .mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));

        yield* workspaceFileSystem
          .readFile({
            cwd: "\\\\?\\UNC\\nas.test\\share\\project",
            relativePath: "\\\\?\\UNC\\attacker.test\\s\\..\\..\\nas.test\\share\\project\\a.md",
          })
          .pipe(Effect.exit);

        expect(realpath.mock.calls.map(([target]) => target)).toEqual([
          "\\\\?\\UNC\\nas.test\\share\\project\\a.md",
        ]);
      }),
    );

    // Resolving `..` before realpath would read beside the link instead of its target.
    // Windows collapses `..` before the filesystem sees a path, so it has no such reads.
    it.effect.skipIf(!symlinksSupported || HostProcess.Platform.defaultValue() === "win32")(
      "reads `..` after a link from the link's target",
      () =>
        Effect.gen(function* () {
          const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* makeTempDir;
          yield* writeTextFile(root, "target/parent.md", "beside the target\n");
          yield* writeTextFile(root, "parent.md", "beside the link\n");
          yield* fs.makeDirectory(path.join(root, "target", "child"));
          yield* fs.symlink(path.join(root, "target", "child"), path.join(root, "link"));

          const result = yield* workspaceFileSystem.readFile({
            cwd: root,
            relativePath: `${root}/link/../parent.md`,
          });

          expect(result.contents).toBe("beside the target\n");
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "rejects symlinks that resolve outside the workspace root",
      () =>
        Effect.gen(function* () {
          const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const cwd = yield* makeTempDir;
          const outsideDir = yield* makeTempDir;
          yield* writeTextFile(outsideDir, "secret.txt", "outside\n");
          yield* fileSystem.symlink(
            path.join(outsideDir, "secret.txt"),
            path.join(cwd, "linked-secret.txt"),
          );

          const error = yield* workspaceFileSystem
            .readFile({ cwd, relativePath: "linked-secret.txt" })
            .pipe(Effect.flip);
          const resolvedWorkspaceRoot = yield* fileSystem.realPath(cwd);
          const resolvedPath = yield* fileSystem.realPath(path.join(outsideDir, "secret.txt"));

          expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFilePathEscapeError);
          expect(error).toMatchObject({
            workspaceRoot: cwd,
            relativePath: "linked-secret.txt",
            resolvedWorkspaceRoot,
            resolvedPath,
          });
          expect("cause" in error).toBe(false);

          yield* fileSystem.symlink(outsideDir, path.join(cwd, "linked-dir"));
          const missingChildError = yield* workspaceFileSystem
            .readFile(
              Object.assign(
                { cwd, relativePath: "linked-dir/missing/t3.json" },
                { allowMissing: true },
              ),
            )
            .pipe(Effect.flip);
          expect(missingChildError).toBeInstanceOf(
            WorkspaceFileSystem.WorkspaceFilePathEscapeError,
          );
        }),
    );

    it.effect("drops a multibyte character split by the read limit", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const limit = 1024 * 1024;
        const euro = new TextEncoder().encode("€");
        const bytes = new Uint8Array(limit - 1 + euro.length).fill(0x61);
        bytes.set(euro, limit - 1);
        yield* fileSystem.writeFile(path.join(cwd, "large.txt"), bytes);

        const result = yield* workspaceFileSystem.readFile({ cwd, relativePath: "large.txt" });

        expect(result.truncated).toBe(true);
        expect(result.byteLength).toBe(bytes.length);
        expect(result.contents).toBe("a".repeat(limit - 1));
      }),
    );

    it.effect.each([
      { name: "a NUL byte", bytes: [0x61, 0, 0x62] },
      { name: "invalid UTF-8", bytes: [0x63, 0x61, 0x66, 0xe9] },
    ])("rejects files with $name without leaking their contents", ({ bytes }) =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const absolutePath = path.join(cwd, "asset.bin");
        yield* fileSystem.writeFile(absolutePath, Uint8Array.from(bytes));

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "asset.bin" })
          .pipe(Effect.flip);
        const resolvedPath = yield* fileSystem.realPath(absolutePath);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceBinaryFileError);
        expect(error).toMatchObject({
          workspaceRoot: cwd,
          relativePath: "asset.bin",
          resolvedPath,
        });
        expect("cause" in error).toBe(false);
        expect("contents" in error).toBe(false);
      }),
    );
  });

  describe("writeFile", () => {
    it.effect("rejects writes outside a known workspace", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({
          prefix: UNKNOWN_WORKSPACE_PREFIX,
        });

        const error = yield* workspaceFileSystem
          .writeFile({ cwd, relativePath: "plan.md", contents: "# nope\n" })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(KnownWorkspaces.UnknownWorkspaceError);
        expect(yield* fileSystem.readDirectory(cwd)).toEqual([]);
      }),
    );

    it.effect("rejects writes by absolute path", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const outsideDir = yield* makeTempDir;
        const absolutePath = path.join(outsideDir, "cleanup-report.md");

        const error = yield* workspaceFileSystem
          .writeFile({ cwd, relativePath: absolutePath, contents: "# Edited\n" })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspacePaths.WorkspacePathOutsideRootError);
      }),
    );

    it.effect("invalidates workspace entry search cache after writes", () =>
      Effect.gen(function* () {
        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/existing.ts", "export {};\n");

        const beforeWrite = yield* workspaceEntries.list({ cwd });
        expect(beforeWrite.entries.some((entry) => entry.path === "plans/effect-rpc.md")).toBe(
          false,
        );

        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "plans/effect-rpc.md",
          contents: "# Plan\n",
        });

        const afterWrite = yield* workspaceEntries.list({ cwd });
        expect(afterWrite.entries).toEqual(
          expect.arrayContaining([expect.objectContaining({ path: "plans/effect-rpc.md" })]),
        );
        expect(afterWrite.truncated).toBe(false);
      }),
    );

    it.effect("saves over an existing file without rescanning the workspace", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/main.ts", "export {};\n");

        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "src/main.ts",
          contents: "export const edited = true;\n",
        });

        expect(yield* fileSystem.readFileString(path.join(cwd, "src/main.ts"))).toBe(
          "export const edited = true;\n",
        );

        yield* writeTextFile(cwd, "report.txt", "ordinary file");
        for (const relativePath of whitespaceFilePaths) {
          yield* writeTextFile(cwd, relativePath, "whitespace file");
          const written = yield* workspaceFileSystem.writeFile({
            cwd,
            relativePath,
            contents: "edited",
          });
          expect(yield* fileSystem.readFileString(path.join(cwd, "report.txt"))).toBe(
            "ordinary file",
          );
          expect(yield* fileSystem.readFileString(path.join(cwd, relativePath))).toBe("edited");
          expect(written.relativePath).toBe(relativePath);
        }
      }).pipe(
        Effect.provide(
          Layer.fresh(WorkspaceFileSystem.layer).pipe(
            Layer.provide(layerKnownWorkspacesTest),
            Layer.provide(WorkspacePaths.layer),
            Layer.provide(
              Layer.mock(WorkspaceEntries.WorkspaceEntries)({
                refresh: () => Effect.die("An overwrite rescanned the workspace."),
              }),
            ),
          ),
        ),
      ),
    );

    it.effect("rejects writes outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;

        for (const relativePath of ["../escape.md", "../escape.md ", " folder/../../escape.md"]) {
          const error = yield* workspaceFileSystem
            .writeFile({ cwd, relativePath, contents: "# nope\n" })
            .pipe(Effect.flip);

          expect(error).toBeInstanceOf(WorkspacePaths.WorkspacePathOutsideRootError);
        }

        const escapedPath = path.resolve(cwd, "..", "escape.md");
        const escapedStat = yield* fileSystem
          .stat(escapedPath)
          .pipe(Effect.orElseSucceed(() => null));
        expect(escapedStat).toBeNull();
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "rejects writes through symlinks that resolve outside the workspace root",
      () =>
        Effect.gen(function* () {
          const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const cwd = yield* makeTempDir;
          const outsideDir = yield* makeTempDir;
          yield* writeTextFile(outsideDir, "existing.md", "outside\n");
          yield* fileSystem.symlink(outsideDir, path.join(cwd, "linked-dir"));
          yield* fileSystem.symlink(
            path.join(outsideDir, "existing.md"),
            path.join(cwd, "linked-file.md"),
          );
          yield* fileSystem.symlink(
            path.join(outsideDir, "missing.md"),
            path.join(cwd, "dangling.md"),
          );

          for (const relativePath of [
            "linked-dir/new.md",
            "linked-dir/nested/new.md",
            "linked-file.md",
          ]) {
            const error = yield* workspaceFileSystem
              .writeFile({ cwd, relativePath, contents: "# nope\n" })
              .pipe(Effect.flip);
            expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFilePathEscapeError);
          }
          const danglingError = yield* workspaceFileSystem
            .writeFile({ cwd, relativePath: "dangling.md", contents: "# nope\n" })
            .pipe(Effect.flip);
          expect(danglingError).toBeInstanceOf(
            WorkspaceFileSystem.WorkspaceFileSystemOperationError,
          );
          expect(danglingError).toMatchObject({ operation: "realpath-target" });

          expect((yield* fileSystem.readDirectory(outsideDir)).toSorted()).toEqual(["existing.md"]);
          expect(yield* fileSystem.readFileString(path.join(outsideDir, "existing.md"))).toBe(
            "outside\n",
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "writes through symlinks that stay inside the workspace root",
      () =>
        Effect.gen(function* () {
          const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const parentDir = yield* makeTempDir;
          const cwd = path.join(parentDir, "workspace");
          const cwdAlias = path.join(parentDir, "workspace-alias");
          yield* writeTextFile(cwd, "docs/README.md", "old\n");
          yield* fileSystem.symlink(path.join(cwd, "docs"), path.join(cwd, "docs-alias"));
          yield* fileSystem.symlink("docs/README.md", path.join(cwd, "README.md"));
          yield* fileSystem.symlink(cwd, cwdAlias);

          yield* workspaceFileSystem.writeFile({
            cwd,
            relativePath: "docs-alias/plans/plan.md",
            contents: "# Plan\n",
          });
          yield* workspaceFileSystem.writeFile({
            cwd,
            relativePath: "README.md",
            contents: "new\n",
          });
          yield* workspaceFileSystem.writeFile({
            cwd: cwdAlias,
            relativePath: "notes.md",
            contents: "notes\n",
          });
          // `..` after a link in cwd is resolved by name, as for the relative path.
          yield* fileSystem.symlink(path.join(cwd, "docs/plans"), path.join(cwd, "plans-alias"));
          yield* workspaceFileSystem.writeFile({
            cwd: `${path.join(cwd, "plans-alias")}${path.sep}..`,
            relativePath: "dotdot.md",
            contents: "dotdot\n",
          });

          expect(yield* fileSystem.readFileString(path.join(cwd, "docs/plans/plan.md"))).toBe(
            "# Plan\n",
          );
          expect(yield* fileSystem.readFileString(path.join(cwd, "docs/README.md"))).toBe("new\n");
          expect(yield* fileSystem.readLink(path.join(cwd, "README.md"))).toBe("docs/README.md");
          expect(yield* fileSystem.readFileString(path.join(cwd, "notes.md"))).toBe("notes\n");
          expect(yield* fileSystem.readFileString(path.join(cwd, "dotdot.md"))).toBe("dotdot\n");
        }),
    );

    // On Windows `\` is a separator, so the name cannot exist there.
    it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
      "keeps a backslash in a file name as part of the name",
      () =>
        Effect.gen(function* () {
          const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const fileSystem = yield* FileSystem.FileSystem;
          const cwd = yield* makeTempDir;
          yield* writeTextFile(cwd, "a\\b.md", "old\n");

          yield* workspaceFileSystem.writeFile({ cwd, relativePath: "a\\b.md", contents: "new\n" });

          expect(
            (yield* workspaceFileSystem.readFile({ cwd, relativePath: "a\\b.md" })).contents,
          ).toBe("new\n");
          expect(yield* fileSystem.readDirectory(cwd)).toEqual(["a\\b.md"]);
        }),
    );

    it.effect("refuses writes into git's own folders", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, ".git/config", "[core]\n");
        yield* writeTextFile(cwd, ".bare/HEAD", "ref: refs/heads/main\n");
        yield* writeTextFile(cwd, ".bare/objects/info/packs");
        yield* writeTextFile(cwd, ".bare/refs/heads/main");
        yield* writeTextFile(cwd, ".bare/hooks/pre-push.sample");
        // Only a linked worktree's `.git` file ends the upward check, not any `.git` folder.
        yield* fileSystem.makeDirectory(path.join(cwd, ".bare/hooks/.git"));
        yield* writeTextFile(cwd, ".bare/worktrees/main/HEAD", "ref: refs/heads/main\n");
        yield* writeTextFile(cwd, ".bare/worktrees/main/commondir", "../..\n");
        if (symlinksSupported) yield* fileSystem.symlink(".git", path.join(cwd, "docs"));

        for (const [folder, relativePath] of [
          [cwd, ".git/config"],
          [cwd, ".git/hooks/pre-commit"],
          [cwd, "sub/.git"],
          [cwd, ".GIT/config"],
          [cwd, ".gıt/config"],
          [cwd, ".git. /config"],
          [cwd, ".git::$INDEX_ALLOCATION/config"],
          [cwd, "GIT~1/config"],
          [path.join(cwd, ".git"), "config"],
          [cwd, ".bare/config"],
          [path.join(cwd, ".bare"), "hooks/post-checkout"],
          [path.join(cwd, ".bare/hooks"), "post-checkout"],
          [path.join(cwd, ".bare/worktrees/main"), "commondir"],
          ...(symlinksSupported ? [[cwd, "docs/config"] as const] : []),
        ] as const) {
          const error = yield* workspaceFileSystem
            .writeFile({ cwd: folder, relativePath, contents: "[core]\n\tfsmonitor = x\n" })
            .pipe(Effect.flip);
          expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFilePathEscapeError);
        }

        expect(yield* fileSystem.readFileString(path.join(cwd, ".git/config"))).toBe("[core]\n");
        expect(yield* fileSystem.exists(path.join(cwd, ".bare/config"))).toBe(false);
        expect((yield* fileSystem.readDirectory(path.join(cwd, ".bare/hooks"))).toSorted()).toEqual(
          [".git", "pre-push.sample"],
        );
        expect(yield* fileSystem.exists(path.join(cwd, "sub"))).toBe(false);
        expect(
          yield* fileSystem.readFileString(path.join(cwd, ".bare/worktrees/main/commondir")),
        ).toBe("../..\n");
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "refuses writes through a git config that links to a file outside git's folders",
      () =>
        Effect.gen(function* () {
          const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const cwd = yield* makeTempDir;
          yield* writeTextFile(cwd, "shared/config", "[core]\n");
          yield* fileSystem.makeDirectory(path.join(cwd, ".git"));
          yield* fileSystem.symlink("../shared/config", path.join(cwd, ".git/config"));

          const error = yield* workspaceFileSystem
            .writeFile({ cwd, relativePath: ".git/config", contents: "[core]\n\tfsmonitor = x\n" })
            .pipe(Effect.flip);

          expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFilePathEscapeError);
          expect(yield* fileSystem.readFileString(path.join(cwd, "shared/config"))).toBe(
            "[core]\n",
          );
        }),
    );

    it.effect("writes files that sit beside git's folders", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parentDir = yield* makeTempDir;
        const bare = path.join(parentDir, "repo.git");
        yield* writeTextFile(bare, "HEAD", "ref: refs/heads/main\n");
        yield* writeTextFile(bare, "objects/info/packs");
        yield* writeTextFile(bare, "refs/heads/main");
        yield* writeTextFile(bare, "main/.git", `gitdir: ${path.join(bare, "worktrees/main")}\n`);

        for (const [cwd, relativePath] of [
          [path.join(bare, "main"), ".gitignore"],
          [path.join(bare, "main"), ".gitattributes"],
          [path.join(bare, "main"), ".github/workflows/ci.yml"],
          [path.join(bare, "main"), "vendor/lib.git/README.md"],
          [path.join(bare, "main/.github"), "CODEOWNERS"],
          [bare, "main/plan.md"],
        ] as const) {
          yield* workspaceFileSystem.writeFile({ cwd, relativePath, contents: "ok\n" });
          expect(yield* fileSystem.readFileString(path.join(cwd, relativePath))).toBe("ok\n");
        }
      }),
    );
  });

  // The Files tile edits the instruction files the Default view reads; this is a remote write path.
  describe("instruction file writes", () => {
    const layerInstructionWrites = Layer.fresh(WorkspaceFileSystem.layer).pipe(
      Layer.provide(
        InstructionFileAllowlist.layer.pipe(
          Layer.provide(
            Layer.mock(ServerSettingsService)({
              getSettings: Effect.succeed({ providerInstances: {} } as never),
            }),
          ),
        ),
      ),
      Layer.provide(layerKnownWorkspacesTest),
      Layer.provide(WorkspacePaths.layer),
      Layer.provide(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
    );
    const setup = Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fileSystem.realPath(yield* makeTempDir);
      const cwd = path.join(home, "code", "repo");
      const wing = path.join(home, ".config", "wing");
      yield* writeTextFile(cwd, ".git/HEAD", "ref");
      yield* writeTextFile(cwd, "CLAUDE.md", "[outside](../../notes.md)");
      // A client that can edit the global file links whatever it wants written next.
      // Dotfiles keep the real file in a repository and link it into ~/.claude.
      yield* writeTextFile(
        home,
        "dotfiles/CLAUDE.md",
        [
          "@~/.config/wing/BOOT.md",
          "[env](~/.env.md) [vault](~/vault/target.md) [rc](~/.bashrc.md)",
          // An alias listed first is the path the walk records for gh's file.
          "[file alias](~/.config/ghnotes.md) [folder alias](~/.config/ghalias/notes.md)",
          "[gh](~/.config/gh/notes.md)",
          "[repo](~/code/other/docs/a.md) [folder link](~/.config/dirlink/x.md)",
        ].join("\n"),
      );
      yield* fileSystem.makeDirectory(path.join(home, ".claude"), { recursive: true });
      yield* fileSystem.symlink(
        path.join(home, "dotfiles", "CLAUDE.md"),
        path.join(home, ".claude", "CLAUDE.md"),
      );
      yield* writeTextFile(
        wing,
        "BOOT.md",
        [
          "[linked](LINKED.md) [pipe](pipe.md) [hard](hard.md) [alias](alias.md)",
          "[keys](~/.ssh/keys.md) [state](~/.t3/userdata/notes.md)",
          "[memory](MEMORY.md) [clone](../clone/notes.md)",
        ].join("\n"),
      );
      yield* writeTextFile(wing, "LINKED.md", "linked");
      // Dotfiles keep the real file in a repository and link it into ~/.config.
      yield* writeTextFile(home, "dotfiles/.git/HEAD", "ref");
      yield* writeTextFile(home, "dotfiles/MEMORY.md", "memory");
      yield* fileSystem.symlink(
        path.join(home, "dotfiles", "MEMORY.md"),
        path.join(wing, "MEMORY.md"),
      );
      yield* writeTextFile(home, ".config/clone/.git/HEAD", "ref");
      yield* writeTextFile(home, ".config/clone/notes.md", "cloned");
      yield* writeTextFile(home, ".config/clone/sub/README", "");
      yield* writeTextFile(home, ".config/gh/notes.md", "gh");
      yield* fileSystem.symlink(
        path.join(home, ".config", "gh"),
        path.join(home, ".config", "ghalias"),
      );
      yield* fileSystem.symlink(
        path.join(home, ".config", "gh", "notes.md"),
        path.join(home, ".config", "ghnotes.md"),
      );
      yield* writeTextFile(home, "code/other/sub/x.md", "other repo subfolder");
      yield* fileSystem.symlink(
        path.join(home, "code", "other", "sub"),
        path.join(home, ".config", "dirlink"),
      );
      yield* writeTextFile(home, "code/other/.git/HEAD", "ref");
      yield* writeTextFile(home, "code/other/docs/a.md", "other repo");
      yield* writeTextFile(home, "vault/target.md", "vault");
      yield* writeTextFile(home, ".bashrc.md", "rc");
      yield* writeTextFile(home, ".ssh/keys.md", "secret");
      yield* writeTextFile(home, ".ssh/authorized_keys", "ssh-ed25519 KEY");
      yield* writeTextFile(home, ".env.md", "TOKEN=1");
      yield* writeTextFile(home, ".t3/userdata/notes.md", "state");
      yield* writeTextFile(home, "notes.md", "private");
      yield* fileSystem.symlink(path.join(home, ".ssh", "keys.md"), path.join(wing, "alias.md"));
      yield* Effect.promise(() =>
        NodeFSP.link(path.join(home, ".ssh", "authorized_keys"), path.join(wing, "hard.md")),
      );
      if (HostProcess.Platform.defaultValue() !== "win32") {
        NodeChildProcess.execFileSync("mkfifo", [path.join(wing, "pipe.md")]);
      }
      return { home, cwd, wing };
    });
    const asHome =
      (home: string) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.provideService(HostProcess.HomeDirectory, home),
          Effect.provideService(HostProcess.Environment, {}),
        );

    it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
      "edits only allowlisted instruction files, in place",
      () =>
        Effect.gen(function* () {
          const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { home, cwd, wing } = yield* setup;
          const inHome = asHome(home);

          const refused = [
            "~/notes.md",
            "~/.ssh/keys.md",
            "~/.ssh/authorized_keys",
            "~/.env.md",
            "~/.t3/userdata/notes.md",
            "~/.config/wing/pipe.md",
            "~/.config/wing/hard.md",
            "~/.config/wing/alias.md",
            "~/.config/wing/../../notes.md",
            "~/.claude/missing.md",
            "/etc/passwd",
            "~/vault/target.md",
            "~/.bashrc.md",
            "~/.config/gh/notes.md",
            "~/.config/ghalias/notes.md",
            "~/.config/ghnotes.md",
            "~/code/other/docs/a.md",
            "~/.config/dirlink/x.md",
            "~/.config/clone/notes.md",
          ];
          for (const relativePath of refused) {
            const read = yield* inHome(
              workspaceFileSystem.readFile({ cwd, relativePath, allowMissing: true }),
            ).pipe(Effect.option);
            expect(read._tag === "Some" && read.value.writable === true).toBe(false);
            const error = yield* inHome(
              workspaceFileSystem.writeFile({ cwd, relativePath, contents: "pwned" }),
            ).pipe(Effect.flip);
            expect(error.message).not.toBe("");
          }
          // CLAUDE.md last: editing it drops the import that reaches the others.
          const editable = [
            [cwd, path.join(wing, "LINKED.md")],
            [cwd, "~/.config/wing/MEMORY.md"],
            // A repository's file is writable while that repository is the workspace.
            [path.join(home, ".config", "clone", "sub"), "~/.config/clone/notes.md"],
            [cwd, "~/.claude/CLAUDE.md"],
          ] as const;
          for (const [workspace, relativePath] of editable) {
            const read = yield* inHome(
              workspaceFileSystem.readFile({ cwd: workspace, relativePath }),
            );
            expect(read.writable).toBe(true);
            yield* inHome(
              workspaceFileSystem.writeFile({ cwd: workspace, relativePath, contents: "edited" }),
            );
            const written = relativePath.startsWith("~/")
              ? path.join(home, relativePath.slice(2))
              : relativePath;
            expect(yield* fileSystem.readFileString(written)).toBe("edited");
          }
          expect(yield* fileSystem.readLink(path.join(wing, "MEMORY.md"))).toBe(
            path.join(home, "dotfiles", "MEMORY.md"),
          );
          expect(yield* fileSystem.readLink(path.join(home, ".claude", "CLAUDE.md"))).toBe(
            path.join(home, "dotfiles", "CLAUDE.md"),
          );

          expect(yield* fileSystem.readFileString(path.join(home, "notes.md"))).toBe("private");
          expect(yield* fileSystem.readFileString(path.join(home, ".ssh", "keys.md"))).toBe(
            "secret",
          );
          expect(yield* fileSystem.readFileString(path.join(home, ".ssh", "authorized_keys"))).toBe(
            "ssh-ed25519 KEY",
          );
          expect(yield* fileSystem.readFileString(path.join(home, ".env.md"))).toBe("TOKEN=1");
          for (const [file, text] of [
            ["vault/target.md", "vault"],
            [".bashrc.md", "rc"],
            [".config/gh/notes.md", "gh"],
            ["code/other/docs/a.md", "other repo"],
            ["code/other/sub/x.md", "other repo subfolder"],
          ] as const) {
            expect(yield* fileSystem.readFileString(path.join(home, file))).toBe(text);
          }
          expect(yield* fileSystem.exists(path.join(home, ".claude", "missing.md"))).toBe(false);

          const unknown = yield* fileSystem.makeTempDirectoryScoped({
            prefix: UNKNOWN_WORKSPACE_PREFIX,
          });
          expect(
            yield* inHome(
              workspaceFileSystem.writeFile({
                cwd: unknown,
                relativePath: "~/.claude/CLAUDE.md",
                contents: "pwned",
              }),
            ).pipe(Effect.flip),
          ).toBeInstanceOf(KnownWorkspaces.UnknownWorkspaceError);
          expect(yield* fileSystem.readFileString(path.join(home, ".claude", "CLAUDE.md"))).toBe(
            "edited",
          );
        }).pipe(Effect.provide(layerInstructionWrites)),
    );

    const layerGrantWrites = () => {
      let grants: ReadonlyArray<OutsideWorkspaceEditGrant> = [];
      const settings = Layer.mock(ServerSettingsService)({
        getSettings: Effect.sync(
          () => ({ providerInstances: {}, outsideWorkspaceEditGrants: grants }) as never,
        ),
        updateSettings: (patch) =>
          Effect.sync(() => {
            grants = patch.outsideWorkspaceEditGrants ?? grants;
            return { outsideWorkspaceEditGrants: grants } as never;
          }),
      });
      return Layer.fresh(WorkspaceFileSystem.layer).pipe(
        Layer.provide(InstructionFileAllowlist.layer.pipe(Layer.provide(settings))),
        Layer.provide(settings),
        Layer.provide(layerKnownWorkspacesTest),
        Layer.provide(WorkspacePaths.layer),
        Layer.provide(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
      );
    };

    it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
      "edits outside the workspace only what a grant covers, until it is revoked",
      () =>
        Effect.gen(function* () {
          const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const config = yield* ServerConfig.ServerConfig;
          const { home, cwd } = yield* setup;
          const inHome = asHome(home);
          const otherWorkspace = path.join(home, "code", "elsewhere");
          yield* writeTextFile(otherWorkspace, "README.md");
          // A skill linked into ~/.claude from another repository.
          yield* writeTextFile(home, "ink/.git/HEAD", "ref");
          yield* writeTextFile(home, "ink/skills/choices/SKILL.md", "skill");
          yield* writeTextFile(home, "ink/skills/other/SKILL.md", "other skill");
          const skill = "~/.claude/skills/choices/SKILL.md";
          yield* fileSystem.makeDirectory(path.join(home, ".claude", "skills", "choices"), {
            recursive: true,
          });
          yield* fileSystem.symlink(
            path.join(home, "ink", "skills", "choices", "SKILL.md"),
            path.join(home, ".claude", "skills", "choices", "SKILL.md"),
          );
          const internal = path.join(config.secretsDir, "notes.md");
          yield* writeTextFile(config.secretsDir, "notes.md", "secret");

          const read = (relativePath: string, workspace = cwd) =>
            inHome(workspaceFileSystem.readFile({ cwd: workspace, relativePath }));
          const write = (relativePath: string, workspace = cwd) =>
            inHome(
              workspaceFileSystem.writeFile({ cwd: workspace, relativePath, contents: "edited" }),
            );
          const refuses = Effect.fn("refuses")(function* (relativePath: string, workspace = cwd) {
            const result = yield* read(relativePath, workspace).pipe(Effect.option);
            expect(result._tag === "Some" && result.value.writable === true).toBe(false);
            yield* write(relativePath, workspace).pipe(Effect.flip);
          });

          expect(yield* read(skill)).toMatchObject({ canGrantEdit: true });
          yield* refuses(skill);

          const fileGrant = yield* inHome(
            workspaceFileSystem.allowOutsideEdits({ cwd, relativePath: skill, scope: "file" }),
          );
          expect(fileGrant).toEqual({
            kind: "file",
            path: path.join(home, "ink", "skills", "choices", "SKILL.md"),
          });
          expect(yield* read(skill)).toMatchObject({ writable: true, editGrant: fileGrant });
          // The grant follows the file wherever it is opened, and covers nothing else.
          yield* write(skill, otherWorkspace);
          expect(yield* fileSystem.readFileString(fileGrant.path)).toBe("edited");
          expect(
            yield* fileSystem.readLink(path.join(home, ".claude", "skills", "choices", "SKILL.md")),
          ).toBe(fileGrant.path);
          yield* refuses("~/ink/skills/other/SKILL.md");
          yield* refuses("~/vault/target.md");
          // Relinking the granted path to another file does not carry the grant along.
          yield* fileSystem.remove(path.join(home, ".claude", "skills", "choices", "SKILL.md"));
          yield* fileSystem.symlink(
            path.join(home, "ink", "skills", "other", "SKILL.md"),
            path.join(home, ".claude", "skills", "choices", "SKILL.md"),
          );
          yield* refuses(skill);
          expect(
            yield* fileSystem.readFileString(path.join(home, "ink/skills/other/SKILL.md")),
          ).toBe("other skill");

          yield* workspaceFileSystem.revokeOutsideEdits({ grant: fileGrant });
          yield* refuses("~/ink/skills/choices/SKILL.md");

          const workspaceGrant = yield* inHome(
            workspaceFileSystem.allowOutsideEdits({
              cwd,
              relativePath: "~/vault/target.md",
              scope: "workspace",
            }),
          );
          expect(workspaceGrant).toEqual({ kind: "workspace", path: cwd });
          for (const relativePath of ["~/vault/target.md", "~/.bashrc.md", skill]) {
            expect(yield* read(relativePath)).toMatchObject({
              writable: true,
              editGrant: workspaceGrant,
            });
            yield* write(relativePath);
          }
          yield* refuses("~/vault/target.md", otherWorkspace);
          // No grant reaches credentials, hard links, git metadata, or the server's own files.
          for (const relativePath of [
            "~/.config/gh/notes.md",
            "~/.config/ghnotes.md",
            "~/.config/ghalias/notes.md",
            "~/.config/wing/hard.md",
            "~/ink/.git/HEAD",
            internal,
          ]) {
            yield* refuses(relativePath);
            yield* inHome(
              workspaceFileSystem.allowOutsideEdits({ cwd, relativePath, scope: "file" }),
            ).pipe(Effect.flip);
          }
          expect(yield* fileSystem.readFileString(path.join(home, ".config/gh/notes.md"))).toBe(
            "gh",
          );
          expect(yield* fileSystem.readFileString(internal)).toBe("secret");
          // The server's own state stays read-only: a writable settings file could rewrite the grants.
          yield* writeTextFile(path.dirname(config.settingsPath), "settings.json", "{}");
          yield* writeTextFile(config.baseDir, "caches/notes.md", "cache");
          for (const relativePath of [
            config.settingsPath,
            path.join(config.baseDir, "caches", "notes.md"),
            "~/.t3/userdata/notes.md",
          ]) {
            yield* refuses(relativePath);
            yield* inHome(
              workspaceFileSystem.allowOutsideEdits({ cwd, relativePath, scope: "file" }),
            ).pipe(Effect.flip);
          }
          expect(yield* fileSystem.readFileString(config.settingsPath)).toBe("{}");
          // Home credential files stay read-only once nothing else refuses them.
          yield* fileSystem.remove(path.join(home, ".config", "wing", "hard.md"));
          yield* writeTextFile(home, ".aws/credentials", "[default]");
          for (const relativePath of ["~/.ssh/authorized_keys", "~/.aws/credentials"]) {
            yield* refuses(relativePath);
            yield* inHome(
              workspaceFileSystem.allowOutsideEdits({ cwd, relativePath, scope: "file" }),
            ).pipe(Effect.flip);
          }
          expect(yield* fileSystem.readFileString(path.join(home, ".ssh", "authorized_keys"))).toBe(
            "ssh-ed25519 KEY",
          );
          expect(yield* fileSystem.readFileString(path.join(home, ".aws", "credentials"))).toBe(
            "[default]",
          );

          // Blocks match the path as named, and letter case, which some volumes ignore.
          yield* writeTextFile(home, "plain.md", "plain");
          yield* fileSystem.makeDirectory(path.join(home, "notgit", ".git"), { recursive: true });
          yield* fileSystem.symlink(
            path.join(home, "plain.md"),
            path.join(home, "notgit", ".git", "config"),
          );
          yield* writeTextFile(home, ".SSH/keys", "secret");
          yield* writeTextFile(home, ".Config/GH/hosts.yml", "token");
          for (const relativePath of [
            "~/notgit/.git/config",
            "~/.SSH/keys",
            "~/.Config/GH/hosts.yml",
          ]) {
            yield* refuses(relativePath);
          }
          expect(yield* fileSystem.readFileString(path.join(home, "plain.md"))).toBe("plain");

          yield* workspaceFileSystem.revokeOutsideEdits({ grant: workspaceGrant });
          yield* refuses("~/.bashrc.md");
          expect(yield* read("~/.bashrc.md")).toMatchObject({ canGrantEdit: true });
        }).pipe(Effect.provide(layerGrantWrites())),
    );

    it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
      "refuses a file swapped between the allowlist check and the write",
      () =>
        Effect.gen(function* () {
          const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { home, cwd } = yield* setup;
          const claudeDir = path.join(home, ".claude");
          const target = path.join(claudeDir, "CLAUDE.md");
          const secret = path.join(home, ".ssh", "authorized_keys");
          const decoy = path.join(home, "decoy");
          yield* writeTextFile(decoy, "CLAUDE.md", "decoy");
          const swaps: ReadonlyArray<() => Promise<void>> = [
            // The file becomes a symlink to a credential.
            async () => {
              await NodeFSP.rm(target);
              await NodeFSP.symlink(secret, target);
            },
            // The file becomes a hard link to a credential.
            async () => {
              await NodeFSP.rm(target);
              await NodeFSP.link(secret, target);
            },
            // Its folder becomes a symlink to another folder.
            async () => {
              await NodeFSP.rename(claudeDir, `${claudeDir}.old`);
              await NodeFSP.symlink(decoy, claudeDir);
            },
          ];
          const native = yield* Effect.promise(() =>
            vi.importActual<typeof NodeFSP>("node:fs/promises"),
          );
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => vi.mocked(NodeFSP.open).mockImplementation(native.open)),
          );
          for (const swap of swaps) {
            yield* Effect.promise(async () => {
              await NodeFSP.rm(claudeDir, { recursive: true, force: true });
              await NodeFSP.rm(`${claudeDir}.old`, { recursive: true, force: true });
              await NodeFSP.mkdir(claudeDir);
              await NodeFSP.writeFile(target, "original");
            });
            let swapped = false;
            // Swap while the new text is written, after the first check passed.
            vi.mocked(NodeFSP.open).mockImplementation(async (file, flags, mode) => {
              if (!swapped && String(file).endsWith(".t3-save")) {
                swapped = true;
                await swap();
              }
              return native.open(file, flags, mode);
            });
            yield* asHome(home)(
              workspaceFileSystem.writeFile({
                cwd,
                relativePath: "~/.claude/CLAUDE.md",
                contents: "pwned",
              }),
            ).pipe(Effect.flip);
            expect(swapped).toBe(true);
            expect(yield* fileSystem.readFileString(secret)).toBe("ssh-ed25519 KEY");
            expect(yield* fileSystem.readFileString(path.join(decoy, "CLAUDE.md"))).toBe("decoy");
            for (const dir of [decoy, claudeDir, `${claudeDir}.old`]) {
              const names = yield* fileSystem
                .readDirectory(dir)
                .pipe(Effect.orElseSucceed(() => []));
              expect(names.filter((name) => name.endsWith(".t3-save"))).toEqual([]);
            }
          }
          expect(yield* fileSystem.readFileString(path.join(`${claudeDir}.old`, "CLAUDE.md"))).toBe(
            "original",
          );
        }).pipe(Effect.provide(layerInstructionWrites)),
    );

    it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
      "keeps the file's mode, and its old text when a save fails",
      () =>
        Effect.gen(function* () {
          const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { home, cwd } = yield* setup;
          const claudeDir = path.join(home, ".claude");
          const target = path.join(claudeDir, "CLAUDE.md");
          const save = (contents: string) =>
            asHome(home)(
              workspaceFileSystem.writeFile({ cwd, relativePath: "~/.claude/CLAUDE.md", contents }),
            );
          yield* Effect.promise(() => NodeFSP.chmod(target, 0o640));
          const before = yield* fileSystem.readFileString(target);
          yield* save(before);
          expect((yield* Effect.promise(() => NodeFSP.stat(target))).mode & 0o777).toBe(0o640);

          const native = yield* Effect.promise(() =>
            vi.importActual<typeof NodeFSP>("node:fs/promises"),
          );
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => vi.mocked(NodeFSP.open).mockImplementation(native.open)),
          );
          vi.mocked(NodeFSP.open).mockImplementation(async (file, flags, mode) => {
            const handle = await native.open(file, flags, mode);
            if (String(file).endsWith(".t3-save")) {
              Object.defineProperty(handle, "writeFile", {
                value: () => Promise.reject(new Error("ENOSPC: no space left on device")),
              });
            }
            return handle;
          });
          yield* save("lost").pipe(Effect.flip);
          expect(yield* fileSystem.readFileString(target)).toBe(before);
          expect(
            (yield* fileSystem.readDirectory(claudeDir)).filter((name) =>
              name.endsWith(".t3-save"),
            ),
          ).toEqual([]);
          vi.mocked(NodeFSP.open).mockImplementation(native.open);

          // A folder that takes no new entries still saves, in place.
          const wing = path.join(home, ".config", "wing");
          yield* Effect.acquireRelease(
            Effect.promise(() => NodeFSP.chmod(wing, 0o555)),
            () => Effect.promise(() => NodeFSP.chmod(wing, 0o755)),
          );
          yield* asHome(home)(
            workspaceFileSystem.writeFile({
              cwd,
              relativePath: "~/.config/wing/LINKED.md",
              contents: "in place",
            }),
          );
          expect(yield* fileSystem.readFileString(path.join(wing, "LINKED.md"))).toBe("in place");
        }).pipe(Effect.provide(layerInstructionWrites)),
    );
  });
});
