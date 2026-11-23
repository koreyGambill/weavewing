import { isHostPath } from "@t3tools/shared/path";

import { formatWorkspaceRelativePath } from "../filePathDisplay";
import { markdownFileLinkSources } from "../markdown-links";

export interface FileLinkRange {
  readonly line: number;
  readonly endLine?: number;
}

export interface ConversationFileLink {
  /** The resolved path every link to this file shares. */
  readonly filePath: string;
  /** What the file tile opens: workspace-relative inside the workspace, else the host path. */
  readonly panelPath: string;
  readonly displayPath: string;
  readonly basename: string;
  /** Distinct cited ranges in line order. */
  readonly ranges: ReadonlyArray<FileLinkRange>;
}

interface MessageFileLink {
  readonly filePath: string;
  readonly panelPath: string;
  readonly displayPath: string;
  readonly basename: string;
  readonly range: FileLinkRange | null;
}

// Turn items keep their identity until they change, so each message is parsed once per cwd.
const messageLinksCache = new WeakMap<
  object,
  { readonly cwd: string | undefined; readonly links: ReadonlyArray<MessageFileLink> }
>();

function messageFileLinks(
  message: { readonly text: string },
  cwd: string | undefined,
): ReadonlyArray<MessageFileLink> {
  const cached = messageLinksCache.get(message);
  if (cached !== undefined && cached.cwd === cwd) return cached.links;
  const { hrefs, spans } = markdownFileLinkSources(message.text, cwd);
  const links = [...hrefs, ...spans].flatMap(({ meta }): MessageFileLink[] => {
    const panelPath =
      meta.workspaceRelativePath ?? (isHostPath(meta.filePath) ? meta.filePath : null);
    if (panelPath === null) return [];
    return [
      {
        filePath: meta.filePath,
        panelPath,
        displayPath: formatWorkspaceRelativePath(meta.filePath, cwd),
        basename: meta.basename,
        range:
          meta.line === undefined
            ? null
            : { line: meta.line, ...(meta.endLine === undefined ? {} : { endLine: meta.endLine }) },
      },
    ];
  });
  messageLinksCache.set(message, { cwd, links });
  return links;
}

/**
 * Files the conversation links to, one entry per resolved path, the most recently linked first.
 * `messages` runs oldest to newest, as the timeline does.
 */
export function conversationFileLinks(
  messages: ReadonlyArray<{ readonly text: string }>,
  cwd: string | undefined,
): ConversationFileLink[] {
  const byPath = new Map<
    string,
    { link: MessageFileLink; ranges: Map<string, FileLinkRange>; recency: number }
  >();
  messages.forEach((message, index) => {
    for (const link of messageFileLinks(message, cwd)) {
      const entry = byPath.get(link.filePath) ?? {
        link,
        ranges: new Map<string, FileLinkRange>(),
        recency: index,
      };
      entry.recency = index;
      if (link.range) {
        entry.ranges.set(`${link.range.line}-${link.range.endLine ?? ""}`, link.range);
      }
      byPath.set(link.filePath, entry);
    }
  });
  return [...byPath.values()]
    .toSorted((left, right) => right.recency - left.recency)
    .map(({ link, ranges }) => ({
      filePath: link.filePath,
      panelPath: link.panelPath,
      displayPath: link.displayPath,
      basename: link.basename,
      ranges: [...ranges.values()].toSorted(
        (left, right) => left.line - right.line || (left.endLine ?? 0) - (right.endLine ?? 0),
      ),
    }));
}

export function formatFileLinkRange(range: FileLinkRange): string {
  return range.endLine === undefined ? `${range.line}` : `${range.line}-${range.endLine}`;
}
