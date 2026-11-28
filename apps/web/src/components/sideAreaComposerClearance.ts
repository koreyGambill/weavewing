import { observeResize } from "../lib/observeResize";

const COMPOSER = "[data-chat-composer-stack]";
const CLEARANCE = "--side-area-composer-clearance";
const GAP_PX = 8;

/** Leave room for the composer controls wherever the floating panel crosses a chat tile. */
export function observeSideAreaComposerClearance(panel: HTMLElement): () => void {
  const workspace = panel.closest("[data-tool-sidebar-layout]");
  if (!workspace) return () => {};

  let stopResize: (() => void) | undefined;
  const watchComposers = () => {
    stopResize?.();
    const composers = [...workspace.querySelectorAll(COMPOSER)];
    const measure = () => {
      const { bottom } = workspace.getBoundingClientRect();
      const { left, top, right } = panel.getBoundingClientRect();
      let clearance = 0;
      for (const composer of composers) {
        if (!composer.checkVisibility({ checkVisibilityCSS: true })) continue;
        const bounds = composer.getBoundingClientRect();
        if (bounds.right <= left || bounds.left >= right || bounds.bottom <= top) continue;
        clearance = Math.max(clearance, bottom - Math.max(top, bounds.top - GAP_PX));
      }
      panel.style.setProperty(CLEARANCE, `${Math.ceil(clearance)}px`);
    };
    measure();
    stopResize = observeResize([workspace, panel, ...composers], measure);
  };
  watchComposers();
  const observer = new MutationObserver((records) => {
    const changed = records.some((record) =>
      [...record.addedNodes, ...record.removedNodes].some(
        (node) =>
          node instanceof Element && (node.matches(COMPOSER) || node.querySelector(COMPOSER)),
      ),
    );
    if (changed) watchComposers();
  });
  observer.observe(workspace, { childList: true, subtree: true });
  return () => {
    observer.disconnect();
    stopResize?.();
    panel.style.removeProperty(CLEARANCE);
  };
}
