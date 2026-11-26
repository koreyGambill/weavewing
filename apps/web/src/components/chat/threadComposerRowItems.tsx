import type {
  EnvironmentId,
  MessageFollowUp,
  OrchestrationV2Subagent,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { BookmarkIcon, BotIcon, MessagesSquareIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { useThreadFollowUpList } from "../reviews/FollowUps";
import { orderBookmarks } from "../reviews/bookmarks.logic";
import { MenuItem, MenuItemDetail } from "../ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControl } from "./ComposerControl";
import { useComposerToolsRowItem } from "./ComposerToolsControl";
import { composerFloatingLayerProps } from "./composerEventScope";
import {
  type ComposerRowAgentsSummary,
  type ComposerRowItem,
  summarizeComposerRowAgents,
} from "./composerRowItems";
import { sideAreaDetailsRowItem } from "../sideAreaDetailsRowItem";
import { bookmarkListSummary, ThreadBookmarkList } from "./ThreadBookmarkList";
import { ThreadRelationshipsPanel } from "./ThreadRelationshipsControl";

const AGENT_DOT_CLASS: Record<ComposerRowAgentsSummary["tone"], string> = {
  working: "bg-success",
  failed: "bg-destructive",
  idle: "bg-muted-foreground/50",
};

function AgentsList(props: { environmentId: EnvironmentId; threadId: ThreadId }) {
  return (
    <ThreadRelationshipsPanel
      environmentId={props.environmentId}
      threadId={props.threadId}
      showLineage
      showSideChats
      empty={<p className="px-3 py-2 text-xs text-muted-foreground">No related threads yet.</p>}
    />
  );
}

function ComposerRowAgents(props: {
  summary: ComposerRowAgentsSummary;
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const [open, setOpen] = useState(false);
  const { summary } = props;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger render={<span className="flex" />}>
          <PopoverTrigger render={<ComposerControl size="xs" aria-label={summary.description} />}>
            <BotIcon />
            <span
              aria-hidden
              className={cn("size-1.5 rounded-full", AGENT_DOT_CLASS[summary.tone])}
            />
            <span aria-hidden className="tabular-nums">
              {summary.count}
              <span className="@max-md/composer-surface:hidden"> {summary.word}</span>
            </span>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipPopup>{summary.description}</TooltipPopup>
      </Tooltip>
      <PopoverPopup
        aria-label="Agents"
        width="md"
        padding="none"
        side="top"
        align="end"
        {...composerFloatingLayerProps}
      >
        {/* Mounted only while open, so elapsed times tick only while someone reads them. */}
        {open ? <AgentsList environmentId={props.environmentId} threadId={props.threadId} /> : null}
      </PopoverPopup>
    </Popover>
  );
}

/**
 * The thread's own row items: Agents and Tools, then the ⋯-only side chat and bookmarks. Every
 * value comes from data the thread view already holds.
 */
export function useThreadComposerRowItems(input: {
  /** Null for a draft or embedded view, which gets none of these items. */
  readonly threadRef: ScopedThreadRef | null;
  /** The thread whose bookmarks the list shows. */
  readonly bookmarksThreadRef: ScopedThreadRef | null;
  readonly agents: ReadonlyArray<OrchestrationV2Subagent> | undefined;
  readonly onOpenSideChat: (() => void) | undefined;
  readonly onRevealBookmark: (bookmark: MessageFollowUp) => void;
}): ReadonlyArray<ComposerRowItem> {
  const bookmarks = orderBookmarks(useThreadFollowUpList(input.bookmarksThreadRef));
  const tools = useComposerToolsRowItem(input.threadRef);
  const details = sideAreaDetailsRowItem(input.threadRef);
  const { threadRef, bookmarksThreadRef, onOpenSideChat, onRevealBookmark } = input;
  if (threadRef === null) return [];
  const agents = summarizeComposerRowAgents(input.agents);
  return [
    {
      id: "agents",
      priority: null,
      hidden: agents === null,
      renderRowItem: () =>
        agents ? (
          <ComposerRowAgents
            summary={agents}
            environmentId={threadRef.environmentId}
            threadId={threadRef.threadId}
          />
        ) : null,
      renderMenuRow: ({ openPopover }) => (
        <MenuItem onClick={() => openPopover()}>
          <BotIcon />
          Agents
          <MenuItemDetail>{agents?.label}</MenuItemDetail>
        </MenuItem>
      ),
      popover: {
        label: "Agents",
        render: () => (
          <AgentsList environmentId={threadRef.environmentId} threadId={threadRef.threadId} />
        ),
      },
    },
    tools,
    {
      id: "side-chat",
      priority: null,
      hidden: onOpenSideChat === undefined,
      renderMenuRow: () => (
        <MenuItem onClick={() => onOpenSideChat?.()}>
          <MessagesSquareIcon />
          Open a side chat
        </MenuItem>
      ),
    },
    {
      id: "bookmarks",
      priority: null,
      hidden: bookmarksThreadRef === null || bookmarks.length === 0,
      renderMenuRow: ({ openPopover }) => (
        <MenuItem onClick={() => openPopover()} aria-label={bookmarkListSummary(bookmarks)}>
          <BookmarkIcon />
          Bookmarks
          <MenuItemDetail>{bookmarks.length}</MenuItemDetail>
        </MenuItem>
      ),
      popover: {
        label: "Bookmarks",
        render: (close) =>
          bookmarksThreadRef ? (
            <ThreadBookmarkList
              threadRef={bookmarksThreadRef}
              bookmarks={bookmarks}
              onReveal={(bookmark) => {
                close();
                onRevealBookmark(bookmark);
              }}
            />
          ) : null,
      },
    },
    details,
  ];
}
