import {
  FileFinder,
  type FileItem,
  type GrepCursor,
  type GrepOptions,
  type GrepResult,
  type WatchEvent,
} from "@ff-labs/fff-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, expect, it } from "@effect/vitest";
import { VcsProcessTimeoutError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { PROJECT_FAVICON_EXTENSIONS, isProjectFaviconPath } from "@t3tools/shared/projectFavicon";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/process";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspaceSearchIndex from "./WorkspaceSearchIndex.ts";

const testLayer = VcsProcess.layer.pipe(Layer.provideMerge(NodeServices.layer));

afterEach(() => {
  vi.restoreAllMocks();
});

function fileItem(relativePath: string): FileItem {
  return {
    relativePath,
    fileName: relativePath.slice(relativePath.lastIndexOf("/") + 1),
    size: 1,
    modified: 0,
    accessFrecencyScore: 0,
    modificationFrecencyScore: 0,
    totalFrecencyScore: 0,
    gitStatus: "clean",
  };
}

it.live("image searches match the image subset of a file search without fetching every file", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const vcsProcess = yield* VcsProcess.VcsProcess;
    const writeFiles = Effect.fn(function* (root: string, relativePaths: ReadonlyArray<string>) {
      for (const relativePath of relativePaths) {
        yield* fileSystem.makeDirectory(path.dirname(path.join(root, relativePath)), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(path.join(root, relativePath), "");
        yield* fileSystem.utimes(path.join(root, relativePath), 0, 0);
      }
    });

    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-image-search-" });
    yield* vcsProcess.run({ operation: "test.gitInit", command: "git", args: ["init"], cwd });
    yield* fileSystem.writeFileString(path.join(cwd, ".git/info/exclude"), "hidden/\n");
    yield* writeFiles(cwd, [
      ...Array.from({ length: 220 }, (_, index) => `assets/source-${index}.ts`),
      ...PROJECT_FAVICON_EXTENSIONS.flatMap((extension) => [
        `assets/logo${extension}`,
        `other/logo${extension.toUpperCase()}`,
      ]),
      "assets/logo.ts",
      "assets/logotype.png",
      "assetss/logotype.png",
      "assets/images/logo.PNG",
      "assets/foo{bar}.png",
      "assets/[id].png",
      "hidden/logo.png",
    ]);

    const fileSearch = vi.spyOn(FileFinder.prototype, "fileSearchAsync");
    const searchIndex = yield* WorkspaceSearchIndex.make(cwd);
    yield* searchIndex.search("", 200, undefined, true);
    const nativeResult = yield* Effect.promise(
      (): ReturnType<FileFinder["fileSearchAsync"]> => fileSearch.mock.results[0]?.value,
    );
    if (!nativeResult.ok) return yield* Effect.die(nativeResult.error);
    expect(nativeResult.value.items.length).toBeLessThanOrEqual(201);

    // The image glob must not change fff's parse of fuzzy paths, globs, negations or locations.
    for (const query of [
      "",
      "logo",
      "lgo",
      "*.png",
      "!*.png",
      "assets/**",
      "!assets/",
      "assets*/",
      "/assets",
      "assets/",
      "logo:12",
      "/assets/logotype.png",
      "assets/images/",
      "logo *.svg !other",
      "foo{bar}.png",
      "[id].png",
      "*.{png,svg}",
      "hidden/",
    ]) {
      const ordinary = yield* searchIndex.search(query, 1000, "file");
      const expected = ordinary.entries.filter((entry) => isProjectFaviconPath(entry.path));
      for (const limit of [1, 200]) {
        const images = yield* searchIndex.search(query, limit, "directory", true);
        expect(images, `query=${query} limit=${limit}`).toEqual({
          entries: expected.slice(0, limit),
          truncated: expected.length > limit,
        });
      }
    }

    // Past 15,000 matches fff drops its filename fallback, which the image glob would otherwise
    // reorder: "x/logo/logo.png" must keep its place relative to "a/xxlogo.png".
    const largeCwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-image-rank-" });
    yield* writeFiles(largeCwd, [
      ...Array.from({ length: 14_998 }, (_, index) => `b/logo-${index}.png`),
      "x/logo/source.ts",
      "a/xxlogo.png",
      "x/logo/logo.png",
    ]);
    const largeIndex = yield* WorkspaceSearchIndex.make(largeCwd);
    const pairPaths = ["a/xxlogo.png", "x/logo/logo.png"];
    const ordinary = yield* largeIndex.search("logo", 20_000, "file");
    const images = yield* largeIndex.search("logo", 20_000, "file", true);
    expect(images.entries).toHaveLength(15_000);
    expect(images.entries.filter((entry) => pairPaths.includes(entry.path))).toEqual(
      ordinary.entries.filter((entry) => pairPaths.includes(entry.path)),
    );
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("fetches past a first page of Git-ignored results", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-search-ignored-" });
      const vcsProcess = yield* VcsProcess.VcsProcess;
      yield* vcsProcess.run({ operation: "test.gitInit", command: "git", args: ["init"], cwd });
      yield* fs.writeFileString(path.join(cwd, ".git", "info", "exclude"), "hidden/\n");
      yield* fs.makeDirectory(path.join(cwd, "hidden"));
      yield* fs.writeFileString(path.join(cwd, "hidden", "a.ts"), "");

      const items = [
        fileItem("hidden/a.ts"),
        fileItem("hidden/b.ts"),
        fileItem("hidden/c.ts"),
        fileItem("src/a.ts"),
      ];
      const fileSearch = vi.fn(async (_query: string, options?: { pageSize?: number }) => ({
        ok: true as const,
        value: {
          items: items.slice(0, options?.pageSize),
          scores: [],
          totalMatched: items.length,
          totalFiles: items.length,
        },
      }));
      const finder = {
        destroy: vi.fn(),
        waitForIndexReady: vi.fn(async () => ({ ok: true as const, value: true })),
        getScanProgressAsync: async () => ({
          ok: true as const,
          value: { isScanning: false },
        }),
        watchAsync: async () => ({ ok: true as const, value: () => undefined }),
        fileSearchAsync: fileSearch,
      } as unknown as FileFinder;
      vi.spyOn(FileFinder, "create").mockReturnValueOnce({ ok: true, value: finder });

      const searchIndex = yield* WorkspaceSearchIndex.make(cwd);
      const result = yield* searchIndex.search("a", 1, "file", false);

      expect(result).toEqual({ entries: [{ kind: "file", path: "src/a.ts" }], truncated: false });
    }),
  ).pipe(Effect.provide(testLayer)),
);

