import { holdScrollTarget } from "~/lib/holdScrollTarget";

export function holdLinkedNodeInView(
  node: HTMLElement,
  scroller: HTMLElement,
  offset: () => number,
): () => void {
  const stop = holdScrollTarget(node, scroller, offset);
  // Activity can load after the click; by then the user may be typing elsewhere.
  const active = document.activeElement;
  if (
    !(active instanceof HTMLElement) ||
    !(active.isContentEditable || active.matches("input, textarea, select"))
  ) {
    node.focus({ preventScroll: true });
  }
  return stop;
}
