import type { ScopedThreadRef } from "@t3tools/contracts";
import type { DraftId } from "../composerDraftStore";
import {
  ActivityIcon,
  BellIcon,
  CalendarClockIcon,
  CalendarIcon,
  ChartGanttIcon,
  ClipboardCheckIcon,
  FilesIcon,
  IdCardIcon,
  LinkIcon,
  ListChecksIcon,
  type LucideIcon,
} from "lucide-react";
import { createElement, type ComponentType, type ReactNode } from "react";

import { CalendarTool } from "../components/CalendarTool";
import {
  VIEW_IDS,
  type ThreadViewId,
  type ViewId,
  type ViewLayout,
} from "../components/ToolSidebar.logic";
import { InboxGlobalView, InboxUnreadCount } from "./InboxGlobalView";
import { StatusAlertCount, StatusView } from "./StatusView";
import { AutomationsView } from "../components/automations/AutomationsView";
import { EvidenceView } from "../components/evidence/EvidenceView";
import { GlobalViewBody } from "./GlobalViewBody";
import { ThreadViewBody } from "./ThreadViewBody";
import { ArtifactsCount, ChecklistCount, LinksCount } from "./threadViewCounts";

export type { ViewId, ViewLayout };
export type ViewScope = "thread" | "global";
export type ViewHost = "panel" | "tile" | "page";

/** A draft that has no thread yet; Inspect previews its starting context. */
export interface ViewDraft {
  readonly draftId: DraftId;
  readonly threadRef: ScopedThreadRef;
}

/**
 * The thread a thread view shows, or else the selected draft. A global view gets the thread it was
 * opened beside, to offer filtering by it.
 */
export interface ViewTarget {
  readonly threadRef: ScopedThreadRef | null;
  readonly draft: ViewDraft | null;
}

/** Elements the host provides around a view: its heading's button row and a Details element. */
export interface ViewSlots {
  readonly actions: HTMLDivElement | null;
  /** Receives the element the conversation's details card moves into, for the host to claim. */
  readonly setDetails: (element: HTMLDivElement | null) => void;
}

/**
 * One view any host can show. A view takes its thread only from `target` and its layout only
 * from `layout`, never from the route or its own media queries, so every host behaves the same.
 * Hosts mount a view only while it is visible.
 */
export interface ViewDefinition {
  readonly id: ViewId;
  readonly title: string;
  readonly icon: LucideIcon;
  /** What the view shows and who writes it, for the host's about note. */
  readonly about: string;
  readonly scope: ViewScope;
  /** Below this width the view renders `compact`; a view without a compact layout omits it. */
  readonly compactBelowPx?: number;
  /** The narrowest width where the full layout is useful; hosts never place it narrower. */
  readonly minWidthPx: number;
  /**
   * The view's count in the picker, from data the client already holds, or nothing. The picker
   * mounts it only while open, and its queries read only what other readers already hold.
   */
  readonly PickerCount?: ComponentType<{ readonly target: ViewTarget }>;
  readonly render: (props: {
    readonly target: ViewTarget;
    readonly layout: ViewLayout;
    readonly host: ViewHost;
    readonly width: number;
    readonly slots: ViewSlots;
  }) => ReactNode;
}

function threadView<Id extends ThreadViewId>(
  id: Id,
  title: string,
  icon: LucideIcon,
  about: string,
  PickerCount?: ViewDefinition["PickerCount"],
): ViewDefinition & { readonly id: Id } {
  return {
    id,
    title,
    icon,
    about,
    ...(PickerCount ? { PickerCount } : {}),
    scope: "thread",
    minWidthPx: 280,
    render: ({ target, slots }) =>
      createElement(ThreadViewBody, { view: id, title, target, slots }),
  };
}

const DEFINITIONS: { readonly [Id in ViewId]: ViewDefinition & { readonly id: Id } } = {
  checklist: threadView(
    "checklist",
    "Checklist",
    ListChecksIcon,
    "The agent's checklist for this thread and your follow-up flags. Agents update it with list_update; you can add and check items here.",
    ChecklistCount,
  ),
  artifacts: threadView(
    "artifacts",
    "Artifacts",
    FilesIcon,
    "Documents and pages agents publish for this thread, with any questions they ask you. Agents write them with artifact_write; you answer here.",
    ArtifactsCount,
  ),
  links: threadView(
    "links",
    "Links",
    LinkIcon,
    "What this thread points to: its ticket and pull requests, web links and files from the conversation, then the threads it delegated to, forked, messaged or heard from.",
    LinksCount,
  ),
  activity: threadView(
    "activity",
    "Activity",
    ChartGanttIcon,
    "What happened here: when this thread and its delegates ran, on one clock, and the landings agents recorded for it, newest first.",
  ),
  details: threadView(
    "details",
    "Details",
    IdCardIcon,
    "What the thread is and runs on: workspace, branch, scripts and automations, the Xwing environments it uses, and what the agent loaded and spent.",
  ),
  inbox: {
    id: "inbox",
    title: "Inbox",
    icon: BellIcon,
    about:
      "Notifications from automations, status sources and agents across every thread. Snooze, dismiss or open each one here.",
    scope: "global",
    minWidthPx: 280,
    PickerCount: InboxUnreadCount,
    render: ({ slots }) => createElement(InboxGlobalView, { actions: slots.actions }),
  },
  evidence: {
    id: "evidence",
    title: "Evidence",
    icon: ClipboardCheckIcon,
    about:
      "Proof for each land in every thread: what was asked, its commits, checks, review verdict and captures. Agents record it with evidence_record; you set each change's QA state here.",
    scope: "global",
    minWidthPx: 280,
    render: ({ target }) =>
      createElement(
        GlobalViewBody,
        { title: "Evidence" },
        createElement(EvidenceView, { threadRef: target.threadRef }),
      ),
  },
  automations: {
    id: "automations",
    title: "Automations",
    icon: CalendarClockIcon,
    about:
      "Agents that run on a schedule, a webhook or an event. Switch them on or off for a thread, a project or the whole server, and open a run's thread from its history.",
    scope: "global",
    minWidthPx: 280,
    render: ({ target }) =>
      createElement(
        GlobalViewBody,
        { title: "Automations", flush: true },
        createElement(AutomationsView, { threadRef: target.threadRef }),
      ),
  },
  calendar: {
    id: "calendar",
    title: "Calendar",
    icon: CalendarIcon,
    about: "Your agenda for a day. Calendar sync is not available yet.",
    scope: "global",
    minWidthPx: 280,
    render: () => createElement(CalendarTool),
  },
  status: {
    id: "status",
    title: "Status",
    icon: ActivityIcon,
    about:
      "The health of external tools from your status sources. Configure them under Settings → Status sources.",
    scope: "global",
    minWidthPx: 280,
    PickerCount: StatusAlertCount,
    render: () => createElement(StatusView),
  },
};

export const VIEW_DEFINITIONS: ReadonlyArray<ViewDefinition> = VIEW_IDS.map(
  (id) => DEFINITIONS[id],
);

export function viewDefinition(id: ViewId): ViewDefinition {
  return DEFINITIONS[id];
}