// A backslash is a file name character on Linux and macOS, so only Windows may treat it as a separator.
it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "keeps a backslash in a POSIX folder name as part of the search result path",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const items = [fileItem("dir\\one/report.txt")];
        const finder = {
          destroy: vi.fn(),
          waitForIndexReady: vi.fn(async () => ({ ok: true as const, value: true })),
          getScanProgressAsync: async () => ({
            ok: true as const,
            value: { isScanning: false },
          }),
          watchAsync: async () => ({ ok: true as const, value: () => undefined }),
          fileSearchAsync: vi.fn(async () => ({
            ok: true as const,
            value: { items, scores: [], totalMatched: 1, totalFiles: 1 },
          })),
        } as unknown as FileFinder;
        vi.spyOn(FileFinder, "create").mockReturnValueOnce({ ok: true, value: finder });

        const searchIndex = yield* WorkspaceSearchIndex.make("/workspace/project");
        const result = yield* searchIndex.search("report", 50, "file");

        expect(result.entries).toEqual([{ kind: "file", path: "dir\\one/report.txt" }]);
      }),
    ).pipe(Effect.provide(testLayer)),
);

it.effect("continues whole-word searches after a filtered grep page", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const nextCursor = {
        __brand: "GrepCursor",
        _offset: 1,
      } as GrepCursor;
      const grepResult = (
        lineContent: string,
        matchRanges: Array<[number, number]>,
        cursor: GrepCursor | null,
      ): GrepResult => ({
        items: [
          {
            relativePath: "src/words.ts",
            fileName: "words.ts",
            gitStatus: "unmodified",
            size: lineContent.length,
            modified: 0,
            isBinary: false,
            totalFrecencyScore: 0,
            accessFrecencyScore: 0,
            modificationFrecencyScore: 0,
            lineNumber: 1,
            col: 0,
            byteOffset: 0,
            lineContent,
            matchRanges,
          },
        ],
        totalMatched: 1,
        totalFilesSearched: 1,
        totalFiles: 1,
        filteredFileCount: 1,
        nextCursor: cursor,
      });
      const grep = vi.fn(async (_query: string, options?: GrepOptions) =>
        options?.cursor
          ? { ok: true as const, value: grepResult("needle", [[0, 6]], null) }
          : {
              ok: true as const,
              value: grepResult("needleSuffix", [[0, 6]], nextCursor),
            },
      );
      const finder = {
        destroy: vi.fn(),
        waitForIndexReady: vi.fn(async () => ({ ok: true as const, value: true })),
        getScanProgressAsync: async () => ({
          ok: true as const,
          value: { isScanning: false },
        }),
        watchAsync: async () => ({ ok: true as const, value: () => undefined }),
        grepAsync: grep,
      } as unknown as FileFinder;
      vi.spyOn(FileFinder, "create").mockReturnValueOnce({ ok: true, value: finder });

      const searchIndex = yield* WorkspaceSearchIndex.make("/workspace/project", "content");
      const result = yield* searchIndex.searchContents({
        query: "needle",
        limit: 1,
        caseSensitive: true,
        wholeWord: true,
        useRegex: false,
      });

      expect(result).toEqual({
        matches: [
          {
            path: "src/words.ts",
            lineNumber: 1,
            lineContent: "needle",
            matchRanges: [{ start: 0, end: 6 }],
          },
        ],
        truncated: false,
      });
      expect(grep).toHaveBeenCalledTimes(2);
      expect(grep.mock.calls[1]?.[1]?.cursor).toBe(nextCursor);
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.live("answers content searches with git grep while a slow content index builds", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const vcsProcess = yield* VcsProcess.VcsProcess;
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-content-warmup-" });
    yield* vcsProcess.run({ operation: "test.gitInit", command: "git", args: ["init"], cwd });
    yield* fileSystem.writeFileString(path.join(cwd, ".gitignore"), "ignored.txt\n");
    yield* fileSystem.makeDirectory(path.join(cwd, "src"));
    yield* fileSystem.writeFileString(
      path.join(cwd, "src/a.ts"),
      "const Needle = 1;\r\nneedles(a.b);\nnone\n",
    );
    yield* fileSystem.writeFileString(path.join(cwd, "ignored.txt"), "needle\n");
    // fff leaves out what `.ignore` excludes, so git results must leave it out too.
    yield* fileSystem.writeFileString(path.join(cwd, ".ignore"), "out/\n");
    yield* fileSystem.makeDirectory(path.join(cwd, "out/deep"), { recursive: true });
    yield* fileSystem.writeFileString(path.join(cwd, "out/deep/g.txt"), "needle\n");

    let isWarmupComplete = false;
    const grep = vi.fn(async () => ({
      ok: true as const,
      value: {
        items: [],
        totalMatched: 0,
        totalFilesSearched: 0,
        totalFiles: 0,
        filteredFileCount: 0,
        nextCursor: null,
      } satisfies GrepResult,
    }));
    const finder = {
      destroy: vi.fn(),
      waitForIndexReady: vi.fn(async () => ({ ok: true as const, value: false })),
      getScanProgressAsync: async () => ({
        ok: true as const,
        value: { isScanning: false, isWarmupComplete },
      }),
      watchAsync: async () => ({ ok: true as const, value: () => undefined }),
      grepAsync: grep,
    } as unknown as FileFinder;
    const noPcreFinder = {
      ...finder,
      waitForIndexReady: vi.fn(async () => ({ ok: true as const, value: true })),
    } as unknown as FileFinder;
    vi.spyOn(FileFinder, "create")
      .mockReturnValueOnce({ ok: true, value: finder })
      .mockReturnValueOnce({ ok: true, value: noPcreFinder })
      .mockReturnValueOnce({ ok: true, value: noPcreFinder })
      .mockReturnValueOnce({ ok: true, value: noPcreFinder });

    const searchIndex = yield* WorkspaceSearchIndex.make(cwd, "content");
    const search = (input: Partial<Parameters<typeof searchIndex.searchContents>[0]>) =>
      searchIndex.searchContents({
        query: "needle",
        limit: 10,
        caseSensitive: false,
        wholeWord: false,
        useRegex: false,
        ...input,
      });

    expect(yield* search({})).toEqual({
      matches: [
        {
          path: "src/a.ts",
          lineNumber: 1,
          lineContent: "const Needle = 1;",
          matchRanges: [{ start: 6, end: 12 }],
        },
        {
          path: "src/a.ts",
          lineNumber: 2,
          lineContent: "needles(a.b);",
          matchRanges: [{ start: 0, end: 6 }],
        },
      ],
      truncated: false,
    });
    expect((yield* search({ caseSensitive: true, wholeWord: true })).matches).toEqual([]);
    expect((yield* search({ query: "a.b" })).matches.map((match) => match.matchRanges)).toEqual([
      [{ start: 8, end: 11 }],
    ]);
    expect(
      (yield* search({ query: "ne+dles?", useRegex: true })).matches.map(
        (match) => match.matchRanges,
      ),
    ).toEqual([[{ start: 6, end: 12 }], [{ start: 0, end: 7 }]]);
    expect(
      (yield* search({ query: "[a-z]e", useRegex: true })).matches.map(
        (match) => match.matchRanges,
      ),
    ).toEqual([
      [{ start: 4, end: 6 }],
      [
        { start: 6, end: 8 },
        { start: 10, end: 12 },
      ],
      [
        { start: 0, end: 2 },
        { start: 4, end: 6 },
      ],
      [{ start: 2, end: 4 }],
    ]);
    const invalid = yield* search({ query: "a.b(", useRegex: true });
    expect(invalid.matches).toEqual([]);
    expect(invalid.regexFallbackError).toBeDefined();
    expect(yield* search({ limit: 1 })).toMatchObject({ truncated: true });
    expect(grep).not.toHaveBeenCalled();

    // When git cannot give regex results or their ranges, fff answers once ready instead.
    const failingGitIndex = (
      failingArgument: string,
      stderr: string,
      output: { readonly exitCode: number; readonly stdout: string } = {
        exitCode: 128,
        stdout: "",
      },
    ) =>
      WorkspaceSearchIndex.make(cwd, "content").pipe(
        Effect.provideService(
          VcsProcess.VcsProcess,
          VcsProcess.VcsProcess.of({
            run: (input) =>
              input.args.includes(failingArgument)
                ? Effect.succeed({
                    exitCode: ChildProcessSpawner.ExitCode(output.exitCode),
                    stdout: output.stdout,
                    stderr,
                    stdoutTruncated: output.exitCode === 0,
                    stderrTruncated: false,
                  })
                : vcsProcess.run(input),
          }),
        ),
      );
    const regexInput = {
      query: "ne+dles?",
      limit: 10,
      caseSensitive: false,
      wholeWord: true,
      useRegex: true,
    };
    const noPcreIndex = yield* failingGitIndex(
      "-P",
      "fatal: cannot use Perl-compatible regexes when not compiled with USE_LIBPCRE\n",
    );
    expect((yield* noPcreIndex.searchContents(regexInput)).regexFallbackError).toBeUndefined();
    expect(grep).toHaveBeenCalledTimes(1);
    const noRangesIndex = yield* failingGitIndex("-o", "fatal: unexpected failure\n");
    yield* noRangesIndex.searchContents(regexInput);
    expect(grep).toHaveBeenCalledTimes(2);
    // Ranges output cut off after line 1: line 2 is left out and the result says so.
    const cutRangesIndex = yield* failingGitIndex("-o", "", {
      exitCode: 0,
      stdout: "src/a.ts\u00001\u00007\u0000Needle\nsrc/a.ts\u00002",
    });
    expect(yield* cutRangesIndex.searchContents(regexInput)).toEqual({
      matches: [
        {
          path: "src/a.ts",
          lineNumber: 1,
          lineContent: "const Needle = 1;",
          matchRanges: [{ start: 6, end: 12 }],
        },
      ],
      truncated: true,
    });

    isWarmupComplete = true;
    yield* search({});
    expect(grep).toHaveBeenCalledTimes(3);
    expect(finder.destroy).not.toHaveBeenCalled();
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("keeps shared scratch search shallow and skips dependency trees", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-scratch-index-" });
      const cwd = path.join(home, "code");
      yield* fs.makeDirectory(path.join(cwd, "repo", "node_modules"), { recursive: true });
      yield* fs.writeFileString(path.join(cwd, "repo", "source.ts"), "nested content");
      yield* fs.writeFileString(
        path.join(cwd, "repo", "node_modules", "dependency.js"),
        "dependency",
      );
      yield* fs.writeFileString(path.join(cwd, "notes.txt"), "scratch note");
      const create = vi.spyOn(FileFinder, "create");
      const index = yield* WorkspaceSearchIndex.make(cwd).pipe(
        Effect.provideService(HostProcess.HomeDirectory, home),
      );
      expect(create).not.toHaveBeenCalled();
      expect((yield* index.list()).entries).toEqual([
        { path: "notes.txt", kind: "file" },
        { path: "repo", kind: "directory" },
      ]);
      expect((yield* index.search("source", 20)).entries).toEqual([]);
      const failure = yield* Effect.flip(
        index.searchContents({
          query: "scratch",
          limit: 20,
          caseSensitive: false,
          wholeWord: false,
          useRegex: false,
        }),
      );
      expect(failure).toMatchObject({
        reason: "Choose a repository folder to search file contents.",
      });
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect(
  "searches the repositories directly inside a shared scratch folder by their own rules",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const vcsProcess = yield* VcsProcess.VcsProcess;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-scratch-repos-" });
        const cwd = path.join(home, "code");
        const write = Effect.fn(function* (relativePath: string) {
          yield* fs.makeDirectory(path.dirname(path.join(cwd, relativePath)), { recursive: true });
          yield* fs.writeFileString(path.join(cwd, relativePath), "");
        });
        const gitInit = (repository: string) =>
          vcsProcess.run({
            operation: "test.gitInit",
            command: "git",
            args: ["init"],
            cwd: path.join(cwd, repository),
          });
        for (const file of [
          "alpha/README.md",
          "alpha/secret.md",
          "beta/README.md",
          "beta/docs/README.md",
          "beta/.vendor/README.md",
          ".hidden/README.md",
          "plain/README.md",
          "notes.md",
        ]) {
          yield* write(file);
        }
        yield* fs.writeFileString(path.join(cwd, "alpha", ".gitignore"), "secret.md\n");
        for (const repository of ["alpha", "beta", ".hidden"]) yield* gitInit(repository);
        const index = yield* WorkspaceSearchIndex.make(cwd).pipe(
          Effect.provideService(HostProcess.HomeDirectory, home),
        );
        const paths = (query: string) =>
          index
            .search(query, 20, "file")
            .pipe(Effect.map((result) => result.entries.map((e) => e.path)));

        expect(yield* paths("readme.md")).toEqual([
          "beta/README.md",
          "alpha/README.md",
          "beta/docs/README.md",
        ]);
        expect(yield* paths("secret")).toEqual([]);
        expect(yield* paths("notes")).toEqual(["notes.md"]);
        // The listing stays the parent's own top level.
        expect((yield* index.list()).entries.map((entry) => entry.path)).toEqual([
          "alpha",
          "beta",
          "notes.md",
          "plain",
        ]);

        yield* write("gamma/README.md");
        yield* gitInit("gamma");
        expect(yield* paths("gamma")).toEqual(["gamma/README.md"]);
        yield* write("beta/CHANGES.md");
        expect(yield* paths("changes")).toEqual([]);
        yield* index.refresh();
        expect(yield* paths("changes")).toEqual(["beta/CHANGES.md"]);
      }),
    ).pipe(Effect.provide(testLayer)),
);

