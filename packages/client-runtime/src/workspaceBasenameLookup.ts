import { FILESYSTEM_METADATA_BATCH_LIMIT } from "@t3tools/contracts";
import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";
import {
  isAbsolutePath,
  isWindowsAbsolutePath,
  resolveWorkspaceFilePath,
} from "@t3tools/shared/path";

const POSITION_SUFFIX = /:\d+(?::\d+|-\d+)?$/;

/** The position an agent wrote after a link's path (`:12`, `:4-8`, `#L4-L8`), exactly as written. */
export function authoredFileLinkSuffix(authored: string): string {
  const end = authored.search(/[?#]/);
  const beforeQuery = end === -1 ? authored : authored.slice(0, end);
  const position = beforeQuery.match(POSITION_SUFFIX)?.[0] ?? "";
  return position + (end === -1 ? "" : authored.slice(end));
}

/**
 * What a chat file link shows. A relative link shows its absolute path only once a read found a
 * file there; until then, and for absolute links, it shows exactly what the agent wrote.
 */
export function fileLinkShownPath(authored: string, verifiedPath: string | null): string {
  return verifiedPath === null ? authored : verifiedPath + authoredFileLinkSuffix(authored);
}

/**
 * The absolute path a relative link names when a fresh read finds a file there, else null.
 * Absolute links are never read: they open as written.
 */
export async function verifyRelativeFileLink(input: {
  readonly linkPath: string;
  readonly root: string;
  readonly kindOf: (path: string) => Promise<"file" | "directory" | "other" | null>;
}): Promise<string | null> {
  const { linkPath, root } = input;
  if (isAbsolutePath(linkPath) || /^~(?:[\\/]|$)/.test(linkPath)) return null;
  const literal = resolvePathLinkTarget(linkPath, root);
  const kind = await input.kindOf(literal).catch(() => null);
  return kind === "file" ? literal : null;
}

export interface FileLinkCandidate {
  readonly path: string;
  /** The candidate ends with the link's whole path, not just its file name. */
  readonly matchesPath: boolean;
  /** Under a dependency, build, cache or dot folder, or ignored by git: listed only on request. */
  readonly hidden: boolean;
}

const NOISE_FOLDERS = new Set([
  "node_modules",
  ".git",
  "vendor",
  "dist",
  "build",
  ".next",
  ".venv",
  "target",
  ".cache",
]);

/** Whether a search hit, by its path under the searched root, is dependency or generated noise. */
export function isNoisyFileLinkMatch(rootRelativePath: string, ignored: boolean): boolean {
  if (ignored) return true;
  const folders = rootRelativePath.split(/[\\/]/).slice(0, -1);
  return folders.some((folder) => folder.startsWith(".") || NOISE_FOLDERS.has(folder));
}

/**
 * The candidates the picker lists for `query`, a case-insensitive substring of the path. Hidden
 * candidates are counted, and listed only when `showHidden` is set.
 */
export function filterFileLinkCandidates(
  candidates: ReadonlyArray<FileLinkCandidate>,
  query: string,
  showHidden: boolean,
): { readonly listed: ReadonlyArray<FileLinkCandidate>; readonly hiddenCount: number } {
  const needle = query.trim().toLowerCase();
  const matching = needle
    ? candidates.filter((candidate) => candidate.path.toLowerCase().includes(needle))
    : candidates;
  const hiddenCount = matching.filter((candidate) => candidate.hidden).length;
  return {
    listed: showHidden ? matching : matching.filter((candidate) => !candidate.hidden),
    hiddenCount,
  };
}

const FIND_LIMIT = 100;

function basenameOfPath(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
}

/**
 * Every file across `roots` named like a missing link's file, for the user to pick from. Matches
 * on the whole path come first, then shallower files. `complete` is false when any search failed or was cut off.
 */
export async function findFileLinkCandidates(input: {
  readonly linkPath: string;
  readonly roots: ReadonlyArray<string>;
  readonly search: (
    root: string,
    query: string,
    limit: number,
  ) => Promise<{
    readonly entries: ReadonlyArray<{
      readonly path: string;
      readonly kind: string;
      readonly ignored?: boolean | undefined;
    }>;
    readonly truncated: boolean;
  } | null>;
}): Promise<{ readonly candidates: ReadonlyArray<FileLinkCandidate>; readonly complete: boolean }> {
  const linkPath = input.linkPath.replaceAll("\\", "/").replace(/^(?:\.\/)+/, "");
  const basename = basenameOfPath(linkPath);
  const hasFolders = linkPath.includes("/");
  const roots = [...new Set(input.roots)];
  const results = await Promise.all(
    roots.map((root) => input.search(root, basename, FIND_LIMIT).catch(() => null)),
  );
  const byPath = new Map<string, FileLinkCandidate>();
  for (const [index, result] of results.entries()) {
    for (const entry of result?.entries ?? []) {
      if (entry.kind !== "file" || basenameOfPath(entry.path) !== basename) continue;
      const path = resolveWorkspaceFilePath(entry.path, roots[index]!);
      const slashed = path.replaceAll("\\", "/");
      const matchesPath = hasFolders && slashed.endsWith(`/${linkPath}`);
      const hidden = isNoisyFileLinkMatch(entry.path, entry.ignored === true);
      const seen = byPath.get(path);
      // Two roots can reach one file; it stays listed when any root sees it outside the noise.
      byPath.set(path, {
        path,
        matchesPath: matchesPath || seen?.matchesPath === true,
        hidden: hidden && (seen?.hidden ?? true),
      });
    }
  }
  const depth = (path: string) => path.split(/[\\/]/).length;
  const candidates = [...byPath.values()].sort(
    (left, right) =>
      Number(left.hidden) - Number(right.hidden) ||
      Number(right.matchesPath) - Number(left.matchesPath) ||
      depth(left.path) - depth(right.path) ||
      left.path.localeCompare(right.path),
  );
  return {
    candidates,
    complete: results.every((result) => result !== null && !result.truncated),
  };
}

// A quoted string or a comment is one token, so `cd` inside either is not read as a command.
const SHELL_TOKEN = /(?<![^\s;&|()])#[^\n]*|"[^"]*"|'[^']*'|[;&|()\n]|[ \t]+|[^\s;&|()"']+/g;
const SHELL_NAME = /(?:^|\/)(?:ba|z|da)?sh$/;
const CD_OPTION = /^-[LPe@]*$|^--$/;

/** The operands of the `cd` commands in `script`, in order, through `sh -c "<script>"`. */
function cdOperands(script: string): Array<string> {
  const operands: Array<string> = [];
  let words: Array<string> = [];
  let wordOpen = false;
  const endCommand = () => {
    const [name = "", ...rest] = words;
    if (name === "cd") {
      const operand = rest.find((word) => !CD_OPTION.test(word));
      if (operand !== undefined) operands.push(operand);
    } else if (SHELL_NAME.test(name)) {
      const inner = rest[rest.findIndex((word) => /^-[a-z]*c$/.test(word)) + 1];
      if (inner !== undefined && /^(["']).*\1$/s.test(inner)) {
        operands.push(...cdOperands(inner.slice(1, -1)));
      }
    }
    words = [];
    wordOpen = false;
  };
  for (const [token] of script.matchAll(SHELL_TOKEN)) {
    // A here-document's body is data, and where it ends is the shell's to say.
    if (!/^["'#]/.test(token) && token.includes("<<")) break;
    if (/^[;&|()\n]/.test(token)) endCommand();
    else if (/^[ \t]/.test(token) || (!wordOpen && token.startsWith("#"))) wordOpen = false;
    else if (wordOpen) words[words.length - 1] += token;
    else {
      words.push(token);
      wordOpen = true;
    }
  }
  endCommand();
  return operands;
}

function literalDirectory(operand: string): string | null {
  const path = /^["']/.test(operand) ? operand.slice(1, -1) : operand;
  // The shell would expand these, and only it knows to what.
  if (!isAbsolutePath(path) || /[$`*?[\]{}"']/.test(path)) return null;
  return path.includes("\\") && !isWindowsAbsolutePath(path) ? null : path;
}

interface TimelineItemSource {
  readonly sourceThreadId: string;
  readonly sourceItemId: string;
}

/**
 * The folders the commands above `reply` in a thread's timeline changed into, the latest first.
 * A reply cites paths relative to where the agent worked, which no project has to be rooted at.
 * Rows below the reply, a fork's own commands under an inherited one included, came after it.
 */
export function agentWorkingDirectories(
  items: ReadonlyArray<
    TimelineItemSource & { readonly item: { readonly type: string; readonly input?: unknown } }
  >,
  reply: TimelineItemSource,
): ReadonlyArray<string> {
  const directories = new Set<string>();
  const replyIndex = items.findIndex(
    (row) => row.sourceThreadId === reply.sourceThreadId && row.sourceItemId === reply.sourceItemId,
  );
  for (let index = replyIndex - 1; index >= 0; index--) {
    const item = items[index]?.item;
    if (item?.type !== "command_execution" || typeof item.input !== "string") continue;
    for (const operand of cdOperands(item.input).reverse()) {
      const directory = literalDirectory(operand);
      if (directory !== null) directories.add(directory);
      if (directories.size === FILESYSTEM_METADATA_BATCH_LIMIT) return [...directories];
    }
  }
  return [...directories];
}
