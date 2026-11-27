import { ScopedThreadRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { THREAD_TOOL_ORDER } from "../threadContextSidebar";
import type { ThreadContextSection } from "../threadContextSidebarStore";

/** Every view the side area can show: the thread views, then the views that span threads. */
export type ViewId = Exclude<ThreadContextSection, "inbox"> | "calendar" | "status";

const GLOBAL_VIEW_IDS = ["calendar", "status"] as const satisfies ReadonlyArray<ViewId>;

/** The view picker's order: thread views as the rail lists them, then global views. */
export const VIEW_IDS: ReadonlyArray<ViewId> = [
  ...THREAD_TOOL_ORDER.filter((id): id is Exclude<ThreadContextSection, "inbox"> => id !== "inbox"),
  ...GLOBAL_VIEW_IDS,
];

function isViewId(value: string): value is ViewId {
  return VIEW_IDS.some((id) => id === value);
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
});

/** The tools sidebar's stored shape before it became the side area. */
const LegacyToolSidebar = Schema.Struct({
  visible: Schema.Boolean,
  activeTool: Schema.NullOr(Schema.Literals(GLOBAL_VIEW_IDS)),
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
}

export const INITIAL_SIDE_AREA: SideAreaState = {
  open: false,
  view: "details",
  width: 300,
  pinned: false,
  locked: null,
  maximized: false,
};

export type SideAreaAction =
  | { type: "toggle" }
  | { type: "show"; view: ViewId }
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
    const { open, view, width, pinned, locked } = current.value;
    return isViewId(view)
      ? { open, view, width: clampSideAreaWidth(width), pinned, locked, maximized: false }
      : INITIAL_SIDE_AREA;
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

function sameThread(a: ScopedThreadRef | null, b: ScopedThreadRef | null) {
  return a?.environmentId === b?.environmentId && a?.threadId === b?.threadId;
}

export function transitionSideArea(state: SideAreaState, action: SideAreaAction): SideAreaState {
  switch (action.type) {
    case "toggle":
      return { ...state, open: !state.open, maximized: false };
    case "show":
      return { ...state, open: true, view: action.view };
    case "toggleView":
      if (
        state.open &&
        state.view === action.view &&
        (state.locked === null || sameThread(state.locked, action.thread))
      ) {
        return { ...state, open: false, maximized: false };
      }
      return {
        ...state,
        open: true,
        view: action.view,
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

interface DetailsHost<Element> {
  readonly threadRef: ScopedThreadRef;
  readonly element: Element;
}

/**
 * Where the conversation's details card renders. Only the selected thread's conversation has a
 * card, so the host showing that thread gets it; the side area wins only when both show it.
 */
export function resolveDetailsDestination<Element>(input: {
  readonly side: DetailsHost<Element> | null;
  readonly rail: DetailsHost<Element> | null;
  readonly selected: ScopedThreadRef | null;
}): DetailsHost<Element> | null {
  const { side, rail, selected } = input;
  if (side && sameThread(side.threadRef, selected)) return side;
  if (rail && sameThread(rail.threadRef, selected)) return rail;
  return side ?? rail;
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