it.effect("keeps a shared scratch folder inside a repository to its own top level", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const vcsProcess = yield* VcsProcess.VcsProcess;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-scratch-in-repo-" });
      const cwd = path.join(home, "code");
      yield* fs.makeDirectory(path.join(cwd, "inner"), { recursive: true });
      yield* fs.writeFileString(path.join(cwd, "inner", "README.md"), "");
      yield* vcsProcess.run({
        operation: "test.gitInit",
        command: "git",
        args: ["init"],
        cwd: home,
      });
      yield* vcsProcess.run({
        operation: "test.gitInit",
        command: "git",
        args: ["init"],
        cwd: path.join(cwd, "inner"),
      });
      const index = yield* WorkspaceSearchIndex.make(cwd).pipe(
        Effect.provideService(HostProcess.HomeDirectory, home),
      );
      expect((yield* index.search("readme", 20, "file")).entries).toEqual([]);
    }),
  ).pipe(Effect.provide(testLayer)),
);

function fakeSymlinkFinder(
  directories: ReadonlyArray<string>,
  options: {
    readonly indexed?: ReadonlyArray<{
      readonly path: string;
      readonly kind: "file" | "directory";
    }>;
    readonly watchFailures?: number;
  } = {},
) {
  const watchers: Array<(events: ReadonlyArray<WatchEvent>) => void> = [];
  let watchFailures = options.watchFailures ?? 0;
  // fff's pageIndex is an offset into the results, not a page number.
  const directorySearch = vi.fn(
    async (_query: string, searchOptions?: { pageIndex?: number; pageSize?: number }) => {
      const offset = searchOptions?.pageIndex ?? 0;
      const items = directories.slice(offset, offset + (searchOptions?.pageSize ?? 100));
      return {
        ok: true as const,
        value: {
          items: items.map((relativePath) => ({ relativePath })),
          totalMatched: directories.length,
        },
      };
    },
  );
  const indexedItems = (options.indexed ?? []).map((entry) => ({
    type: entry.kind,
    item: { relativePath: entry.path, fileName: entry.path.split("/").at(-1) },
  }));
  const finder = {
    destroy: vi.fn(),
    waitForIndexReady: vi.fn(async () => ({ ok: true as const, value: true })),
    // fff's isScanning waits on the picker lock on the JS thread.
    isScanning: () => {
      throw new Error("isScanning must not run on the JS thread");
    },
    getScanProgressAsync: async () => ({
      ok: true as const,
      value: { isScanning: false },
    }),
    // fff's watch waits on the picker lock on the JS thread.
    watch: () => {
      throw new Error("watch must not run on the JS thread");
    },
    watchAsync: async (callback: (events: ReadonlyArray<WatchEvent>) => void) => {
      if (watchFailures > 0) {
        watchFailures -= 1;
        return { ok: false as const, error: "File system watcher is not ready" };
      }
      watchers.push(callback);
      return { ok: true as const, value: () => undefined };
    },
    directorySearchAsync: directorySearch,
    fileSearchAsync: async () => {
      const items = indexedItems.flatMap((entry) => (entry.type === "file" ? [entry.item] : []));
      return { ok: true as const, value: { items, scores: [], totalMatched: items.length } };
    },
    mixedSearchAsync: async () => ({
      ok: true as const,
      value: { items: indexedItems, totalMatched: indexedItems.length },
    }),
  } as unknown as FileFinder;
  vi.spyOn(FileFinder, "create").mockReturnValueOnce({ ok: true, value: finder });
  return {
    directorySearch,
    notifyWatchers: (events: ReadonlyArray<WatchEvent>) =>
      watchers.forEach((watcher) => watcher(events)),
  };
}

