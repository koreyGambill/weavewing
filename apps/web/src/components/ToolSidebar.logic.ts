import { ScopedThreadRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/** The views that show one thread, in the picker's order. */
const THREAD_VIEW_IDS = ["checklist", "artifacts", "links", "activity", "details"] as const;

/** The views that span threads, in the picker's order. */
const GLOBAL_VIEW_IDS = ["inbox", "evidence", "automations", "calendar", "status"] as const;

export type ThreadViewId = (typeof THREAD_VIEW_IDS)[number];
export type GlobalViewId = (typeof GLOBAL_VIEW_IDS)[number];
/** Every view the side area can show. */
export type ViewId = ThreadViewId | GlobalViewId;

/** The view picker's order: thread views, then the views that span threads. */
export const VIEW_IDS: ReadonlyArray<ViewId> = [...THREAD_VIEW_IDS, ...GLOBAL_VIEW_IDS];

export function isViewId(value: string): value is ViewId {
  return VIEW_IDS.some((id) => id === value);
}

function isThreadViewId(id: string): id is ThreadViewId {
  return THREAD_VIEW_IDS.some((entry) => entry === id);
}

export function isGlobalViewId(id: ViewId): id is GlobalViewId {
  return GLOBAL_VIEW_IDS.some((entry) => entry === id);
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
  hidden: Schema.optionalKey(Schema.Unknown),
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
  readonly hidden: ReadonlyArray<ViewId>;
  /** Holds thread views on this thread instead of the selected one. */
  readonly locked: ScopedThreadRef | null;
  readonly maximized: boolean;
  /** The last thread view shown, which the thread views shortcut opens. */
  readonly threadView: ThreadViewId;
  /** A destination the last thread view shortcut should reopen. */
  readonly threadSection: ViewSectionId | null;
  /** A section waiting to scroll into view. */
  readonly revealSection: ViewSectionId | null;
  /** A thread a view was opened for while navigating to it; arriving there keeps it open. */
  readonly arrival: ScopedThreadRef | null;
}

export const INITIAL_SIDE_AREA: SideAreaState = {
  open: false,
  view: "details",
  width: 300,
  pinned: false,
  hidden: [],
  locked: null,
  maximized: false,
  threadView: "details",
  threadSection: null,
  revealSection: null,
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
   * Opens on `view`. A request with `thread` follows that thread when it is already selected
   * and locks the panel to it otherwise.
   */
  | {
      type: "show";
      view: ViewId;
      section?: ViewSectionId;
      thread?: ScopedThreadRef;
      /** Set while navigating to `thread`, so arriving there keeps the view open. */
      arriving?: boolean;
      /** Where the request was made: the route's thread and the thread the panel follows there. */
      context?: SideAreaContext;
    }
  /** The route moved to another thread: closes unless pinned or this is an awaited arrival. */
  | { type: "routeChanged"; context: SideAreaContext }
  /** Opens on the last thread view, or closes when a thread view is showing. */
  | { type: "toggleThreadViews"; collapsedSections: ReadonlyArray<ViewSectionId> }
  /** Opens on `view` for `thread`, or closes when it already shows that. */
  | { type: "toggleView"; view: ViewId; thread: ScopedThreadRef }
  | { type: "close" }
  /** An outside click, Escape outside the side area or a thread switch: closes unless pinned. */
  | { type: "dismiss" }
  | { type: "setHidden"; view: ViewId; hidden: boolean }
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
    const shown = migrateViewTarget(current.value.view);
    if (shown === null) return INITIAL_SIDE_AREA;
    const { view } = shown;
    const remembered = migrateViewTarget(current.value.threadView);
    const last = remembered && isThreadViewId(remembered.view) ? remembered : shown;
    return {
      open,
      view,
      width: clampSideAreaWidth(width),
      pinned,
      locked,
      maximized: false,
      arrival: null,
      hidden: restoreHiddenViews(current.value.hidden),
      revealSection: shown.section ?? null,
      threadView: isThreadViewId(last.view) ? last.view : INITIAL_SIDE_AREA.threadView,
      threadSection: last.section ?? null,
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

/** Where each retired view went: the view that holds it now and, for a merged one, its section. */
const RETIRED_VIEWS: Partial<
  Record<string, { readonly view: ViewId; readonly section?: ViewSectionId }>
> = {
  todos: { view: "checklist" },
  related: { view: "links", section: "links:threads" },
  timeline: { view: "activity", section: "activity:runs" },
  environments: { view: "details", section: "details:environments" },
  inspect: { view: "details", section: "details:inspect" },
  // The retired right panel's views.
  marks: { view: "links", section: "links:links" },
  ticket: { view: "links", section: "links:links" },
  context: { view: "details", section: "details:inspect" },
};

/** A section of a merged view, named `<view>:<section>`. */
export type ViewSectionId =
  | "links:links"
  | "links:threads"
  | "activity:runs"
  | "activity:landings"
  | "details:thread"
  | "details:environments"
  | "details:inspect";

/**
 * The current view for a view id stored by any earlier version: the left rail's views, the
 * retired right panel's and the side panel's own, with the section that now holds a merged one.
 * Null for anything else.
 */
export function migrateViewTarget(
  value: unknown,
): { readonly view: ViewId; readonly section?: ViewSectionId } | null {
  if (typeof value !== "string") return null;
  const retired = Object.hasOwn(RETIRED_VIEWS, value) ? RETIRED_VIEWS[value] : undefined;
  return retired ?? (isViewId(value) ? { view: value } : null);
}

/**
 * The id to store for a view, so a build from before the five merged views reads it: Checklist
 * and Activity keep the ids of the views they replaced, and `migrateViewTarget` maps them back.
 */
export function storedViewId(view: ViewId, section: ViewSectionId | null = null): string {
  if (section) {
    const legacy = Object.entries(RETIRED_VIEWS).find(
      ([, target]) => target?.view === view && target.section === section,
    );
    if (legacy) return legacy[0];
  }
  switch (view) {
    case "checklist":
      return "todos";
    case "activity":
      return "timeline";
    default:
      return view;
  }
}

/** The current view for a view id stored by any earlier version, or null; see `migrateViewTarget`. */
export function migrateViewId(value: unknown): ViewId | null {
  return migrateViewTarget(value)?.view ?? null;
}

/** Hiding the final thread view would leave the picker without a thread destination. */
export function canHideView(view: ViewId, hidden: ReadonlyArray<ViewId>): boolean {
  return isGlobalViewId(view) || THREAD_VIEW_IDS.some((id) => id !== view && !hidden.includes(id));
}

function restoreHiddenViews(value: unknown): ReadonlyArray<ViewId> {
  if (!Array.isArray(value)) return [];
  const hidden = VIEW_IDS.filter((id) => value.includes(id));
  return THREAD_VIEW_IDS.every((id) => hidden.includes(id))
    ? hidden.filter((id) => id !== THREAD_VIEW_IDS[0])
    : hidden;
}

function migrateRailHidden(value: unknown): ReadonlyArray<ViewId> {
  if (!Array.isArray(value)) return [];
  const old = new Set(value);
  const mapped = new Set(value.map(migrateViewId));
  // An alias counts for its old view, and each member of a merged view must have been hidden.
  if (!(old.has("links") || old.has("marks") || old.has("ticket")) || !old.has("related")) {
    mapped.delete("links");
  }
  if (!old.has("timeline") || !old.has("evidence")) {
    mapped.delete("activity");
  }
  if (
    !old.has("details") ||
    !old.has("environments") ||
    !(old.has("inspect") || old.has("context"))
  ) {
    mapped.delete("details");
  }
  return restoreHiddenViews([...mapped]);
}

/** The left rail's stored selection: the view it showed and the last tool it remembered. */
export interface RetiredRailSelection {
  readonly view?: unknown;
  readonly lastTool?: unknown;
  readonly hidden?: unknown;
}

/**
 * Carries the left rail's stored selection into a side area restored from an older version: a
 * view the rail showed opens here unless the side area was already open, and its last thread view
 * becomes the one the thread views shortcut opens.
 */
export function adoptRetiredRail(state: SideAreaState, rail: RetiredRailSelection): SideAreaState {
  const shown = migrateViewTarget(rail.view);
  const last = shown && isThreadViewId(shown.view) ? shown : migrateViewTarget(rail.lastTool);
  const remembered =
    last && isThreadViewId(last.view)
      ? { threadView: last.view, threadSection: last.section ?? null }
      : {};
  const hidden = migrateRailHidden(rail.hidden);
  if (shown === null || state.open) return { ...state, ...remembered, hidden };
  return {
    ...state,
    ...remembered,
    hidden,
    open: true,
    view: shown.view,
    revealSection: shown.section ?? null,
  };
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

function withView(
  state: SideAreaState,
  view: ViewId,
  section: ViewSectionId | null = null,
): SideAreaState {
  return {
    ...state,
    view,
    revealSection: section,
    ...(isThreadViewId(view) ? { threadView: view, threadSection: section } : {}),
  };
}

export function transitionSideArea(state: SideAreaState, action: SideAreaAction): SideAreaState {
  switch (action.type) {
    case "toggle":
      return { ...state, open: !state.open, maximized: false };
    case "show": {
      const opened = { ...withView(state, action.view, action.section), open: true };
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
        : {
            ...state,
            open: true,
            view: state.threadView,
            revealSection:
              state.threadSection && !action.collapsedSections.includes(state.threadSection)
                ? state.threadSection
                : null,
          };
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
    case "setHidden": {
      const { view, hidden } = action;
      if (!hidden) return { ...state, hidden: state.hidden.filter((id) => id !== view) };
      if (state.hidden.includes(view) || !canHideView(view, state.hidden)) return state;
      const nextHidden = [...state.hidden, view];
      const fallback = THREAD_VIEW_IDS.find((id) => !nextHidden.includes(id)) ?? THREAD_VIEW_IDS[0];
      if (view === state.view) return { ...withView(state, fallback), hidden: nextHidden };
      return {
        ...state,
        hidden: nextHidden,
        ...(view === state.threadView ? { threadView: fallback, threadSection: null } : {}),
      };
    }
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

/** The hosts that can show a full Details card. */
export type DetailsHostKind = "tile" | "panel";

export interface DetailsDestination<Element> extends DetailsHost<Element> {
  readonly host: DetailsHostKind;
}

/**
 * Where the conversation's details card renders. Only the selected thread's conversation has a
 * card, so the first host showing that thread gets it.
 * `hosts` is in priority order; other hosts show the summary.
 */
export function resolveDetailsDestination<Element>(
  hosts: ReadonlyArray<DetailsDestination<Element> | null>,
  selected: ScopedThreadRef | null,
): DetailsDestination<Element> | null {
  return hosts.find((host) => host && sameThread(host.threadRef, selected)) ?? null;
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
