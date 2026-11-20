export type SelectionActionPoint = { x: number; y: number };

export const SELECTION_MULTI_CLICK_INTERVAL_MS = 500;
const SELECTION_SCROLL_SETTLE_MS = 150;

type Box = { left: number; top: number; right: number; bottom: number };
type Size = { width: number; height: number };
export type SelectionMenuPlacement = SelectionActionPoint & { orientation: "column" | "row" };

const SELECTION_MENU_GAP = 6;
const SELECTION_MENU_EDGE = 8;

/**
 * Keeps the selected text readable: a column in the margin beside the text when it fits,
 * otherwise a row above the first selected line, or below the last when there is no room above.
 */
export function resolveSelectionMenuPlacement(options: {
  firstLine: Box;
  lastLine: Box;
  textColumn: Pick<Box, "right">;
  bounds: Box;
  viewport: Size;
  columnSize: Size;
  rowSize: Size;
}): SelectionMenuPlacement {
  const { firstLine, lastLine, textColumn, bounds, viewport, columnSize, rowSize } = options;
  const right = Math.min(bounds.right, viewport.width) - SELECTION_MENU_EDGE;
  const clampY = (y: number, height: number) =>
    Math.max(
      Math.max(bounds.top, SELECTION_MENU_EDGE),
      Math.min(y, Math.min(bounds.bottom, viewport.height) - SELECTION_MENU_EDGE - height),
    );
  const marginX = textColumn.right + SELECTION_MENU_GAP * 2;
  if (marginX + columnSize.width <= right) {
    return { orientation: "column", x: marginX, y: clampY(firstLine.top, columnSize.height) };
  }
  const above = firstLine.top - SELECTION_MENU_GAP - rowSize.height;
  const top = Math.max(bounds.top, SELECTION_MENU_EDGE);
  return {
    orientation: "row",
    x: Math.max(SELECTION_MENU_EDGE, Math.min(firstLine.left, right - rowSize.width)),
    y: above >= top ? above : clampY(lastLine.bottom + SELECTION_MENU_GAP, rowSize.height),
  };
}

type SelectionRect = { left: number; top: number; right: number; bottom: number };

export function isSelectionRectVisible(rect: SelectionRect, clips: readonly SelectionRect[]) {
  let { left, top, right, bottom } = rect;
  for (const clip of clips) {
    left = Math.max(left, clip.left);
    top = Math.max(top, clip.top);
    right = Math.min(right, clip.right);
    bottom = Math.min(bottom, clip.bottom);
  }
  return right > left && bottom > top;
}

/**
 * Interactive popovers pass getActionElement to keep editing their fields from replacing the
 * captured source selection.
 */