const listedPaths = (searchIndex: WorkspaceSearchIndex.WorkspaceSearchIndex["Service"]) =>
  searchIndex.list().pipe(Effect.map((result) => result.entries.map((entry) => entry.path)));

it.effect("reads symlinks again after the watcher reports a change", () =>
  Effect.scoped(
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) === "win32") return;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-symlink-watch-" });
      const outside = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-outside-" });
      yield* fileSystem.writeFileString(path.join(cwd, "a.ts"), "");
      yield* fileSystem.symlink("a.ts", path.join(cwd, "old-link.ts"));
      const { directorySearch, notifyWatchers } = fakeSymlinkFinder([]);

      const searchIndex = yield* WorkspaceSearchIndex.make(cwd);
      const concurrent = yield* Effect.all(
        Array.from({ length: 8 }, () => listedPaths(searchIndex)),
        { concurrency: "unbounded" },
      );
      yield* fileSystem.remove(path.join(cwd, "old-link.ts"));
      yield* fileSystem.symlink("a.ts", path.join(cwd, "new-link.ts"));
      const beforeNotice = yield* listedPaths(searchIndex);
      // Editing a file cannot move a link, so it does not cost a rescan.
      notifyWatchers([{ kind: "modified", path: path.join(cwd, "a.ts") }]);
      const afterEdit = yield* listedPaths(searchIndex);
      notifyWatchers([{ kind: "created", path: path.join(cwd, "new-link.ts") }]);
      const afterNotice = yield* listedPaths(searchIndex);
      // fff reports a link replaced in place as modified.
      yield* fileSystem.remove(path.join(cwd, "new-link.ts"));
      yield* fileSystem.symlink(outside, path.join(cwd, "new-link.ts"));
      notifyWatchers([{ kind: "modified", path: path.join(cwd, "new-link.ts") }]);
      const afterReplace = yield* listedPaths(searchIndex);

      expect(concurrent).toEqual(Array.from({ length: 8 }, () => ["old-link.ts"]));
      expect(beforeNotice).toEqual(["old-link.ts"]);
      expect(afterEdit).toEqual(["old-link.ts"]);
      expect(afterNotice).toEqual(["new-link.ts"]);
      expect(afterReplace).toEqual([]);
      expect(directorySearch).toHaveBeenCalledTimes(3);
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("answers from the last symlink scan while a slow rescan runs", () =>
  Effect.scoped(
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) === "win32") return;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-symlink-stale-" });
      yield* fileSystem.writeFileString(path.join(cwd, "a.ts"), "");
      yield* fileSystem.symlink("a.ts", path.join(cwd, "old-link.ts"));
      const { notifyWatchers } = fakeSymlinkFinder([]);
      // Holding git's ignore check open keeps the rescan from finishing.
      const gate = yield* Deferred.make<void>();
      let holdIgnoreChecks = false;
      const vcsProcess = yield* VcsProcess.VcsProcess;
      const searchIndex = yield* WorkspaceSearchIndex.make(cwd).pipe(
        Effect.provideService(VcsProcess.VcsProcess, {
          ...vcsProcess,
          run: (input) =>
            holdIgnoreChecks && input.operation === "WorkspaceSearchIndex.listGitIgnored"
              ? Deferred.await(gate).pipe(Effect.andThen(vcsProcess.run(input)))
              : vcsProcess.run(input),
        }),
      );
      expect(yield* listedPaths(searchIndex)).toEqual(["old-link.ts"]);

      holdIgnoreChecks = true;
      yield* fileSystem.symlink("a.ts", path.join(cwd, "new-link.ts"));
      notifyWatchers([{ kind: "created", path: path.join(cwd, "new-link.ts") }]);
      const duringRescan = yield* Effect.forkChild(listedPaths(searchIndex));
      yield* TestClock.adjust("1 second");
      expect(yield* Fiber.join(duringRescan)).toEqual(["old-link.ts"]);

      yield* Deferred.succeed(gate, undefined);
      expect(yield* listedPaths(searchIndex)).toEqual(["new-link.ts", "old-link.ts"]);
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("keeps symlinks once the watcher subscribes after starting late", () =>
  Effect.scoped(
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) === "win32") return;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-symlink-watch-" });
      yield* fileSystem.writeFileString(path.join(cwd, "a.ts"), "");
      yield* fileSystem.symlink("a.ts", path.join(cwd, "link.ts"));
      const { directorySearch } = fakeSymlinkFinder([], { watchFailures: 2 });

      const searchIndex = yield* WorkspaceSearchIndex.make(cwd);
      const scansAfterRound: number[] = [];
      for (let round = 0; round < 5; round += 1) {
        expect(yield* listedPaths(searchIndex)).toEqual(["link.ts"]);
        expect(yield* listedPaths(searchIndex)).toEqual(["link.ts"]);
        scansAfterRound.push(directorySearch.mock.calls.length);
        yield* TestClock.adjust("1 minute");
      }

      // An unwatched scan serves reads only briefly; the third has a watcher and is kept.
      expect(scansAfterRound).toEqual([1, 2, 3, 3, 3]);
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect(
  "lists a symlink the watcher indexed once, with the link's kind, and drops rejected ones",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        if ((yield* HostProcess.Platform) === "win32") return;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-symlink-dupe-" });
        const outside = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-outside-" });
        yield* fileSystem.makeDirectory(path.join(cwd, "src"));
        yield* fileSystem.symlink("src", path.join(cwd, "src-link"));
        // A link the scan rejects stays out even when the watcher indexed it.
        yield* fileSystem.symlink(outside, path.join(cwd, "outside-link"));
        fakeSymlinkFinder([], {
          indexed: [
            { path: "outside-link", kind: "file" },
            { path: "src-link", kind: "file" },
            { path: "link-file.ts", kind: "file" },
          ],
        });

        const searchIndex = yield* WorkspaceSearchIndex.make(cwd);
        const searched = yield* searchIndex.search("link", 10);
        const files = yield* searchIndex.search("link", 1, "file");
        const listed = yield* searchIndex.list();

        expect(searched.entries).toEqual([
          { path: "src-link", kind: "directory" },
          { path: "link-file.ts", kind: "file" },
        ]);
        // The dropped link does not take the only slot.
        expect(files).toEqual({
          entries: [{ path: "link-file.ts", kind: "file" }],
          truncated: false,
        });
        expect(listed.entries).toEqual([
          { path: "link-file.ts", kind: "file" },
          { path: "src-link", kind: "directory" },
        ]);
      }),
    ).pipe(Effect.provide(testLayer)),
);

