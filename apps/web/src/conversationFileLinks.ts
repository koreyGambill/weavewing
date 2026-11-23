import type { OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import {
  isHostPath,
  normalizeProjectPathForComparison,
  stripSlashPrefixedWindowsDrive,
} from "@t3tools/shared/path";

import { formatWorkspaceRelativePath } from "./filePathDisplay";
import { renderedMarkdownFileLinks } from "./markdown-links";

export interface FileLinkRange {
  readonly line: number;
  readonly endLine?: number;
}

export interface ConversationFileLink {
  /** Identifies the file across spellings: separators and case fold on Windows. */
  readonly key: string;
  /** The path as the most recent link resolved it. */
  readonly filePath: string;
  /** What the file tile opens: workspace-relative inside the workspace, else the host path. */
  readonly panelPath: string;
  readonly displayPath: string;
  readonly basename: string;
  /** Distinct cited ranges in line order. */
  readonly ranges: ReadonlyArray<FileLinkRange>;
}

export interface LinkableMessage {
  readonly type: "user_message" | "assistant_message";
  readonly text: string;
}

type TurnItem = OrchestrationV2ProjectedTurnItem["item"];

function isLinkableMessage(item: TurnItem): item is Extract<TurnItem, LinkableMessage> {
  return item.type === "user_message" || (item.type === "assistant_message" && !item.streaming);
}

/**
 * User messages and finished replies, oldest first. Returns `previous` while they are unchanged,
 * so streamed text and other turn items do not produce a new list.
 */
export function selectLinkableMessages(
  items: ReadonlyArray<{ readonly item: TurnItem }>,
  previous: ReadonlyArray<LinkableMessage>,
): ReadonlyArray<LinkableMessage> {
  const next: LinkableMessage[] = [];
  for (const { item } of items) if (isLinkableMessage(item)) next.push(item);
  return next.length === previous.length && next.every((message, i) => message === previous[i])
    ? previous
    : next;
}

function fileLinkKey(filePath: string): string {
  return normalizeProjectPathForComparison(stripSlashPrefixedWindowsDrive(filePath));
}

interface MessageFileLink {
  readonly key: string;
  readonly filePath: string;
  readonly panelPath: string;
  readonly displayPath: string;
  readonly basename: string;
  readonly range: FileLinkRange | null;
}

// Messages keep their identity until they change, so each is parsed once per cwd.
const messageLinksCache = new WeakMap<
  LinkableMessage,
  { readonly cwd: string | undefined; readonly links: ReadonlyArray<MessageFileLink> }
>();

function messageFileLinks(
  message: LinkableMessage,
  cwd: string | undefined,
): ReadonlyArray<MessageFileLink> {
  const cached = messageLinksCache.get(message);
  if (cached !== undefined && cached.cwd === cwd) return cached.links;
  const metas = renderedMarkdownFileLinks(message.text, cwd, {
    userMessage: message.type === "user_message",
  });
  const links = metas.flatMap((meta): MessageFileLink[] => {
    const panelPath =
      meta.workspaceRelativePath ?? (isHostPath(meta.filePath) ? meta.filePath : null);
    if (panelPath === null) return [];
    return [
      {
        key: fileLinkKey(meta.filePath),
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

const resultCache = new WeakMap<
  ReadonlyArray<LinkableMessage>,
  { readonly cwd: string | undefined; readonly files: ReadonlyArray<ConversationFileLink> }
>();

/**
 * Files the conversation links to, one entry per file, the most recently linked first. The
 * result is reused while `messages` is the same array, so pass a stable selection.
 */
export function conversationFileLinks(
  messages: ReadonlyArray<LinkableMessage>,
  cwd: string | undefined,
): ReadonlyArray<ConversationFileLink> {
  const cached = resultCache.get(messages);
  if (cached !== undefined && cached.cwd === cwd) return cached.files;
  const byKey = new Map<string, { link: MessageFileLink; ranges: Map<string, FileLinkRange> }>();
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    for (const link of messageFileLinks(messages[index]!, cwd)) {
      const entry = byKey.get(link.key) ?? { link, ranges: new Map<string, FileLinkRange>() };
      if (link.range) {
        entry.ranges.set(`${link.range.line}-${link.range.endLine ?? ""}`, link.range);
      }
      byKey.set(link.key, entry);
    }
  }
  const files = [...byKey.values()].map(({ link, ranges }) => ({
    key: link.key,
    filePath: link.filePath,
    panelPath: link.panelPath,
    displayPath: link.displayPath,
    basename: link.basename,
    ranges: [...ranges.values()].toSorted(
      (left, right) => left.line - right.line || (left.endLine ?? 0) - (right.endLine ?? 0),
    ),
  }));
  resultCache.set(messages, { cwd, files });
  return files;
}

export function formatFileLinkRange(range: FileLinkRange): string {
  return range.endLine === undefined ? `${range.line}` : `${range.line}-${range.endLine}`;
}
