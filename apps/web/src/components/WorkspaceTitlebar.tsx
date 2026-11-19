import { createContext, useContext, useId, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { observeResize } from "../lib/observeResize";

export const WorkspaceTitlebarHost = createContext<HTMLElement | null>(null);
export const WorkspaceTitlebarControlsHost = createContext<HTMLElement | null>(null);

export function WorkspaceTitlebarControls({ children }: { children: ReactNode }) {
  const host = useContext(WorkspaceTitlebarControlsHost);
  return host ? createPortal(children, host) : null;
}

export function WorkspaceTitlebar({ children }: { children: ReactNode }) {
  const sourceId = useId();
  const host = useContext(WorkspaceTitlebarHost);
  const [bounds, setBounds] = useState({ left: 0, width: 0 });
  const [measure] = useState(() => (node: HTMLDivElement | null) => {
    if (!node) return;
    const update = () => {
      const layout = node.closest("[data-tool-sidebar-layout]");
      const left = node.getBoundingClientRect().left - (layout?.getBoundingClientRect().left ?? 0);
      setBounds({ left, width: node.clientWidth });
    };
    update();
    return observeResize(node, update);
  });

  if (!host) return children;

  // Keep panel geometry in place while the titlebar paints outside clipped page containers.
  return (
    <>
      <div
        id={sourceId}
        ref={measure}
        data-workspace-titlebar-placeholder
        className="h-[var(--workspace-topbar-height)] shrink-0"
      />
      {createPortal(
        <div data-workspace-focus-owner={sourceId} className="absolute top-0" style={bounds}>
          {children}
        </div>,
        host,
      )}
    </>
  );
}
