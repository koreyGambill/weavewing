// @effect-diagnostics nodeBuiltinImport:off - opening with O_NONBLOCK and O_NOFOLLOW needs node:fs.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import {
  type DefaultContextItem,
  type InstructionFootprint,
  ThreadInsightsError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/** Where a provider documents its instruction files. Groups list alternatives: the first existing name wins. */
export interface FileConvention {
  readonly globals: (dirs: ProviderDirs) => ReadonlyArray<ReadonlyArray<string>>;
  readonly globalRuleDir?: (dirs: ProviderDirs) => string;
  /** `home`: cwd and its ancestors inside $HOME. `git`: git root down to cwd. */
  readonly walk: "home" | "git";
  readonly perDir: ReadonlyArray<ReadonlyArray<string>>;
  readonly ruleDir?: string;
  readonly imports?: boolean;
}

export interface ProviderDirs {
  readonly home: string;
  readonly platform: NodeJS.Platform;
  /** The provider's resolved config folder: Claude's config dir or Codex's home. */
  readonly configDir: string;
  /** Where T3 keeps thread checkouts, which sit under `~/.t3` yet are ordinary repositories. */
  readonly worktreesDir?: string;
}

export const FILE_CONVENTIONS: Readonly<Record<string, FileConvention>> = {
  claudeAgent: {
    globals: (dirs) => [
      [
        dirs.platform === "darwin"
          ? "/Library/Application Support/ClaudeCode/CLAUDE.md"
          : "/etc/claude-code/CLAUDE.md",
      ],
      [`${dirs.configDir}/CLAUDE.md`],
    ],
    globalRuleDir: (dirs) => `${dirs.configDir}/rules`,
    walk: "home",
    perDir: [["CLAUDE.md"], [".claude/CLAUDE.md"], ["CLAUDE.local.md"]],
    ruleDir: ".claude/rules",
    imports: true,
  },
  codex: {
    globals: (dirs) => [[`${dirs.configDir}/AGENTS.override.md`, `${dirs.configDir}/AGENTS.md`]],
    walk: "git",
    perDir: [["AGENTS.override.md", "AGENTS.md"]],
  },
};

const SECRET_NAME =
  /^\.?env(\..*|rc)?$|\.(pem|key|p12|pfx|keystore|kdbx)$|^id_|^\.?netrc$|^\.npmrc$|^\.pgpass$|^\.?credentials|^\.git-credentials$|^secrets?(\.|$)|^auth\.json$|^hosts\.ya?ml$|_history$/i;
/** Whether a file name looks like a credential, such as `.env`, `id_rsa` or `server.pem`. */
export const looksLikeSecretName = (name: string) => SECRET_NAME.test(name);
const SECRET_PATH = /\/\.(ssh|gnupg|aws|docker|kube|t3|git)\//;
const MAX_FILES = 64;
const MAX_IMPORT_DEPTH = 5;
const MAX_LINK_DEPTH = 2;
export const MAX_READ_BYTES = 256 * 1024;

export interface ResolvedFile {
  /** The documented path, before symlinks resolve. */
  readonly path: string;
  readonly realPath: string;
  /** `link`: a markdown link an agent reads on demand, so it never loads by default. */
  readonly scope: "global" | "project" | "rule" | "import" | "link";
  /** Inside the workspace's repository, whose root is the git root unless that is $HOME or above. */
  readonly repository: boolean;
  readonly bytes: number;
  readonly depth: number;
  readonly status: "expected" | "not-read" | "secret";
  /** The documented path of the file whose link reached this one. */
  readonly linkedFrom?: string;
}

