import { createContext, useContext, type ComponentProps } from "react";
import { createPortal } from "react-dom";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type { DetailsHostKind } from "../ToolSidebar.logic";
import { ThreadDetailsCard } from "./ThreadDetailsCard";

export const ThreadDetailsDestination = createContext<{
  threadRef: ScopedThreadRef;
  element: HTMLElement;
  host: DetailsHostKind;
} | null>(null);

export function ThreadDetailsLocation(props: ComponentProps<typeof ThreadDetailsCard>) {
  const destination = useContext(ThreadDetailsDestination);
  if (
    destination?.threadRef.environmentId === props.threadRef.environmentId &&
    destination.threadRef.threadId === props.threadRef.threadId
  ) {
    return createPortal(
      <div data-context-thread-details onContextMenu={props.onContextMenu}>
        {props.children("full")}
      </div>,
      destination.element,
    );
  }
  return <ThreadDetailsCard {...props} />;
}
