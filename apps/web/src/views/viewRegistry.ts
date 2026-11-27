import type { ScopedThreadRef } from "@t3tools/contracts";
import type { DraftId } from "../composerDraftStore";
import {
  ActivityIcon,
  BoxesIcon,
  CalendarClockIcon,
  CalendarIcon,
  ChartGanttIcon,
  ClipboardCheckIcon,
  FilesIcon,
  IdCardIcon,
  LinkIcon,
  ListChecksIcon,
  NetworkIcon,
  ScanSearchIcon,
  type LucideIcon,
} from "lucide-react";
import { createElement, type ComponentType, type ReactNode } from "react";

import { CalendarTool } from "../components/CalendarTool";
import { PullRequestGlyph } from "../components/pullRequest/pullRequestIcons";
import { VIEW_IDS, type ViewId, type ViewLayout } from "../components/ToolSidebar.logic";
import { StatusAlertCount, StatusView } from "./StatusView";
import { ThreadViewBody } from "./ThreadViewBody";
import { viewSupportsHost } from "./viewPage.logic";

export type { ViewId, ViewLayout };
/** Every registered view: those the side area can hold, then views that open only on a page. */
export type RegisteredViewId = ViewId | "pull-requests";
export type ViewScope = "thread" | "global";
export type ViewHost = "panel" | "tile" | "page";
/** Where a global view opens full size: the shared view page or a route of its own. */
export type ViewPage = "/view/$viewId" | "/pull-requests";

/** A draft that has no thread yet; Inspect previews its starting context. */
export interface ViewDraft {
  readonly draftId: DraftId;
  readonly threadRef: ScopedThreadRef;
}

/** The thread a thread view shows, or else the selected draft; global views ignore it. */
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
  readonly id: RegisteredViewId;
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
   * mounts it only while open.
   */
  readonly PickerCount?: ComponentType<{ readonly target: ViewTarget }>;
  /** The route that shows a global view full size; hosts narrower than `minWidthPx` link to it. */
  readonly page?: ViewPage;
  /**
   * The hosts that render this view's body; a host offers only views that list it. Omitted, a
   * view renders in the panel and in tiles, and on the shared page when `page` is
   * "/view/$viewId". `[]` makes a view page-only: it opens only on its own `page`.
   */
  readonly hosts?: ReadonlyArray<ViewHost>;
  readonly render: (props: {
    readonly target: ViewTarget;
    readonly layout: ViewLayout;
    readonly host: ViewHost;
    readonly width: number;
    readonly slots: ViewSlots;
  }) => ReactNode;
}

type ThreadViewId = Exclude<ViewId, "calendar" | "status">;

function threadView<Id extends ThreadViewId>(
  id: Id,
  title: string,
  icon: LucideIcon,
  about: string,
): ViewDefinition & { readonly id: Id } {
  return {
    id,
    title,
    icon,
    about,
    scope: "thread",
    minWidthPx: 280,
    render: ({ target, slots }) =>
      createElement(ThreadViewBody, { view: id, title, target, slots }),
  };
}

const DEFINITIONS: { readonly [Id in RegisteredViewId]: ViewDefinition & { readonly id: Id } } = {
  todos: threadView(
    "todos",
    "Todos",
    ListChecksIcon,
    "Commitments agents and you track for this thread. Agents update it with list_update; you can add and check items here.",
  ),
  evidence: threadView(
    "evidence",
    "Evidence",
    ClipboardCheckIcon,
    "Proof for each land: what was asked, its commits, checks, review verdict and captures. Agents record it with evidence_record; you set each change's QA state here.",
  ),
  artifacts: threadView(
    "artifacts",
    "Artifacts",
    FilesIcon,
    "Documents and pages agents publish for this thread, with any questions they ask you. Agents write them with artifact_write; you answer here.",
  ),
  links: threadView(
    "links",
    "Links",
    LinkIcon,
    "The thread's ticket and pull requests, then web links and files linked in the conversation. It fills as agents link work, post URLs and cite files; click a file's lines to open it there.",
  ),
  related: threadView(
    "related",
    "Related",
    NetworkIcon,
    "Threads this one delegated to, forked, messaged or heard from. Agent suggestions will appear under Suggested.",
  ),
  timeline: threadView(
    "timeline",
    "Timeline",
    ChartGanttIcon,
    "When this thread and its delegates ran, one row per thread on a shared clock. Hover a bar for its model and timing; click it to open that thread.",
  ),
  details: threadView(
    "details",
    "Details",
    IdCardIcon,
    "The conversation's details card: workspace, branch, scripts and automations. It is the same card the thread view shows.",
  ),
  environments: threadView(
    "environments",
    "Environments",
    BoxesIcon,
    "Where this thread's code lives: the Xwing environments it and its delegated work use, or else its worktree and branch.",
  ),
  inspect: threadView(
    "inspect",
    "Inspect",
    ScanSearchIcon,
    "What the agent loaded and spent: file and skill reads, context per turn, and tokens. T3 records it as turns run.",
  ),
  automations: threadView(
    "automations",
    "Automations",
    CalendarClockIcon,
    "Agents that run on a schedule, a webhook or an event. Switch them on or off for this thread, the project or the whole server, and open a run's thread from its history.",
  ),
  calendar: {
    id: "calendar",
    title: "Calendar",
    icon: CalendarIcon,
    about: "Your agenda for a day. Calendar sync is not available yet.",
    scope: "global",
    minWidthPx: 280,
    page: "/view/$viewId",
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
    page: "/view/$viewId",
    render: () => createElement(StatusView),
  },
  "pull-requests": {
    id: "pull-requests",
    title: "Pull requests",
    icon: PullRequestGlyph.pullRequest,
    about: "Pull requests across your projects, with their checks and reviews, and a detail tile.",
    scope: "global",
    minWidthPx: 720,
    page: "/pull-requests",
    // Its page reads its filters from its own route, so no host renders this body.
    hosts: [],
    render: () => null,
  },
};

const PAGE_ONLY_VIEW_IDS = ["pull-requests"] as const satisfies ReadonlyArray<RegisteredViewId>;

export const VIEW_DEFINITIONS: ReadonlyArray<ViewDefinition> = [
  ...VIEW_IDS,
  ...PAGE_ONLY_VIEW_IDS,
].map((id) => DEFINITIONS[id]);

/** The side area's picker, in its order: the views the panel can host. */
export const PANEL_VIEW_DEFINITIONS: ReadonlyArray<ViewDefinition & { readonly id: ViewId }> =
  VIEW_IDS.map((id) => DEFINITIONS[id]).filter((entry) => viewSupportsHost(entry, "panel"));

export function viewDefinition(id: RegisteredViewId): ViewDefinition {
  return DEFINITIONS[id];
}