const proseOf = (text: string) =>
  text.replace(/^(```|~~~)[\s\S]*?^\1/gm, "").replace(/`[^`\n]*`/g, "");

/** `@path` references outside code spans and fences, as Claude Code resolves imports. */
export function importReferences(text: string): ReadonlyArray<string> {
  const prose = proseOf(text);
  return [...prose.matchAll(/(?:^|\s)@((?:~\/|\.{1,2}\/|\/)?[\w.\-/]+)/g)].flatMap((match) =>
    match[1] === undefined || /^[.\-/]*$/.test(match[1]) ? [] : [match[1].replace(/\.+$/, "")],
  );
}

/** Local `.md` targets of inline and reference markdown links outside code, without anchors. */
export function markdownLinks(text: string): ReadonlyArray<string> {
  const prose = proseOf(text);
  const targets = [
    ...prose.matchAll(/\]\(\s*(?:<([^>\n]+)>|([^)\s]+))(?:\s+["'(][^)]*)?\)/g),
    ...prose.matchAll(/^\s{0,3}\[[^\]\n]+\]:\s*(?:<([^>\n]+)>|(\S+))/gm),
  ].flatMap((match) => {
    const target = (match[1] ?? match[2] ?? "").split("#")[0] ?? "";
    // Scheme-qualified targets are URLs, not files an agent opens.
    if (!/\.md$/i.test(target) || /^[a-z][\w+.-]*:/i.test(target)) return [];
    try {
      return [decodeURIComponent(target)];
    } catch {
      return [target];
    }
  });
  return [...new Set(targets)];
}

/** Reads at most MAX_READ_BYTES of a regular file, opened without following a symlink or blocking on a FIFO. */
export const HARD_LINKED_MESSAGE = "The file has other hard links, which may name a secret.";

/**
 * `singleLink` refuses a file with other hard links: one could name a credential from inside
 * the repository, where no symlink check sees it.
 */
export const readBounded = Effect.fn("DefaultContext.readBounded")(function* (
  realPath: string,
  options?: { readonly singleLink?: boolean },
) {
  return yield* Effect.acquireUseRelease(
    Effect.tryPromise({
      // Windows lacks both flags.
      try: () =>
        NodeFSP.open(
          realPath,
          NodeFS.constants.O_RDONLY |
            (NodeFS.constants.O_NONBLOCK ?? 0) |
            (NodeFS.constants.O_NOFOLLOW ?? 0),
        ),
      catch: (cause) => new ThreadInsightsError({ message: "Could not open the file.", cause }),
    }),
    (handle) =>
      Effect.tryPromise({
        try: async () => {
          const stat = await handle.stat();
          if (!stat.isFile()) throw new Error("Not a regular file.");
          if (options?.singleLink && stat.nlink !== 1) throw new Error(HARD_LINKED_MESSAGE);
          const buffer = Buffer.alloc(Math.min(stat.size, MAX_READ_BYTES));
          let offset = 0;
          while (offset < buffer.length) {
            const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
            if (bytesRead === 0) break;
            offset += bytesRead;
          }
          return buffer.subarray(0, offset).toString("utf8");
        },
        catch: (cause) =>
          new ThreadInsightsError({
            message:
              cause instanceof Error && cause.message === HARD_LINKED_MESSAGE
                ? HARD_LINKED_MESSAGE
                : "Could not read the file.",
            cause,
          }),
      }),
    (handle) => Effect.promise(() => handle.close()),
  );
});

/**
 * Resolves the files a provider documents loading for this cwd. Text is read only from the
 * repository (workspace and git root), the documented files themselves, and `.md` files a
 * user-owned instruction file imports. Anything else is listed by path and left unread.
 */
export const resolveInstructionFiles = Effect.fn("DefaultContext.resolveInstructionFiles")(
  function* (
    convention: FileConvention,
    cwd: string,
    dirs: ProviderDirs,
    isServerInternal: (file: string) => Effect.Effect<boolean>,
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const real = (file: string) => fs.realPath(file).pipe(Effect.orElseSucceed(() => file));
    const statOf = (file: string) =>
      fs.stat(file).pipe(
        Effect.map((info) => ({ type: info.type, size: Number(info.size) })),
        Effect.orElseSucceed(() => null),
      );
    const within = (root: string, file: string) => {
      const relative = path.relative(root, file);
      return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    };
    const home = yield* real(dirs.home);
    const workspace = yield* real(cwd);
    let gitRoot: string | null = null;
    for (let dir = workspace; ; dir = path.dirname(dir)) {
      if (yield* fs.exists(path.join(dir, ".git")).pipe(Effect.orElseSucceed(() => false))) {
        gitRoot = dir;
        break;
      }
      if (path.dirname(dir) === dir) break;
    }
    // $HOME or a folder above it is never the repository, even with a dotfiles ~/.git.
    const repo = [gitRoot, workspace].find((dir) => dir !== null && !within(dir, home)) ?? null;
    const inRepo = (file: string) => repo !== null && within(repo, file);
    // In a checkout T3 keeps under its worktrees folder only the checkout's own folders count,
    // since the path to it runs through `~/.t3`. Anywhere else the whole path counts.
    const t3Checkout =
      repo !== null && dirs.worktreesDir !== undefined && within(dirs.worktreesDir, repo);
    const blocked = (file: string) =>
      SECRET_NAME.test(path.basename(file)) ||
      SECRET_PATH.test(`${t3Checkout && inRepo(file) ? `/${path.relative(repo!, file)}` : file}/`);
    const readText = (file: string) => readBounded(file).pipe(Effect.orElseSucceed(() => ""));

    const files: ResolvedFile[] = [];
    const seen = new Set<string>();
    const trust = new Map<ResolvedFile, boolean>();
    let linkCount = 0;
    /** `trusted`: the file sits outside the repository, where the repository cannot plant it. */
    const add: (
      file: string,
      scope: ResolvedFile["scope"],
      depth: number,
      trusted: boolean,
      linkedFrom?: string,
    ) => Effect.Effect<boolean, never, never> = Effect.fnUntraced(
      function* (file, scope, depth, trusted, linkedFrom) {
        const info = yield* statOf(file);
        if (info === null) return false;
        const bytes = info.type === "File" ? info.size : 0;
        const resolved = yield* real(file);
        const link = linkedFrom !== undefined;
        if (seen.has(resolved) || (link ? linkCount : files.length) >= MAX_FILES) return true;
        seen.add(resolved);
        if (link) linkCount += 1;
        const status: ResolvedFile["status"] =
          blocked(file) || blocked(resolved) || (yield* isServerInternal(resolved))
            ? "secret"
            : info.type === "File" && (inRepo(resolved) || (trusted && resolved.endsWith(".md")))
              ? "expected"
              : "not-read";
        const entry: ResolvedFile = {
          path: file,
          realPath: resolved,
          scope,
          repository: inRepo(file),
          bytes,
          depth,
          status,
          ...(link ? { linkedFrom } : {}),
        };
        files.push(entry);
        trust.set(entry, trusted);
        if (!link && convention.imports && status === "expected" && depth < MAX_IMPORT_DEPTH) {
          for (const reference of importReferences(yield* readText(resolved))) {
            const target = reference.startsWith("~/")
              ? path.join(dirs.home, reference.slice(2))
              : path.resolve(path.dirname(file), reference);
            yield* add(target, "import", depth + 1, trusted && !inRepo(resolved));
          }
        }
        return true;
      },
    );
    // Claude Code skips rules scoped to `paths:` until a matching file is read.
    const addRules = Effect.fnUntraced(function* (dir: string, trusted: boolean) {
      if ((yield* statOf(dir))?.type !== "Directory") return;
      const names = yield* fs
        .readDirectory(dir, { recursive: true })
        .pipe(Effect.orElseSucceed(() => []));
      for (const name of names.filter((entry) => entry.endsWith(".md")).toSorted()) {
        const file = path.join(dir, name);
        const resolved = yield* real(file);
        const regular = (yield* statOf(resolved))?.type === "File";
        if (regular && !blocked(resolved) && (inRepo(resolved) || trusted)) {
          const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(yield* readText(resolved))?.[1];
          if (frontmatter !== undefined && /^paths\s*:/m.test(frontmatter)) continue;
        }
        yield* add(file, "rule", 0, trusted);
      }
    });

    for (const group of convention.globals(dirs)) {
      for (const file of group) if (yield* add(file, "global", 0, true)) break;
    }
    if (convention.globalRuleDir) yield* addRules(convention.globalRuleDir(dirs), true);

    const chain: string[] = [];
    for (let dir = workspace; ; dir = path.dirname(dir)) {
      chain.unshift(dir);
      const top =
        convention.walk === "git"
          ? dir === (gitRoot ?? workspace)
          : dir === home || !within(home, dir);
      if (top || path.dirname(dir) === dir) break;
    }
    for (const dir of chain) {
      for (const group of convention.perDir) {
        for (const name of group) {
          const file = path.join(dir, name);
          if (yield* add(file, "project", 0, !inRepo(dir))) break;
        }
      }
    }
    if (convention.ruleDir) yield* addRules(path.join(workspace, convention.ruleDir), false);

    // After every always-loaded file, so a link never claims a file the provider loads itself.
    const addLinks: (parent: ResolvedFile, depth: number) => Effect.Effect<void> =
      Effect.fnUntraced(function* (parent, depth) {
        const trusted = (trust.get(parent) ?? false) && !inRepo(parent.realPath);
        for (const reference of markdownLinks(yield* readText(parent.realPath))) {
          const target = reference.startsWith("~/")
            ? path.join(dirs.home, reference.slice(2))
            : path.resolve(path.dirname(parent.path), reference);
          const before = files.length;
          yield* add(target, "link", depth, trusted, parent.path);
          const child = files[before];
          if (child?.status === "expected" && depth < MAX_LINK_DEPTH)
            yield* addLinks(child, depth + 1);
        }
      });
    for (const file of files.filter((entry) => entry.status === "expected")) {
      yield* addLinks(file, 1);
    }
    return { files, cwd: workspace, insideHome: within(home, workspace) };
  },
);

export interface FileRow extends ResolvedFile {
  readonly loaded?: boolean;
  readonly unexpected?: boolean;
}

/** Marks expected files against the paths the provider reported loading last turn. */
export function reconcileFiles(
  files: ReadonlyArray<ResolvedFile>,
  sources: InstructionFootprint["instructionSources"],
): ReadonlyArray<FileRow> {
  if (sources === undefined) return files;
  const reported = new Set(sources.map((source) => source.path));
  const expected = new Set(files.flatMap((file) => [file.path, file.realPath]));
  return [
    ...files.map((file) => ({
      ...file,
      loaded: reported.has(file.path) || reported.has(file.realPath),
    })),
    ...sources
      .filter((source) => !expected.has(source.path))
      .map((source) => ({
        path: source.path,
        realPath: source.path,
        scope: "project" as const,
        repository: false,
        bytes: source.bytes ?? 0,
        depth: 0,
        status: "not-read" as const,
        unexpected: true,
      })),
  ];
}

export const fileStatus = (file: FileRow): NonNullable<DefaultContextItem["status"]> =>
  file.unexpected
    ? "unexpected"
    : file.status !== "expected"
      ? file.status
      : file.loaded === undefined
        ? "expected"
        : file.loaded
          ? "loaded"
          : "not-loaded";
