import { observeResize } from "./observeResize";

const USER_SCROLL_INTENT = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

/**
 * Keeps a linked node `offset()` below the scroller's top while the content around it opens and
 * its data loads, until input in the scroller, the node leaves, or the returned stop runs. Only the
 * scroller moves; scrollIntoView would also scroll the panel's clipped ancestors.
 */
export function holdScrollTarget(
  node: HTMLElement,
  scroller: HTMLElement,
  offset: () => number,
): () => void {
  const controller = new AbortController();
  const stop = () => {
    unobserve();
    controller.abort();
  };
  const align = () => {
    if (!node.isConnected) return stop();
    scroller.scrollTop +=
      node.getBoundingClientRect().top - scroller.getBoundingClientRect().top - offset();
  };
  const unobserve = observeResize([...scroller.children], align);
  for (const type of USER_SCROLL_INTENT) {
    scroller.addEventListener(type, stop, {
      capture: true,
      passive: true,
      signal: controller.signal,
    });
  }
  align();
  return stop;
}