it.effect("finds symlinks in folders past the first page of the index", () =>
  Effect.scoped(
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) === "win32") return;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-symlink-pages-" });
      yield* fileSystem.makeDirectory(path.join(cwd, "late"));
      yield* fileSystem.writeFileString(path.join(cwd, "late/a.ts"), "");
      yield* fileSystem.symlink("a.ts", path.join(cwd, "late/link.ts"));
      // Folders fff lists but that are gone by the time they are read are skipped.
      const firstPage = Array.from({ length: 1_000 }, (_, index) => `missing-${index}`);
      const { directorySearch } = fakeSymlinkFinder([...firstPage, "late"]);

      const searchIndex = yield* WorkspaceSearchIndex.make(cwd);

      expect(yield* listedPaths(searchIndex)).toEqual(["late", "late/link.ts"]);
      expect(directorySearch.mock.calls.map(([, options]) => options?.pageIndex)).toEqual([
        0, 1_000,
      ]);
    }),
  ).pipe(Effect.provide(testLayer)),
);

// fff reads HOME on Linux and macOS but the user profile on Windows, so a temp HOME cannot stand in there.
it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "refuses to index a workspace rooted at the home directory",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ prefix: "t3-search-home-" }),
        );
        yield* fs.makeDirectory(path.join(home, "OneDrive", "Remix"), { recursive: true });
        yield* fs.writeFileString(path.join(home, "OneDrive", "Remix", "part.stl"), "solid part\n");
        yield* Effect.acquireRelease(
          Effect.sync(() => vi.stubEnv("HOME", home)),
          () => Effect.sync(() => vi.unstubAllEnvs()),
        );

        const result = yield* WorkspaceSearchIndex.make(home).pipe(
          Effect.flatMap((searchIndex) => searchIndex.search("stl", 50, undefined, false)),
          Effect.map(({ entries }) => entries),
          Effect.catchTags({
            WorkspaceSearchIndexCreateFailed: (error) => Effect.succeed(error._tag),
          }),
        );

        expect(result).toBe("WorkspaceSearchIndexCreateFailed");
      }),
    ).pipe(Effect.provide(testLayer)),
);

