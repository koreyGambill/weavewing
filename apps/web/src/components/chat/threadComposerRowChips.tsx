import type {
  EnvironmentId,
  ScheduledTaskId,
  ScopedThreadRef,
  VcsStatusResult,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { CalendarClockIcon } from "lucide-react";
import { type MouseEvent, type Ref, useImperativeHandle, useRef, useState } from "react";

import { useOpenPrLink } from "~/lib/openPullRequestLink";
import { useRightPanelStore } from "~/rightPanelStore";
import { useQuietThreadShell } from "~/state/entities";
import { scheduledTasksByEnvironmentAtom } from "~/state/scheduledTasks";
import { useThreadContextSidebarStore } from "~/threadContextSidebarStore";
import {
  resolveDisplayedThreadPr,
  resolveThreadPullRequestBadgePresentation,
  ThreadPullRequestBadgeControl,
  useThreadDisplayedPullRequest,
} from "../ThreadStatusIndicators";
import { Menu, MenuItem, MenuItemDetail, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControl } from "./ComposerControl";
import { useComposerRowItemPlacement } from "./ComposerRow";
import { composerFloatingLayerProps } from "./composerEventScope";
import { COMPOSER_ROW_PRIORITY, type ComposerRowItem } from "./composerRowItems";
import {
  automationRelationLabel,
  type ComposerRowAutomation,
  resolveComposerRowPullRequestText,
  resolveThreadAutomations,
  summarizeComposerRowAutomations,
} from "./composerRowChips.logic";

const NO_AUTOMATIONS: ReadonlyArray<ComposerRowAutomation> = [];

/**
 * The automations tied to a thread, from the app-level scheduled-task list, so a thread view
 * opens no subscription of its own.
 */
function useThreadAutomations(
  threadRef: ScopedThreadRef | null,
  startedByTaskId: ScheduledTaskId | null | undefined,
): ReadonlyArray<ComposerRowAutomation> {
  const tasks = useAtomValue(scheduledTasksByEnvironmentAtom, (byEnvironment) =>
    threadRef === null ? null : (byEnvironment.get(threadRef.environmentId) ?? null),
  );
  if (threadRef === null) return NO_AUTOMATIONS;
  return resolveThreadAutomations({ threadId: threadRef.threadId, startedByTaskId, tasks });
}

function openAutomation(environmentId: EnvironmentId, taskId: ScheduledTaskId) {
  const sidebar = useThreadContextSidebarStore.getState();
  sidebar.selectAutomation({ environmentId, taskId });
  sidebar.show("automations");
}

interface AutomationListHandle {
  readonly open: () => void;
}

/** The automation chip: one automation opens it; several open a menu of them. */
function ComposerRowAutomationChip({
  ref,
  ...props
}: {
  ref: Ref<AutomationListHandle>;
  environmentId: EnvironmentId;
  automations: ReadonlyArray<ComposerRowAutomation>;
}) {
  const rowPlacement = useComposerRowItemPlacement();
  const [open, setOpen] = useState(false);
  useImperativeHandle(ref, () => ({ open: () => setOpen(true) }), []);
  const summary = summarizeComposerRowAutomations(props.automations);
  if (summary === null) return null;
  const content = (
    <>
      <CalendarClockIcon aria-hidden />
      <span className="whitespace-nowrap">{summary.title}</span>
      {summary.more > 0 ? (
        <span className="text-muted-foreground tabular-nums">+{summary.more}</span>
      ) : null}
    </>
  );
  const single = props.automations.length === 1 ? props.automations[0] : undefined;
  if (single) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <ComposerControl
              size="xs"
              aria-label={`${summary.description}. Open in Automations`}
              onClick={() => openAutomation(props.environmentId, single.id)}
            />
          }
        >
          {content}
        </TooltipTrigger>
        <TooltipPopup>{summary.description}</TooltipPopup>
      </Tooltip>
    );
  }
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger render={<span className="flex" />}>
          <MenuTrigger render={<ComposerControl size="xs" aria-label={summary.description} />}>
            {content}
          </MenuTrigger>
        </TooltipTrigger>
        <TooltipPopup>{summary.description}</TooltipPopup>
      </Tooltip>
      <MenuPopup
        side="top"
        align="end"
        className="w-[min(18rem,calc(100vw-2rem))]"
        {...composerFloatingLayerProps}
        {...(rowPlacement?.inMenu
          ? { anchor: rowPlacement.anchor, finalFocus: rowPlacement.finalFocus }
          : {})}
      >
        {props.automations.map((automation) => (
          <MenuItem
            key={automation.id}
            onClick={() => openAutomation(props.environmentId, automation.id)}
          >
            <CalendarClockIcon />
            <span className="min-w-0 flex-1 truncate">{automation.title}</span>
            <MenuItemDetail>{automationRelationLabel(automation.relation)}</MenuItemDetail>
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}

/**
 * The pull request and automation chips. Values come from the thread shell, the VCS status the
 * thread view already holds, and the app-level scheduled-task list.
 */
export function useComposerRowChipItems(input: {
  /** Null for an embedded view, which gets neither chip. A draft's ref finds no shell. */
  readonly threadRef: ScopedThreadRef | null;
  /** The ref the thread works on, matched against `gitStatus` for a PR the shell lacks. */
  readonly branch: string | null;
  readonly gitStatus: Pick<VcsStatusResult, "refName" | "pr" | "sourceControlProvider"> | null;
}): ReadonlyArray<ComposerRowItem> {
  const { threadRef, branch, gitStatus } = input;
  const shell = useQuietThreadShell(threadRef);
  const branchPr = resolveDisplayedThreadPr({ threadBranch: branch, gitStatus });
  const displayed = useThreadDisplayedPullRequest(
    threadRef?.environmentId ?? null,
    shell,
    branchPr,
    gitStatus?.sourceControlProvider,
  );
  const openPrLink = useOpenPrLink(threadRef ?? undefined);
  const automations = useThreadAutomations(threadRef, shell?.automationTaskId);
  const automationListRef = useRef<AutomationListHandle>(null);
  if (threadRef === null) return [];

  const { badge, number, url, status } = displayed;
  const presentation = resolveThreadPullRequestBadgePresentation({ badge, number, url, status });
  const prText = resolveComposerRowPullRequestText({ badge, number });
  const opensList = badge !== null && (badge.kind === "stack" || badge.others > 0);
  const openList = () => useRightPanelStore.getState().open(threadRef, "pull-requests");
  const openPullRequest = (event: MouseEvent<HTMLElement>, targetUrl = url) => {
    if (targetUrl) openPrLink(event, targetUrl);
  };
  const automationSummary = summarizeComposerRowAutomations(automations);
  const singleAutomation = automations.length === 1 ? automations[0] : undefined;

  return [
    {
      id: "pull-request",
      priority: COMPOSER_ROW_PRIORITY.pullRequest,
      hidden: presentation === null || prText === null,
      renderRowItem: () =>
        presentation && prText ? (
          <ThreadPullRequestBadgeControl
            render={<ComposerControl size="xs" />}
            badge={badge}
            pullRequests={shell?.pullRequests ?? []}
            number={number}
            url={url}
            status={status}
            presentation={{ ...presentation, text: prText.value }}
            onOpenList={openList}
            onOpenPullRequest={openPullRequest}
          />
        ) : null,
      renderMenuRow: ({ openPopover }) =>
        presentation && prText ? (
          <MenuItem
            aria-label={presentation.label}
            onClick={(event) =>
              openPopover(() => (opensList ? openList() : openPullRequest(event)))
            }
          >
            <presentation.Icon className={presentation.toneClassName} />
            <span className="min-w-0 flex-1 truncate tabular-nums">{prText.value}</span>
            <MenuItemDetail>Pull request</MenuItemDetail>
          </MenuItem>
        ) : null,
    },
    {
      id: "automation",
      priority: COMPOSER_ROW_PRIORITY.automation,
      hidden: automationSummary === null,
      renderRowItem: () => (
        <ComposerRowAutomationChip
          ref={automationListRef}
          environmentId={threadRef.environmentId}
          automations={automations}
        />
      ),
      renderMenuRow: ({ openPopover }) =>
        automationSummary ? (
          <MenuItem
            aria-label={automationSummary.description}
            onClick={() =>
              openPopover(() =>
                singleAutomation
                  ? openAutomation(threadRef.environmentId, singleAutomation.id)
                  : automationListRef.current?.open(),
              )
            }
          >
            <CalendarClockIcon />
            <span className="min-w-0 flex-1 truncate">{automationSummary.value}</span>
            <MenuItemDetail>Automation</MenuItemDetail>
          </MenuItem>
        ) : null,
    },
  ];
}
