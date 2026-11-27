import type {
  NotificationSeverity,
  OrchestrationV2DelegateRole,
  ScopedThreadRef,
  ThreadWorkspace,
} from "@t3tools/contracts";
import {
  selectThreadTileLayout,
  useRightPanelStore,
  type RightPanelSurface,
} from "./rightPanelStore";
import type { ThreadTileLayout } from "./threadTileLayout";
import { visibleTileGroups } from "./threadTileGeometry";

/** The selected thread: the route's, or the side chat in its focused tile. */
export function selectContextThread(
  owner: ScopedThreadRef | null,
  layout: ThreadTileLayout | null,
  surfaces: ReadonlyArray<RightPanelSurface>,
): ScopedThreadRef | null {
  if (!owner || !layout) return owner;
  const groups = visibleTileGroups(layout);
  const group =
    groups.find((entry) => entry.id === layout.focusedGroupId) ??
    groups.find((entry) => entry.id === layout.maximizedGroupId);
  const surface = surfaces.find((entry) => entry.id === group?.activeTabId);
  return surface?.kind === "side-chat"
    ? { environmentId: owner.environmentId, threadId: surface.threadId }
    : owner;
}

/**
 * The selected thread at call time, for handlers: what `useSelectedThreadRef` renders, given the
 * route's thread.
 */
export function readSelectedThreadRef(owner: ScopedThreadRef | null): ScopedThreadRef | null {
  if (!owner) return null;
  const { byThreadKey } = useRightPanelStore.getState();
  return selectContextThread(
    owner,
    selectThreadTileLayout(byThreadKey, owner),
    byThreadKey[`${owner.environmentId}:${owner.threadId}`]?.surfaces ?? [],
  );
}

export interface ThreadToolSignals {
  /** The agent's open list items; the user's own tasks count in the thread's waiting strip. */
  readonly listCount: number;
  /** Artifact questions without a submitted answer on each artifact's latest version. */
  readonly questionCount: number;
  readonly ticketState: "open" | "closed" | "needs_review" | "unknown" | null;
}

export function summarizeThreadTools(workspace: ThreadWorkspace | null): ThreadToolSignals {
  if (!workspace) return { listCount: 0, questionCount: 0, ticketState: null };
  const listCount = workspace.items.filter(
    (item) => item.state === "open" && item.owner !== "you",
  ).length;
  const questionCount = workspace.artifacts.reduce((total, artifact) => {
    const version = artifact.versions.at(-1);
    return (
      total +
      (version?.questions.filter((question) => !version.answers[question.id]?.submittedAt).length ??
        0)
    );
  }, 0);
  const ticketState =
    workspace.items.flatMap((item) => item.linkStates ?? []).find((link) => link.type === "ticket")
      ?.state ?? null;
  return { listCount, questionCount, ticketState };
}

interface RelatedShell {
  readonly id: string;
  readonly forkedFrom?: { readonly type: string; readonly threadId?: string } | null;
  readonly lineage: { readonly parentThreadId?: string | null };
}

export type TalkedWithRelation =
  | "Delegated this thread"
  | "Delegated to"
  | "Forked from"
  | "Fork"
  | "Messaged this thread"
  | "Shared context";

/** Threads this one delegated to, forked, messaged or heard from; siblings are not included. */
export function talkedWithThreads<Shell extends RelatedShell>(input: {
  readonly threadId: string;
  /** This thread's own shell, which names its parent and fork source. */
  readonly self: RelatedShell | null;
  readonly shells: ReadonlyArray<Shell>;
  /** Threads whose messages or replies arrived in this thread. */
  readonly messagedBy: ReadonlySet<string>;
  readonly transfers: ReadonlyArray<{
    readonly sourceThreadId: string;
    readonly targetThreadId: string;
  }>;
}): Array<{ readonly entry: Shell; readonly relation: TalkedWithRelation }> {
  const { self } = input;
  const forkSource = (entry: RelatedShell) =>
    entry.forkedFrom?.type === "run" ? entry.forkedFrom.threadId : undefined;
  return input.shells.flatMap((entry) => {
    if (entry.id === input.threadId) return [];
    const relation: TalkedWithRelation | null =
      entry.id === self?.lineage.parentThreadId
        ? "Delegated this thread"
        : entry.lineage.parentThreadId === input.threadId
          ? "Delegated to"
          : self && entry.id === forkSource(self)
            ? "Forked from"
            : forkSource(entry) === input.threadId
              ? "Fork"
              : input.messagedBy.has(entry.id)
                ? "Messaged this thread"
                : input.transfers.some(
                      (transfer) =>
                        transfer.sourceThreadId === entry.id ||
                        transfer.targetThreadId === entry.id,
                    )
                  ? "Shared context"
                  : null;
    return relation ? [{ entry, relation }] : [];
  });
}

export type ThreadToolsAttentionTone = "alert" | "question" | "warn" | "review" | "todo";

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** What needs the user while the sidebar is hidden, most urgent first; null when nothing does. */
export function threadToolsAttention(
  signals: ThreadToolSignals,
  inbox: { readonly unread: number; readonly severity: NotificationSeverity | null },
): { readonly tone: ThreadToolsAttentionTone; readonly summary: string } | null {
  // Info notifications only badge the bell.
  const inboxItem = (severity: NotificationSeverity, tone: ThreadToolsAttentionTone) =>
    inbox.unread && inbox.severity === severity
      ? [[tone, plural(inbox.unread, "unread notification", "unread notifications")] as const]
      : [];
  const items: Array<readonly [ThreadToolsAttentionTone, string]> = [
    ...inboxItem("critical", "alert"),
    ...(signals.questionCount
      ? [
          [
            "question",
            plural(signals.questionCount, "unanswered question", "unanswered questions"),
          ] as const,
        ]
      : []),
    ...inboxItem("warning", "warn"),
    ...(signals.ticketState === "needs_review" ? [["review", "Ticket needs review"] as const] : []),
    ...(signals.listCount
      ? [["todo", plural(signals.listCount, "open todo", "open todos")] as const]
      : []),
  ];
  const first = items[0];
  return first ? { tone: first[0], summary: items.map(([, text]) => text).join(" · ") } : null;
}

export interface TalkedWithRow {
  readonly id: string;
  readonly title: string;
  readonly branch: string | null;
  readonly relation: TalkedWithRelation;
  readonly role: OrchestrationV2DelegateRole | null;
}

/**
 * Adds this thread's delegates whose shells the client never received: the server omits idle
 * subagent shells, so finished delegates are known only from the thread's own subagent records.
 */
export function withDelegates(
  rows: ReadonlyArray<TalkedWithRow>,
  subagents: ReadonlyArray<{
    readonly childThreadId: string | null;
    readonly title: string | null;
    readonly remoteChild?: unknown;
    readonly delegateRole?: OrchestrationV2DelegateRole | undefined;
  }>,
): TalkedWithRow[] {
  const seen = new Set(rows.map((row) => row.id));
  const delegates = subagents.flatMap((subagent) => {
    const id = subagent.childThreadId;
    if (id === null || subagent.remoteChild !== undefined || seen.has(id)) return [];
    seen.add(id);
    return [
      {
        id,
        title: subagent.title ?? "Delegated task",
        branch: null,
        relation: "Delegated to" as const,
        role: subagent.delegateRole ?? null,
      },
    ];
  });
  return [...rows, ...delegates];
}