it("lists only the repository files that can be opened", () => {
  const record = (tag: string, mode: string, path: string) =>
    `${tag} ${mode} 0123456789abcdef0123456789abcdef01234567 0\t${path}`;
  const stdout = [
    record("H", "100644", "README.md"),
    record("H", "100644", "gone.md"),
    record("R", "100644", "gone.md"),
    record("S", "100644", "sparse.md"),
    record("H", "160000", "vendor-module"),
    record("H", "100644", ".repos/effect/index.ts"),
    "? untracked.md",
    "? nested/",
    "",
  ].join("\0");
  expect(WorkspaceSearchIndex.parseRepositoryFileRecords(stdout, 10)).toEqual({
    paths: ["README.md", "untracked.md"],
    truncated: false,
  });
  expect(WorkspaceSearchIndex.parseRepositoryFileRecords(stdout, 1)).toEqual({
    paths: ["README.md"],
    truncated: true,
  });
});

it.effect("skips child folders whose repository lives outside the shared scratch folder", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const vcsProcess = yield* VcsProcess.VcsProcess;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-scratch-escape-" });
      const cwd = path.join(home, "code");
      const outside = path.join(home, "outside");
      const git = (dir: string, ...args: ReadonlyArray<string>) =>
        vcsProcess.run({ operation: "test.git", command: "git", args, cwd: dir });
      yield* fs.makeDirectory(path.join(cwd, "own"), { recursive: true });
      yield* fs.makeDirectory(path.join(cwd, "borrowed"), { recursive: true });
      yield* fs.makeDirectory(outside, { recursive: true });
      yield* fs.writeFileString(path.join(cwd, "own", "README.md"), "");
      yield* fs.writeFileString(path.join(outside, "README.md"), "");
      yield* git(path.join(cwd, "own"), "init");
      yield* git(outside, "init");
      // Its `.git` file points at a repository whose worktree is elsewhere.
      yield* git(outside, "config", "core.worktree", outside);
      yield* fs.writeFileString(
        path.join(cwd, "borrowed", ".git"),
        `gitdir: ${path.join(outside, ".git")}\n`,
      );
      // A link to a repository outside the parent is no child of it.
      yield* fs.symlink(outside, path.join(cwd, "linked"));
      const index = yield* WorkspaceSearchIndex.make(cwd).pipe(
        Effect.provideService(HostProcess.HomeDirectory, home),
      );
      expect(
        (yield* index.search("readme", 20, "file")).entries.map((entry) => entry.path),
      ).toEqual(["own/README.md"]);
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("leaves deleted files, gitlinks and nested repositories out of a child repository", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const vcsProcess = yield* VcsProcess.VcsProcess;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-scratch-openable-" });
      const repo = path.join(home, "code", "repo");
      const git = (...args: ReadonlyArray<string>) =>
        vcsProcess.run({ operation: "test.git", command: "git", args, cwd: repo });
      yield* fs.makeDirectory(path.join(repo, "nested"), { recursive: true });
      for (const file of ["kept.md", "gone.md", "nested/inner.md"]) {
        yield* fs.writeFileString(path.join(repo, file), "");
      }
      yield* git("init");
      yield* vcsProcess.run({
        operation: "test.git",
        command: "git",
        args: ["init"],
        cwd: path.join(repo, "nested"),
      });
      yield* git("add", "kept.md", "gone.md");
      yield* git(
        "update-index",
        "--add",
        "--cacheinfo",
        "160000,0123456789abcdef0123456789abcdef01234567,module.md",
      );
      yield* git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "files");
      yield* fs.remove(path.join(repo, "gone.md"));
      const index = yield* WorkspaceSearchIndex.make(path.join(home, "code")).pipe(
        Effect.provideService(HostProcess.HomeDirectory, home),
      );
      expect((yield* index.search(".md", 20, "file")).entries.map((entry) => entry.path)).toEqual([
        "repo/kept.md",
      ]);
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("rebuilds a shared scratch folder's repository list once for concurrent searches", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-scratch-single-flight-" });
      const repo = path.join(home, "code", "repo");
      yield* fs.makeDirectory(repo, { recursive: true });
      yield* fs.writeFileString(path.join(repo, "README.md"), "");
      const vcsProcess = yield* VcsProcess.VcsProcess;
      yield* vcsProcess.run({ operation: "test.git", command: "git", args: ["init"], cwd: repo });
      let listings = 0;
      const counting = VcsProcess.VcsProcess.of({
        ...vcsProcess,
        run: (input) => {
          if (input.operation === "WorkspaceSearchIndex.listRepositoryFiles") listings += 1;
          return vcsProcess.run(input);
        },
      });
      const index = yield* WorkspaceSearchIndex.make(path.join(home, "code")).pipe(
        Effect.provideService(HostProcess.HomeDirectory, home),
        Effect.provideService(VcsProcess.VcsProcess, counting),
      );
      const results = yield* Effect.all(
        Array.from({ length: 4 }, () => index.search("readme", 20, "file")),
        { concurrency: "unbounded" },
      );
      expect(results.map((result) => result.entries.length)).toEqual([1, 1, 1, 1]);
      expect(listings).toBe(1);
    }),
  ).pipe(Effect.provide(testLayer)),
);

