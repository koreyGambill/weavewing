import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { resolveStorage } from "./lib/storage";
import type { TodoFilter } from "./components/reviews/todoList.logic";
import {
  isGlobalViewId,
  migrateViewId,
  type ViewId,
  type ViewSectionId,
} from "./components/ToolSidebar.logic";
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
  /** The section of a merged view to expand and scroll to. */
  readonly section?: ViewSectionId;
  /** Opens the inbox on this notification. */
  readonly notification?: { readonly environmentId: string; readonly id: string };
}

/** The automation the Automations view shows in detail; it outlives switching threads. */
export interface AutomationSelection {
  readonly environmentId: string;
  readonly taskId: string;
}

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
  /** The thread Automations lists only the automations of; null lists every automation. */
  automationThread: ScopedThreadRef | null;
  setAutomationThread: (thread: ScopedThreadRef | null) => void;
  /** Evidence spans threads, so it starts on All; null follows the context, as older versions did. */
  evidenceScope: "thread" | "all" | null;
  evidenceNeedsQa: boolean;
  setEvidenceView: (view: { scope?: "thread" | "all"; needsQa?: boolean }) => void;
  /** `${environmentId}:${projectId}` → the branch head whose uncovered-merges banner was dismissed. */
  evidenceCoverageDismissed: Record<string, string>;
  dismissEvidenceCoverage: (key: string, head: string | null) => void;
  selectAutomation: (selection: AutomationSelection | null) => void;
  /** Sections of merged views the viewer collapsed; every other section is expanded. */
  collapsedSections: ReadonlyArray<ViewSectionId>;
  toggleSection: (section: ViewSectionId) => void;
  /** A section an opener asked to see, which scrolls into view once it renders. */
  revealSection: ViewSectionId | null;
  consumeRevealSection: (section: ViewSectionId) => void;
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
      automationThread: null,
      setAutomationThread: (automationThread) => set({ automationThread }),
      collapsedSections: [],
      toggleSection: (section) =>
        set((state) => ({
          collapsedSections: state.collapsedSections.includes(section)
            ? state.collapsedSections.filter((entry) => entry !== section)
            : [...state.collapsedSections, section],
        })),
      revealSection: null,
      consumeRevealSection: (section) =>
        set((state) => (state.revealSection === section ? { revealSection: null } : state)),
      evidenceScope: "all",
      evidenceNeedsQa: false,
      evidenceCoverageDismissed: {},
      dismissEvidenceCoverage: (key, head) =>
        set((state) => {
          const { [key]: _previous, ...rest } = state.evidenceCoverageDismissed;
          return { evidenceCoverageDismissed: head === null ? rest : { ...rest, [key]: head } };
        }),
      setEvidenceView: ({ scope, needsQa }) =>
        set((state) => ({
          evidenceScope: scope ?? state.evidenceScope,
          evidenceNeedsQa: needsQa ?? state.evidenceNeedsQa,
        })),
      selectAutomation: (automationSelection) => set({ automationSelection }),
      show: (view, target = {}) => {
        const { section } = target;
        set((state) => ({
          ...(section
            ? {
                revealSection: section,
                collapsedSections: state.collapsedSections.filter((entry) => entry !== section),
              }
            : {}),
          ...(view === "automations" ? { automationThread: target.thread ?? null } : {}),
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
          ...(section === "details:environments"
            ? {
                environmentSelection:
                  target.thread && target.environmentId
                    ? { thread: target.thread, id: target.environmentId }
                    : null,
              }
            : {}),
        }));
        // A view that spans threads names a thread only to filter by it, not to show it.
        useToolSidebarStore.getState().dispatch({
          type: "show",
          view,
          ...(target.thread && !isGlobalViewId(view)
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
      partialize: ({
        todoFilter,
        todoShowClosed,
        todoScope,
        evidenceCoverageDismissed,
        collapsedSections,
      }) => ({
        todoFilter,
        todoShowClosed,
        todoScope,
        evidenceCoverageDismissed,
        collapsedSections,
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
          version === 0 ? { lastTool: migrateViewId(view) ?? "checklist" } : { view, lastTool },
        );
        return rest as Partial<ThreadContextSidebarState>;
      },
    },
  ),
);
