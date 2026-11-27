import { ScopedThreadRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/** The views that show one thread, in the picker's order. */
const THREAD_VIEW_IDS = [
  "todos",
  "evidence",
  "artifacts",
  "links",
  "related",
  "timeline",
  "details",
  "environments",
  "inspect",
  "automations",
] as const;

/** The views that span threads, in the picker's order. */
const GLOBAL_VIEW_IDS = ["inbox", "calendar", "status"] as const;

export type ThreadViewId = (typeof THREAD_VIEW_IDS)[number];
export type GlobalViewId = (typeof GLOBAL_VIEW_IDS)[number];
/** Every view the side area can show. */
export type ViewId = ThreadViewId | GlobalViewId;

/** The view picker's order: thread views, then the views that span threads. */
export const VIEW_IDS: ReadonlyArray<ViewId> = [...THREAD_VIEW_IDS, ...GLOBAL_VIEW_IDS];

function isViewId(value: string): value is ViewId {
  return VIEW_IDS.some((id) => id === value);
}

function isThreadViewId(id: string): id is ThreadViewId {
  return THREAD_VIEW_IDS.some((entry) => entry === id);
}

export type ViewLayout = "compact" | "full";

/** Hosts below the side area's breakpoint, or narrower than a view's `compactBelowPx`, get compact. */
export function resolveViewLayout(
  compactBelowPx: number | undefined,
  host: { readonly wide: boolean; readonly width: number },
): ViewLayout {
  return !host.wide || (compactBelowPx !== undefined && host.width < compactBelowPx)
    ? "compact"
    : "full";
}

const PersistedSideArea = Schema.Struct({
  open: Schema.Boolean,
  view: Schema.String,
  width: Schema.Finite,
  pinned: Schema.Boolean,
  locked: Schema.NullOr(ScopedThreadRef),
  threadView: Schema.optionalKey(Schema.String),
});

/** The tools sidebar's stored shape before it became the side area. */
const LegacyToolSidebar = Schema.Struct({
  visible: Schema.Boolean,
  activeTool: Schema.NullOr(Schema.Literals(["calendar", "status"])),
  width: Schema.Finite,
});

export interface SideAreaState {
  readonly open: boolean;
  readonly view: ViewId;
  readonly width: number;
  /** Stays open through thread switches and outside clicks; the content still follows. */
  readonly pinned: boolean;
  /** Holds thread views on this thread instead of the selected one. */
  readonly locked: ScopedThreadRef | null;
  readonly maximized: boolean;
  /** The last thread view shown, which the thread views shortcut opens. */
  readonly threadView: ThreadViewId;
  /** A thread a view was opened for while navigating to it; arriving there keeps it open. */
  readonly arrival: ScopedThreadRef | null;
}

export const INITIAL_SIDE_AREA: SideAreaState = {
  open: false,
  view: "details",
  width: 300,
  pinned: false,
  locked: null,
  maximized: false,
  threadView: "details",
  arrival: null,
};

/** The route's thread and the thread the side area follows there, such as a focused side chat. */
export interface SideAreaContext {
  readonly route: ScopedThreadRef | null;
  readonly selected: ScopedThreadRef | null;
}

export type SideAreaAction =
  | { type: "toggle" }
  /**
   * Opens on `view`. With `thread`, the request is about that thread: `lock` holds the view on it,
   * and otherwise a lock on another thread is released so the view follows the selection.
   */
  | {
      type: "show";
      view: ViewId;
      thread?: ScopedThreadRef;
      /** Set while navigating to `thread`, so arriving there keeps the view open. */
      arriving?: boolean;
      /** Where the request was made: the route's thread and the thread the panel follows there. */
      context?: SideAreaContext;
    }
  /** The route moved to another thread: closes unless pinned or this is an awaited arrival. */
  | { type: "routeChanged"; context: SideAreaContext }
  /** Opens on the last thread view, or closes when a thread view is showing. */
  | { type: "toggleThreadViews" }
  /** Opens on `view` for `thread`, or closes when it already shows that. */
  | { type: "toggleView"; view: ViewId; thread: ScopedThreadRef }
  | { type: "close" }
  /** An outside click, Escape outside the side area or a thread switch: closes unless pinned. */
  | { type: "dismiss" }
  | { type: "pin" }
  | { type: "lock"; thread: ScopedThreadRef | null }
  | { type: "maximize" }
  | { type: "restore" }
  | { type: "resize"; width: number };

/** At and above this width the side area sits beside content; below it, it is a full sheet. */
export const SIDE_AREA_WIDE_MEDIA_QUERY = "(min-width: 981px)";

export const SIDE_AREA_MIN_WIDTH = 280;
export const SIDE_AREA_MAX_WIDTH = 640;
// The content keeps at least this much visible beside a side area at its stored width.
const SIDE_AREA_CONTENT_RESERVE = 320;

function clampSideAreaWidth(width: number) {
  return Number.isFinite(width)
    ? Math.min(SIDE_AREA_MAX_WIDTH, Math.max(SIDE_AREA_MIN_WIDTH, width))
    : INITIAL_SIDE_AREA.width;
}

export function resolveSideAreaWidth(width: number, availableWidth: number) {
  return Math.min(width, Math.max(SIDE_AREA_MIN_WIDTH, availableWidth - SIDE_AREA_CONTENT_RESERVE));
}

const decodePersistedSideArea = Schema.decodeUnknownOption(PersistedSideArea);
const decodeLegacyToolSidebar = Schema.decodeUnknownOption(LegacyToolSidebar);

/** Reads stored state, including the tools sidebar's older shape; anything else starts fresh. */
export function restoreSideArea(value: unknown): SideAreaState {
  const current = decodePersistedSideArea(value);
  if (current._tag === "Some") {
    const { open, width, pinned, locked } = current.value;
    const view = migrateViewId(current.value.view);
    if (view === null) return INITIAL_SIDE_AREA;
    const threadView = migrateViewId(current.value.threadView);
    return {
      open,
      view,
      width: clampSideAreaWidth(width),
      pinned,
      locked,
      maximized: false,
      arrival: null,
      threadView:
        threadView !== null && isThreadViewId(threadView)
          ? threadView
          : isThreadViewId(view)
            ? view
            : INITIAL_SIDE_AREA.threadView,
    };
  }
  const legacy = decodeLegacyToolSidebar(value);
  if (legacy._tag === "Some") {
    const { visible, activeTool, width } = legacy.value;
    return {
      ...INITIAL_SIDE_AREA,
      // A visible strip with no page open becomes an open panel on Status, the strip's live tool.
      open: visible,
      view: activeTool ?? (visible ? "status" : INITIAL_SIDE_AREA.view),
      width: clampSideAreaWidth(width),
    };
  }
  return INITIAL_SIDE_AREA;
}

/**
 * The current view for a view id stored by any earlier version: the left rail's views, the
 * retired right panel's and the side panel's own. Null for anything else.
 */
export function migrateViewId(value: unknown): ViewId | null {
  if (typeof value !== "string") return null;
  switch (value) {
    case "marks":
    case "ticket":
      return "links";
    case "context":
      return "inspect";
    default:
      return isViewId(value) ? value : null;
  }
}

/** The left rail's stored selection: the view it showed and the last tool it remembered. */
export interface RetiredRailSelection {
  readonly view?: unknown;
  readonly lastTool?: unknown;
}

/**
 * Carries the left rail's stored selection into a side area restored from an older version: a
 * view the rail showed opens here unless the side area was already open, and its last thread view
 * becomes the one the thread views shortcut opens.
 */
export function adoptRetiredRail(state: SideAreaState, rail: RetiredRailSelection): SideAreaState {
  const shown = migrateViewId(rail.view);
  const last = migrateViewId(rail.lastTool);
  const threadView =
    shown !== null && isThreadViewId(shown)
      ? shown
      : last !== null && isThreadViewId(last)
        ? last
        : state.threadView;
  if (shown === null || state.open) return { ...state, threadView };
  return { ...state, open: true, view: shown, threadView };
}

function sameThread(a: ScopedThreadRef | null, b: ScopedThreadRef | null) {
  return a?.environmentId === b?.environmentId && a?.threadId === b?.threadId;
}

/**
 * The lock that shows `thread`: none when the side area already follows it, otherwise `thread`
 * itself, so the header names the thread a view was opened for.
 */
function targetFor(thread: ScopedThreadRef, selected: ScopedThreadRef | null) {
  return sameThread(selected, thread) ? null : thread;
}

function withView(state: SideAreaState, view: ViewId): SideAreaState {
  return { ...state, view, threadView: isThreadViewId(view) ? view : state.threadView };
}

export function transitionSideArea(state: SideAreaState, action: SideAreaAction): SideAreaState {
  switch (action.type) {
    case "toggle":
      return { ...state, open: !state.open, maximized: false };
    case "show": {
      const opened = { ...withView(state, action.view), open: true };
      const { thread, context } = action;
      if (thread === undefined) return opened;
      // Navigating there: the target is settled on arrival, against the thread followed there.
      if (action.arriving && !sameThread(context?.route ?? null, thread)) {
        return { ...opened, arrival: thread };
      }
      return { ...opened, locked: targetFor(thread, context?.selected ?? null), arrival: null };
    }
    case "routeChanged": {
      const { arrival } = state;
      if (arrival !== null && sameThread(arrival, action.context.route)) {
        return { ...state, locked: targetFor(arrival, action.context.selected), arrival: null };
      }
      const left = { ...state, arrival: null };
      return state.pinned ? left : { ...left, open: false, maximized: false };
    }
    case "toggleThreadViews":
      return state.open && isThreadViewId(state.view)
        ? { ...state, open: false, maximized: false }
        : { ...state, open: true, view: state.threadView };
    case "toggleView":
      if (
        state.open &&
        state.view === action.view &&
        (state.locked === null || sameThread(state.locked, action.thread))
      ) {
        return { ...state, open: false, maximized: false };
      }
      return {
        ...withView(state, action.view),
        open: true,
        locked: sameThread(state.locked, action.thread) ? state.locked : null,
      };
    case "close":
      return { ...state, open: false, maximized: false };
    case "dismiss":
      return state.pinned ? state : { ...state, open: false, maximized: false };
    case "pin":
      return { ...state, pinned: !state.pinned };
    case "lock":
      return { ...state, locked: action.thread };
    case "maximize":
      return state.open ? { ...state, maximized: !state.maximized } : state;
    case "restore":
      return { ...state, maximized: false };
    case "resize":
      return { ...state, width: clampSideAreaWidth(action.width) };
  }
}

/** The thread the side area's thread views show: the locked one, else the selected one. */
export function resolveSideAreaThread(
  locked: ScopedThreadRef | null,
  selected: ScopedThreadRef | null,
): ScopedThreadRef | null {
  return locked ?? selected;
}

/** A host showing a Details view, and the element the details card can move into. */
export interface DetailsHost<Element> {
  readonly threadRef: ScopedThreadRef;
  readonly element: Element;
}

/**
 * Where the conversation's details card renders. Only the selected thread's conversation has a
 * card, so the first host showing that thread gets it; with none showing it, the first host does.
 * `hosts` is in priority order; other hosts show the summary.
 */
export function resolveDetailsDestination<Element>(
  hosts: ReadonlyArray<DetailsHost<Element> | null>,
  selected: ScopedThreadRef | null,
): DetailsHost<Element> | null {
  const present = hosts.filter((host): host is DetailsHost<Element> => host !== null);
  return present.find((host) => sameThread(host.threadRef, selected)) ?? present[0] ?? null;
}

export type LockedThreadState =
  | { readonly kind: "named"; readonly title: string; readonly archived: boolean }
  | { readonly kind: "deleted" }
  | { readonly kind: "loading" };

/** What the side area says about its locked thread, from its shell or else its own detail read. */
export function describeLockedThread(input: {
  readonly shellTitle: string | null;
  readonly detail: {
    readonly status: string;
    readonly title: string | null;
    readonly archived: boolean;
  } | null;
}): LockedThreadState {
  if (input.shellTitle !== null) return { kind: "named", title: input.shellTitle, archived: false };
  if (input.detail?.status === "deleted") return { kind: "deleted" };
  if (input.detail?.title) {
    return { kind: "named", title: input.detail.title, archived: input.detail.archived };
  }
  return { kind: "loading" };
}
