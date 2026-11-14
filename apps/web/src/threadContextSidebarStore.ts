import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { resolveStorage } from "./lib/storage";
import type { TodoFilter } from "./components/reviews/todoList.logic";
import {
  firstVisibleThreadTool,
  migrateThreadToolsView,
  nextSidebarView,
  toggleThreadToolsView,
} from "./threadContextSidebar";

export type ThreadContextSection =
  | "todos"
  | "evidence"
  | "artifacts"
  | "links"
  | "related"
  | "timeline"
  | "details"
  | "environments"
  | "inspect"
  | "inbox"
  | "automations";

export type SidebarView = "threads" | ThreadContextSection;

/** Everything on the strip a viewer can hide; the thread list always stays. */
export type StripItem = ThreadContextSection;

export type InboxTab = "inbox" | "snoozed" | "dismissed";
/** A view inside the inbox that replaces its list: one notification, or the status panel. */
export type InboxSelection =
  | { readonly kind: "notification"; readonly environmentId: string; readonly id: string }
  | { readonly kind: "status" };

export interface ShowTarget {
  /** Pins the tools to this thread. */
  readonly thread?: ScopedThreadRef;
  readonly artifactId?: string;
  /** The thread the artifact belongs to, when it shouldn't pin the tools to that thread. */
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

interface ThreadContextSidebarState {
  view: SidebarView;
  lastTool: ThreadContextSection;
  pinned: ScopedThreadRef | null;
  hidden: ReadonlyArray<StripItem>;
  todoFilter: TodoFilter;
  todoShowClosed: boolean;
  environmentSelection: { thread: ScopedThreadRef; id: string } | null;
  /** Set when a tool view was requested while the sidebar may be hidden; the sidebar clears it. */
  revealPending: boolean;
  /** The artifact the Artifacts view opens on, for its thread only; null lists them all. */
  artifactSelection: { thread: ScopedThreadRef | null; id: string } | null;
  inboxTab: InboxTab;
  inboxSelection: InboxSelection | null;
  automationSelection: AutomationSelection | null;
  /** Null follows the context: Thread with a thread open, else Server. */
  automationScope: "thread" | "project" | "server" | null;
  /** Null follows the context: Thread with a thread open, else All. */
  evidenceScope: "thread" | "all" | null;
  evidenceNeedsQa: boolean;
  setEvidenceView: (view: { scope?: "thread" | "all"; needsQa?: boolean }) => void;
  selectAutomation: (selection: AutomationSelection | null) => void;
  setAutomationScope: (scope: "thread" | "project" | "server") => void;
  selectView: (view: SidebarView) => void;
  toggleTools: (sidebarVisible: boolean) => void;
  /** Opens a tool from outside the strip, unhiding it, and reveals a hidden sidebar. */
  show: (view: ThreadContextSection, target?: ShowTarget) => void;
  selectArtifact: (thread: ScopedThreadRef, id: string | null) => void;
  consumeReveal: () => void;
  pin: (thread: ScopedThreadRef | null) => void;
  setHidden: (item: StripItem, hidden: boolean) => void;
  setTodoFilter: (filter: TodoFilter) => void;
  setTodoShowClosed: (show: boolean) => void;
  selectEnvironment: (thread: ScopedThreadRef, id: string | null) => void;
  setInboxTab: (tab: InboxTab) => void;
  selectInbox: (selection: InboxSelection | null) => void;
}

export const useThreadContextSidebarStore = create<ThreadContextSidebarState>()(
  persist(
    (set) => ({
      view: "threads",
      lastTool: "todos",
      pinned: null,
      hidden: [],
      todoFilter: "all",
      todoShowClosed: false,
      environmentSelection: null,
      revealPending: false,
      artifactSelection: null,
      inboxTab: "inbox",
      inboxSelection: null,
      automationSelection: null,
      automationScope: null,
      evidenceScope: null,
      evidenceNeedsQa: false,
      setEvidenceView: ({ scope, needsQa }) =>
        set((state) => ({
          evidenceScope: scope ?? state.evidenceScope,
          evidenceNeedsQa: needsQa ?? state.evidenceNeedsQa,
        })),
      selectAutomation: (automationSelection) => set({ automationSelection }),
      setAutomationScope: (automationScope) => set({ automationScope }),
      selectView: (view) =>
        set((state) => ({
          ...nextSidebarView(state, view),
          ...(view === "artifacts" ? { artifactSelection: null } : {}),
          ...(view === "inbox" ? { inboxSelection: null } : {}),
        })),
      toggleTools: (sidebarVisible) => set((state) => toggleThreadToolsView(state, sidebarVisible)),
      show: (view, target = {}) =>
        set((state) => ({
          view,
          lastTool: view,
          revealPending: true,
          hidden: state.hidden.filter((entry) => entry !== view),
          ...(target.thread ? { pinned: target.thread } : {}),
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
        })),
      selectArtifact: (thread, id) => set({ artifactSelection: id ? { thread, id } : null }),
      consumeReveal: () => set({ revealPending: false }),
      pin: (pinned) => set({ pinned }),
      setHidden: (item, hide) =>
        set((state) => ({
          hidden: hide
            ? [...state.hidden.filter((entry) => entry !== item), item]
            : state.hidden.filter((entry) => entry !== item),
          ...(hide && state.view === item ? { view: "threads" as const } : {}),
          ...(hide && state.lastTool === item
            ? { lastTool: firstVisibleThreadTool([...state.hidden, item]) ?? state.lastTool }
            : {}),
        })),
      setTodoFilter: (todoFilter) => set({ todoFilter }),
      setTodoShowClosed: (todoShowClosed) => set({ todoShowClosed }),
      selectEnvironment: (thread, id) => set({ environmentSelection: id ? { thread, id } : null }),
      setInboxTab: (inboxTab) => set({ inboxTab, inboxSelection: null }),
      selectInbox: (inboxSelection) => set({ inboxSelection }),
    }),
    {
      name: "t3code:thread-context-sidebar",
      version: 2,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window === "undefined" ? undefined : window.localStorage),
      ),
      partialize: ({ view, lastTool, hidden, todoFilter, todoShowClosed }) => ({
        view,
        lastTool,
        hidden,
        todoFilter,
        todoShowClosed,
      }),
      // v0 stored the right panel's { open, view }; its view becomes the last tool.
      // v1 named the inbox's strip slot "status".
      migrate: (persisted, version) => {
        const state = (persisted ?? {}) as { view?: string; hidden?: ReadonlyArray<string> };
        if (version === 0) return { view: "threads", lastTool: migrateThreadToolsView(state.view) };
        return version === 1 && state.hidden
          ? {
              ...state,
              hidden: state.hidden.map((item) => (item === "status" ? "inbox" : item)),
            }
          : persisted;
      },
    },
  ),
);
