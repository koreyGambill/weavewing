import {
  markdownDestinationHostPath,
  normalizeMarkdownLinkDestination,
} from "@t3tools/shared/markdownLinks";

import { isAbsolutePath } from "../files/filePath";

/** A link written as an absolute or `file:` path opens as written and is never probed first. */
export function isAbsoluteLinkDestination(href: string): boolean {
  const destination = normalizeMarkdownLinkDestination(href);
  if (/^file:/i.test(destination)) return true;
  const path = markdownDestinationHostPath(destination);
  return path !== null && isAbsolutePath(path);
}

/**
 * What a tap on a file link does. A relative link is read fresh on every tap: a file opens, and a
 * confirmed miss says so. A failed read opens the literal path, which shows its own error.
 */
export async function decideFileLinkTap(input: {
  readonly href: string;
  readonly fullPath: string | undefined;
  readonly canRead: boolean;
  readonly readKind: (path: string) => Promise<string | null>;
}): Promise<"open" | "missing"> {
  if (isAbsoluteLinkDestination(input.href) || !input.fullPath || !input.canRead) return "open";
  const kind = await input.readKind(input.fullPath).then(
    (value) => ({ value }),
    () => null,
  );
  if (kind === null) return "open";
  return kind.value === "file" ? "open" : "missing";
}

/**
 * Where a tapped media link opens: a folder named like media opens as a folder, anything else in
 * the preview. A relative link is read fresh on every tap; an absolute one opens as written.
 */
export async function decideMediaLinkTap(input: {
  readonly href: string;
  readonly mediaPath: string | null;
  readonly canRead: boolean;
  readonly readKind: (path: string) => Promise<string | null>;
}): Promise<"folder" | "preview"> {
  if (isAbsoluteLinkDestination(input.href) || input.mediaPath === null || !input.canRead) {
    return "preview";
  }
  const kind = await input.readKind(input.mediaPath).catch(() => null);
  return kind === "directory" ? "folder" : "preview";
}
