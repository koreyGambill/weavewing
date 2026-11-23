import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";
import { isAbsolutePath } from "@t3tools/shared/path";

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