export function observeSelectionActions({
  element,
  scrollAncestor,
  getActionElement,
  restoreAfterScroll = false,
  onSelection,
  onDismiss,
}: {
  element: HTMLElement;
  scrollAncestor?: HTMLElement | null;
  getActionElement?: () => HTMLElement | null;
  restoreAfterScroll?: boolean;
  onSelection: (pointer: SelectionActionPoint | null) => void;
  onDismiss: (reason: "interaction" | "cancel") => void;
}) {
  const document = element.ownerDocument;
  const view = document.defaultView!;
  let pointerDown = false;
  let gestureActive = false;
  let dismissed = false;
  let restorable = false;
  let pointer: SelectionActionPoint | null = null;
  let timer: number | null = null;
  let frame: number | null = null;

  const isActionTarget = (target: EventTarget | null) =>
    target !== null && (getActionElement?.()?.contains(target as Node) ?? false);

  const cancelPending = () => {
    if (timer !== null) view.clearTimeout(timer);
    if (frame !== null) view.cancelAnimationFrame(frame);
    timer = frame = null;
  };
  const cancel = () => {
    cancelPending();
    pointerDown = gestureActive = false;
    pointer = null;
    dismissed = true;
    restorable = false;
  };
  const dismiss = () => {
    cancel();
    onDismiss("cancel");
  };
  const onContextMenu = () => {
    cancel();
    onDismiss("interaction");
  };
  const schedule = (delay: number) => {
    restorable = true;
    cancelPending();
    timer = view.setTimeout(() => {
      timer = null;
      frame = view.requestAnimationFrame(() => {
        frame = null;
        onSelection(pointer);
      });
    }, delay);
  };
  const onPointerDown = (event: PointerEvent) => {
    if (!event.isPrimary) return;
    if (isActionTarget(event.target)) {
      cancel();
      return;
    }
    cancelPending();
    pointerDown = event.button === 0;
    const inside = element.contains(event.target as Node);
    gestureActive = false;
    dismissed = true;
    restorable = false;
    pointer = null;
    if (inside) onDismiss("interaction");
    else if (getActionElement?.()) onDismiss("cancel");
  };
  const onSelectionStart = (event: PointerEvent) => {
    if (!event.isPrimary) return;
    const target = event.target as Element | null;
    if (target?.closest("button, [role=button]")) return;
    gestureActive = event.button === 0 && !event.defaultPrevented;
    dismissed = !gestureActive;
  };
  const onPointerUp = (event: PointerEvent) => {
    // Preventing pointerdown (for example on a toolbar) can suppress mouseup.
    if (event.isPrimary && event.button === 0) pointerDown = false;
  };
  const onMouseUp = (event: MouseEvent) => {
    if (event.button !== 0) return;
    pointerDown = false;
    if (!gestureActive) return;
    gestureActive = false;
    pointer = { x: event.clientX, y: event.clientY };
    schedule(event.detail >= 2 ? SELECTION_MULTI_CLICK_INTERVAL_MS : 0);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (isActionTarget(event.target) && event.key !== "Escape") return;
    if (event.key === "Escape") {
      dismiss();
    } else if (!pointerDown) {
      cancelPending();
      gestureActive = false;
      pointer = null;
      dismissed = false;
    }
  };
  const onFocusIn = (event: FocusEvent) => {
    if (isActionTarget(event.target)) cancel();
    else if (!pointerDown && getActionElement?.()) dismiss();
  };
  const onScroll = () => {
    cancelPending();
    // Autoscroll during a drag must not cancel that gesture's eventual release.
    if (!pointerDown) {
      pointer = null;
      if (restoreAfterScroll && !dismissed && restorable) schedule(SELECTION_SCROLL_SETTLE_MS);
      else dismissed = true;
    }
    onDismiss("cancel");
  };

  document.addEventListener("pointerdown", onPointerDown, true);
  element.addEventListener("pointerdown", onSelectionStart);
  view.addEventListener("pointerup", onPointerUp);
  view.addEventListener("mouseup", onMouseUp);
  view.addEventListener("pointercancel", dismiss);
  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("focusin", onFocusIn);
  element.addEventListener("contextmenu", onContextMenu, true);
  element.addEventListener("scroll", onScroll, true);
  scrollAncestor?.addEventListener("scroll", onScroll);
  view.addEventListener("blur", dismiss);
  view.addEventListener("resize", dismiss);

  return {
    get pending() {
      return timer !== null || frame !== null;
    },
    cancel,
    selectionChanged() {
      if (isActionTarget(document.activeElement)) return;
      if (pointerDown || gestureActive) {
        onDismiss("cancel");
      } else if (!dismissed && timer === null && frame === null) {
        schedule(0);
      }
    },
    dispose() {
      cancel();
      document.removeEventListener("pointerdown", onPointerDown, true);
      element.removeEventListener("pointerdown", onSelectionStart);
      view.removeEventListener("pointerup", onPointerUp);
      view.removeEventListener("mouseup", onMouseUp);
      view.removeEventListener("pointercancel", dismiss);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", onFocusIn);
      element.removeEventListener("contextmenu", onContextMenu, true);
      element.removeEventListener("scroll", onScroll, true);
      scrollAncestor?.removeEventListener("scroll", onScroll);
      view.removeEventListener("blur", dismiss);
      view.removeEventListener("resize", dismiss);
    },
  };
}