const slowListingFixture = Effect.fn(function* (prefix: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcsProcess = yield* VcsProcess.VcsProcess;
  const home = yield* fs.makeTempDirectoryScoped({ prefix });
  const cwd = path.join(home, "code");
  const addRepository = Effect.fn(function* (name: string) {
    yield* fs.makeDirectory(path.join(cwd, name), { recursive: true });
    yield* fs.writeFileString(path.join(cwd, name, "README.md"), "");
    yield* vcsProcess.run({
      operation: "test.gitInit",
      command: "git",
      args: ["init"],
      cwd: path.join(cwd, name),
    });
  });
  yield* addRepository("first");
  const started = yield* Deferred.make<void>();
  const gate = yield* Deferred.make<void>();
  const slow = VcsProcess.VcsProcess.of({
    ...vcsProcess,
    run: (input) =>
      input.operation === "WorkspaceSearchIndex.listRepositoryFiles"
        ? Deferred.succeed(started, undefined).pipe(
            // A held listing still ends at its timeout, as the real runner's does.
            Effect.andThen(
              Deferred.await(gate).pipe(
                Effect.timeoutOrElse({
                  duration: input.timeoutMs ?? 10_000,
                  orElse: () =>
                    Effect.fail(
                      new VcsProcessTimeoutError({
                        operation: input.operation,
                        command: input.command,
                        cwd: input.cwd,
                        timeoutMs: input.timeoutMs ?? 10_000,
                      }),
                    ),
                }),
              ),
            ),
            Effect.andThen(vcsProcess.run(input)),
          )
        : vcsProcess.run(input),
  });
  const index = yield* WorkspaceSearchIndex.make(cwd).pipe(
    Effect.provideService(HostProcess.HomeDirectory, home),
    Effect.provideService(VcsProcess.VcsProcess, slow),
  );
  return { index, started };
});

