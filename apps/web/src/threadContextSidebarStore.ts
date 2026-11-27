import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { resolveStorage } from "./lib/storage";
import type { TodoFilter } from "./components/reviews/todoList.logic";
import { migrateViewId, type ViewId } from "./components/ToolSidebar.logic";
import { adoptRetiredRailSelection, useToolSidebarStore } from "./toolSidebarStore";

export type InboxTab = "inbox" | "snoozed" | "dismissed";
/** A notification opened from the inbox list. */
export type InboxSelection = {
  readonly kind: "notification";
  readonly environmentId: string;
  readonly id: string;
};

export interface ShowTarget {
  /**
   * The thread the view is for. The side panel follows it when it already follows that thread,
   * and otherwise locks to it.
   */
  readonly thread?: ScopedThreadRef;
  /** The opener is navigating to `thread`; arriving there keeps the view open. */
  readonly arriving?: boolean;
  readonly artifactId?: string;
  /** The thread the artifact belongs to, when the request is not about one thread. */
  readonly artifactThread?: ScopedThreadRef;
  readonly environmentId?: string;
  /** Opens the inbox on this notification. */
  readonly notification?: { readonly environmentId: string; readonly id: string };
}

/** The automation the Automations view shows in detail; it outlives switching threads. */
export interface AutomationSelection {
  readonly environmentId: string;
  readonly taskId: string;
}

type EvidenceShow = "all" | "needs-qa" | "notes";

/** What each view remembers between openings: filters, scopes and the item it opens on. */
interface ThreadContextSidebarState {
  todoFilter: TodoFilter;
  todoShowClosed: boolean;
  /** All lists open follow-ups and your todos across the environment's threads. */
  todoScope: "thread" | "all";
  environmentSelection: { thread: ScopedThreadRef; id: string } | null;
  /** The artifact the Artifacts view opens on, for its thread only; null lists them all. */
  artifactSelection: { thread: ScopedThreadRef | null; id: string } | null;
  inboxTab: InboxTab;
  inboxSelection: InboxSelection | null;
  automationSelection: AutomationSelection | null;
  /** Null follows the context: Thread with a thread open, else All. */
  evidenceScope: "thread" | "all" | null;
  /** Every landing, those waiting on QA, or those with a note. */
  evidenceShow: EvidenceShow;
  setEvidenceView: (view: { scope?: "thread" | "all"; show?: EvidenceShow }) => void;
  /** `${environmentId}:${projectId}` → the branch head whose uncovered-merges banner was dismissed. */
  evidenceCoverageDismissed: Record<string, string>;
  dismissEvidenceCoverage: (key: string, head: string | null) => void;
  selectAutomation: (selection: AutomationSelection | null) => void;
  /** Opens a view in the side panel on the item `target` names. */
  show: (view: ViewId, target?: ShowTarget) => void;
  selectArtifact: (thread: ScopedThreadRef, id: string | null) => void;
  setTodoFilter: (filter: TodoFilter) => void;
  setTodoShowClosed: (show: boolean) => void;
  setTodoScope: (scope: "thread" | "all") => void;
  selectEnvironment: (thread: ScopedThreadRef, id: string | null) => void;
  setInboxTab: (tab: InboxTab) => void;
  selectInbox: (selection: InboxSelection | null) => void;
}

export const useThreadContextSidebarStore = create<ThreadContextSidebarState>()(
  persist(
    (set) => ({
      todoFilter: "all",
      todoShowClosed: false,
      todoScope: "thread",
      environmentSelection: null,
      artifactSelection: null,
      inboxTab: "inbox",
      inboxSelection: null,
      automationSelection: null,
      evidenceScope: null,
      evidenceShow: "all",
      evidenceCoverageDismissed: {},
      dismissEvidenceCoverage: (key, head) =>
        set((state) => {
          const { [key]: _previous, ...rest } = state.evidenceCoverageDismissed;
          return { evidenceCoverageDismissed: head === null ? rest : { ...rest, [key]: head } };
        }),
      setEvidenceView: ({ scope, show }) =>
        set((state) => ({
          evidenceScope: scope ?? state.evidenceScope,
          evidenceShow: show ?? state.evidenceShow,
        })),
      selectAutomation: (automationSelection) => set({ automationSelection }),
      show: (view, target = {}) => {
        set({
          ...(view === "artifacts"
            ? {
                artifactSelection: target.artifactId
                  ? {
                      thread: target.thread ?? target.artifactThread ?? null,
                      id: target.artifactId,
                    }
                  : null,
              }
            : {}),
          ...(view === "inbox"
            ? {
                inboxSelection: target.notification
                  ? { kind: "notification" as const, ...target.notification }
                  : null,
                ...(target.notification ? { inboxTab: "inbox" as const } : {}),
              }
            : {}),
          ...(view === "environments"
            ? {
                environmentSelection:
                  target.thread && target.environmentId
                    ? { thread: target.thread, id: target.environmentId }
                    : null,
              }
            : {}),
        });
        useToolSidebarStore.getState().dispatch({
          type: "show",
          view,
          ...(target.thread
            ? {
                thread: target.thread,
                arriving: target.arriving === true,
              }
            : {}),
        });
      },
      selectArtifact: (thread, id) => set({ artifactSelection: id ? { thread, id } : null }),
      setTodoFilter: (todoFilter) => set({ todoFilter }),
      setTodoShowClosed: (todoShowClosed) => set({ todoShowClosed }),
      setTodoScope: (todoScope) => set({ todoScope }),
      selectEnvironment: (thread, id) => set({ environmentSelection: id ? { thread, id } : null }),
      setInboxTab: (inboxTab) => set({ inboxTab, inboxSelection: null }),
      selectInbox: (inboxSelection) => set({ inboxSelection }),
    }),
    {
      name: "t3code:thread-context-sidebar",
      version: 3,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window === "undefined" ? undefined : window.localStorage),
      ),
      partialize: ({ todoFilter, todoShowClosed, todoScope, evidenceCoverageDismissed }) => ({
        todoFilter,
        todoShowClosed,
        todoScope,
        evidenceCoverageDismissed,
      }),
      // v0 stored the retired right panel's { open, view }; v1 and v2 the left rail's view and last
      // tool. The side panel shows views now, so it takes the selection and the rail's fields go.
      migrate: (persisted, version) => {
        const {
          view,
          lastTool,
          hidden: _hidden,
          ...rest
        } = (persisted ?? {}) as {
          view?: unknown;
          lastTool?: unknown;
          hidden?: unknown;
        };
        adoptRetiredRailSelection(
          version === 0 ? { lastTool: migrateViewId(view) ?? "todos" } : { view, lastTool },
        );
        return rest as Partial<ThreadContextSidebarState>;
      },
    },
  ),
);