it.effect("keeps the paths a listing read before its output cap", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const vcsProcess = yield* VcsProcess.VcsProcess;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-capped-listing-" });
      const repo = path.join(cwd, "repo");
      // Records this long fill the output cap before the entry limit is reached.
      const folder = ["a", "b", "c"].map((letter) => letter.repeat(230)).join("/");
      yield* fs.makeDirectory(path.join(repo, folder), { recursive: true });
      for (let file = 0; file < 8; file++) {
        yield* fs.writeFileString(path.join(repo, folder, `${file}.md`), "");
      }
      yield* vcsProcess.run({
        operation: "test.gitInit",
        command: "git",
        args: ["init"],
        cwd: repo,
      });
      const listed = yield* WorkspaceSearchIndex.listRepositoryFiles(
        vcsProcess,
        cwd,
        "repo",
        false,
        3,
        10_000,
      );
      expect(listed.truncated).toBe(true);
      expect(listed.paths.length).toBeGreaterThan(0);
      for (const listedPath of listed.paths) {
        expect(listedPath).toMatch(new RegExp(`^repo/${folder}/\\d\\.md$`));
      }
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.live("keeps the records a listing printed before it timed out", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const vcsProcess = yield* VcsProcess.VcsProcess;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-timed-out-listing-" });
      yield* fs.makeDirectory(path.join(cwd, "repo"));
      // Prints past the output cap, then stays open past the timeout.
      const records = Array.from({ length: 300 }, (_, index) => `? file${index}.md`).join("\\0");
      const stalling = VcsProcess.VcsProcess.of({
        ...vcsProcess,
        run: (input) =>
          vcsProcess.run({
            ...input,
            command: "sh",
            args: ["-c", `printf '${records}\\0'; sleep 30`],
          }),
      });
      const listed = yield* WorkspaceSearchIndex.listRepositoryFiles(
        stalling,
        cwd,
        "repo",
        false,
        4,
        500,
      );
      expect(listed).toEqual({
        paths: ["repo/file0.md", "repo/file1.md", "repo/file2.md", "repo/file3.md"],
        truncated: true,
      });
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.live("runs one repository listing at a time across refreshes and searches", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const vcsProcess = yield* VcsProcess.VcsProcess;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-scratch-one-listing-" });
      const repo = path.join(home, "code", "repo");
      yield* fs.makeDirectory(repo, { recursive: true });
      yield* fs.writeFileString(path.join(repo, "README.md"), "");
      yield* vcsProcess.run({
        operation: "test.gitInit",
        command: "git",
        args: ["init"],
        cwd: repo,
      });
      const started = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      let running = 0;
      let mostRunning = 0;
      const blocking = VcsProcess.VcsProcess.of({
        ...vcsProcess,
        run: (input) =>
          input.operation === "WorkspaceSearchIndex.listRepositoryFiles"
            ? Effect.sync(() => {
                running += 1;
                mostRunning = Math.max(mostRunning, running);
              }).pipe(
                Effect.andThen(Deferred.succeed(started, undefined)),
                Effect.andThen(Deferred.await(gate)),
                Effect.andThen(vcsProcess.run(input)),
                Effect.ensuring(Effect.sync(() => (running -= 1))),
              )
            : vcsProcess.run(input),
      });
      const index = yield* WorkspaceSearchIndex.make(path.join(home, "code")).pipe(
        Effect.provideService(HostProcess.HomeDirectory, home),
        Effect.provideService(VcsProcess.VcsProcess, blocking),
      );
      const search = Effect.forkChild(index.search("readme", 20, "file"));
      const searches = [yield* search];
      yield* Deferred.await(started);
      for (let round = 0; round < 3; round++) {
        yield* index.refresh();
        searches.push(yield* search);
      }
      yield* Deferred.succeed(gate, undefined);
      for (const fiber of searches) {
        expect((yield* Fiber.join(fiber)).entries.map((entry) => entry.path)).toEqual([
          "repo/README.md",
        ]);
      }
      expect(mostRunning).toBe(1);
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.live("shares one rebuild among concurrent searches and rebuilds after a refresh", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const vcsProcess = yield* VcsProcess.VcsProcess;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-scratch-shared-" });
      const repo = path.join(home, "code", "repo");
      yield* fs.makeDirectory(repo, { recursive: true });
      yield* fs.writeFileString(path.join(repo, "README.md"), "");
      yield* vcsProcess.run({
        operation: "test.gitInit",
        command: "git",
        args: ["init"],
        cwd: repo,
      });
      let listings = 0;
      const counting = VcsProcess.VcsProcess.of({
        ...vcsProcess,
        run: (input) => {
          if (input.operation === "WorkspaceSearchIndex.listRepositoryFiles") listings += 1;
          return vcsProcess.run(input);
        },
      });
      const index = yield* WorkspaceSearchIndex.make(path.join(home, "code")).pipe(
        Effect.provideService(HostProcess.HomeDirectory, home),
        Effect.provideService(VcsProcess.VcsProcess, counting),
      );
      const paths = index
        .search("md", 20, "file")
        .pipe(Effect.map((result) => result.entries.map((entry) => entry.path)));
      expect(
        yield* Effect.all(
          Array.from({ length: 4 }, () => paths),
          { concurrency: "unbounded" },
        ),
      ).toEqual(Array.from({ length: 4 }, () => ["repo/README.md"]));
      expect(listings).toBe(1);

      yield* fs.writeFileString(path.join(repo, "NOTES.md"), "");
      yield* index.refresh();
      expect(yield* paths).toEqual(["repo/NOTES.md", "repo/README.md"]);
      expect(listings).toBe(2);
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("ends a rebuild at its deadline and marks the result truncated", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* slowListingFixture("t3-scratch-deadline-");
      const search = yield* Effect.forkChild(fixture.index.search("readme", 20, "file"));
      yield* Deferred.await(fixture.started);
      yield* TestClock.adjust("15 seconds");
      expect(yield* Fiber.join(search)).toEqual({ entries: [], truncated: true });
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect.each(["repo ", "repo\r"])("keeps a child repository named %j as it is", (name) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const vcsProcess = yield* VcsProcess.VcsProcess;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-scratch-space-" });
      const repo = path.join(home, "code", name);
      yield* fs.makeDirectory(repo, { recursive: true });
      yield* fs.writeFileString(path.join(repo, "README.md"), "");
      yield* vcsProcess.run({
        operation: "test.gitInit",
        command: "git",
        args: ["init"],
        cwd: repo,
      });
      const index = yield* WorkspaceSearchIndex.make(path.join(home, "code")).pipe(
        Effect.provideService(HostProcess.HomeDirectory, home),
      );
      expect(
        (yield* index.search("readme", 20, "file")).entries.map((entry) => entry.path),
      ).toEqual([`${name}/README.md`]);
    }),
  ).pipe(Effect.provide(testLayer)),
);
